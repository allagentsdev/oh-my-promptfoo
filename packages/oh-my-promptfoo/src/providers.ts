import { isJudge, type Judge, type JudgeResponse, judgeName, loadJudge } from "./judge.js";

export interface FallbackProviderConfig {
  /** Judges to try in order: provider ids, provider objects, or `{ text: … }` maps. */
  providers: unknown[];
  /** How long a judge that failed retryably is skipped by later calls; default 30000. */
  cooldownMs?: number;
  /** Set by Promptfoo to the eval config's directory when it loads this provider. */
  basePath?: string;
}

export interface FallbackAttempt {
  provider: string;
  status?: number;
  error?: string;
  cached: boolean;
  latencyMs: number;
}

interface FallbackProviderOptions {
  id?: string;
  label?: string;
  config?: FallbackProviderConfig;
  env?: Record<string, string>;
}

const DEFAULT_COOLDOWN_MS = 30_000;

// Promptfoo loads a grading provider afresh for each grading call, so a judge's cooldown
// has to outlive any one instance. Shared across the ESM and CJS builds too.
const cooldownKey = Symbol.for("oh-my-promptfoo.FallbackProvider.cooldowns");
const shared = globalThis as typeof globalThis & { [key: symbol]: Map<string, number> | undefined };
const cooldowns = shared[cooldownKey] ?? new Map<string, number>();
shared[cooldownKey] = cooldowns;

// Promptfoo's scheduler and fetch layer treat these messages as transient or rate
// limited when a provider attaches no HTTP status (scheduler/retryPolicy.ts,
// scheduler/types.ts and util/fetch/errors.ts in 0.124.0).
const TRANSIENT =
  /timeout|timed out|econnrefused|econnreset|socket hang up|eproto|bad record mac|network|\b50[234]\b|\b429\b|rate limit|too many requests|quota exceeded:/i;

function httpStatus(response: JudgeResponse): number | undefined {
  const http = response.metadata?.http;
  if (typeof http !== "object" || http === null || !("status" in http)) return undefined;
  return typeof http.status === "number" ? http.status : undefined;
}

/** 408, 429, 5xx and status 0 (network or timeout), else Promptfoo's transient patterns. */
function retryable(response: JudgeResponse): boolean {
  const status = httpStatus(response);
  if (status !== undefined)
    return status === 0 || status === 408 || status === 429 || (status >= 500 && status < 600);
  return TRANSIENT.test(response.error ?? "");
}

/** `Retry-After` from the response headers, or the "retry after Ns" Promptfoo writes. */
function retryAfterMs(response: JudgeResponse): number | undefined {
  const metadata = response.metadata;
  const http = metadata?.http;
  const headers =
    typeof http === "object" && http !== null && "headers" in http
      ? http.headers
      : metadata?.headers;
  if (typeof headers === "object" && headers !== null) {
    const lower = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]),
    );
    const ms = Number(lower["retry-after-ms"]);
    if (lower["retry-after-ms"] !== undefined && Number.isFinite(ms) && ms >= 0) return ms;
    const after = lower["retry-after"];
    if (after !== undefined) {
      const seconds = Number(after);
      if (after.trim() && Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
      const date = Date.parse(after);
      if (Number.isFinite(date)) return Math.max(0, date - Date.now());
    }
  }
  const match = response.error?.match(/\bretry after (\d+)\b/i);
  return match ? Number(match[1]) * 1000 : undefined;
}

function judgeKey(spec: unknown): string {
  if (isJudge(spec)) return `instance:${spec.id()}`;
  return JSON.stringify(spec);
}

/**
 * A Promptfoo provider that tries several judges in order and moves to the next only
 * after a retryable failure: HTTP 408, 429, 5xx, status 0, or a transient error message.
 * Any other reply, good or bad, is returned as it is. Each judge is called once and keeps
 * its own retries; `handlesOwnRetries` stops Promptfoo's scheduler re-running the chain.
 */
export class FallbackProvider {
  readonly handlesOwnRetries = true;
  label?: string;
  private readonly options: FallbackProviderOptions;
  private readonly providers: unknown[];
  private readonly cooldownMs: number;
  private readonly loaded = new Map<number, Promise<Judge>>();

  constructor(options: FallbackProviderOptions = {}) {
    this.options = options;
    this.label = options.label;
    const config = options.config;
    if (!Array.isArray(config?.providers) || config.providers.length === 0)
      throw new Error("FallbackProvider requires config.providers, a nonempty list of judges");
    this.providers = config.providers;
    this.cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    if (!Number.isSafeInteger(this.cooldownMs) || this.cooldownMs < 0)
      throw new Error("FallbackProvider config.cooldownMs must be a nonnegative integer");
  }

  id(): string {
    return this.options.id ?? "package:oh-my-promptfoo/providers:FallbackProvider";
  }

  private judge(index: number): Promise<Judge> {
    let judge = this.loaded.get(index);
    if (!judge) {
      // Relative file:// judges resolve against the eval config Promptfoo named here.
      judge = loadJudge(this.providers[index], {
        basePath: this.options.config?.basePath,
        env: this.options.env,
      });
      this.loaded.set(index, judge);
    }
    return judge;
  }

  async callApi(prompt: string, context?: object, callOptions?: object): Promise<JudgeResponse> {
    const now = Date.now();
    const judges = this.providers.map((spec, index) => ({ spec, index, key: judgeKey(spec) }));
    let order = judges.filter(({ key }) => (cooldowns.get(key) ?? 0) <= now);
    // Every judge cooling down: try the one that recovers first rather than make no call.
    if (order.length === 0)
      order = [
        judges.reduce((first, next) =>
          (cooldowns.get(next.key) ?? 0) < (cooldowns.get(first.key) ?? 0) ? next : first,
        ),
      ];
    const attempts: FallbackAttempt[] = [];
    const usage = { total: 0, prompt: 0, completion: 0, cached: 0, numRequests: 0 };
    let cost: number | undefined;
    for (const { spec, index, key } of order) {
      const judge = await this.judge(index);
      const name = judgeName(spec, judge);
      const started = performance.now();
      let response: JudgeResponse;
      try {
        response = await judge.callApi(prompt, context, callOptions);
      } catch (error) {
        // A judge that throws is misconfigured (no key, unknown id) unless the throw is
        // itself a transient transport failure.
        const message = error instanceof Error ? error.message : String(error);
        if (!TRANSIENT.test(message)) throw error;
        response = { error: message };
      }
      const tokens = response.tokenUsage ?? {};
      for (const field of ["total", "prompt", "completion", "cached"] as const) {
        const value = tokens[field];
        if (typeof value === "number" && Number.isFinite(value)) usage[field] += value;
      }
      usage.numRequests +=
        typeof tokens.numRequests === "number" ? tokens.numRequests : response.cached ? 0 : 1;
      if (typeof response.cost === "number" && Number.isFinite(response.cost))
        cost = (cost ?? 0) + response.cost;
      const status = httpStatus(response);
      attempts.push({
        provider: name,
        ...(status === undefined ? {} : { status }),
        ...(response.error ? { error: response.error } : {}),
        cached: response.cached === true,
        latencyMs: Math.round(performance.now() - started),
      });
      if (response.error && retryable(response)) {
        const coolFor = Math.max(this.cooldownMs, retryAfterMs(response) ?? 0);
        if (coolFor > 0) cooldowns.set(key, Date.now() + coolFor);
        continue;
      }
      if (!response.error) cooldowns.delete(key);
      return {
        ...response,
        tokenUsage: usage,
        ...(cost === undefined ? {} : { cost }),
        metadata: { ...response.metadata, fallback: { answeredBy: name, attempts } },
      };
    }
    const skipped = judges.length - attempts.length;
    return {
      error: `All ${attempts.length} judges failed${skipped ? ` (${skipped} skipped while cooling down)` : ""}: ${attempts
        .map(({ provider, error }) => `${provider}: ${error}`)
        .join("; ")}`,
      tokenUsage: usage,
      ...(cost === undefined ? {} : { cost }),
      metadata: { fallback: { attempts } },
    };
  }
}
