import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { isJudge, type Judge, type JudgeResponse, judgeName, loadJudge } from "./judge.js";
import {
  JudgeAccountingCollector,
  JudgeFailureContext,
  judgeFailureMessage,
  preserveJudgeFailure,
} from "./judge-accounting.js";

export {
  type CopilotEndpoint,
  type CopilotEndpointClient,
  type CopilotEndpointClientOptions,
  type CopilotModel,
  type CopilotSessionToken,
  createCopilotEndpointClient,
} from "./copilot-endpoint.js";
export {
  type CopilotReasoningEffort,
  type CopilotResponsesConfig,
  CopilotResponsesProvider,
  type CopilotResponsesProviderConstructor,
  type CopilotResponsesProviderOptions,
  type CopilotTokenPrices,
  type CopilotTokenPriceTier,
} from "./copilot-responses.js";

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
// has to outlive any one instance. Shared across the ESM and CJS builds too, along with
// the identities given to live provider instances.
interface SharedState {
  cooldowns: Map<string, number>;
  instances: WeakMap<object, string>;
  nextInstance: number;
}
const stateKey = Symbol.for("oh-my-promptfoo.FallbackProvider.state");
const shared = globalThis as typeof globalThis & { [key: symbol]: SharedState | undefined };
const state: SharedState = shared[stateKey] ?? {
  cooldowns: new Map(),
  instances: new WeakMap(),
  nextInstance: 0,
};
shared[stateKey] = state;
const { cooldowns } = state;

// Promptfoo 0.124.0's transient-connection check (util/fetch/errors.ts
// isTransientConnectionError): EPROTO is permanent when paired with these TLS phrases.
const PERMANENT_EPROTO = /wrong version number|self signed|unable to verify|unknown ca|cert/;

/**
 * Whether an error is one Promptfoo treats as transient or rate limited, for a provider
 * that gives no HTTP status: its connection check (codes ECONNRESET and EPIPE; bad record
 * mac, EPROTO unless permanent, ECONNRESET, socket hang up), its scheduler's retry
 * strings (timeout, ECONNREFUSED, network, 502/503/504; scheduler/retryPolicy.ts) and its
 * rate-limit strings (429, rate limit, too many requests; scheduler/types.ts). A quota
 * message counts too, as a 429 does: the next judge is usually a different account.
 */
function transient(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "ECONNRESET" || code === "EPIPE") return true;
  const message = (
    error instanceof Error ? error.message : typeof error === "string" ? error : ""
  ).toLowerCase();
  if (message.includes("eproto") && PERMANENT_EPROTO.test(message)) return false;
  return /bad record mac|eproto|econnreset|socket hang up|timeout|timed out|econnrefused|network|\b50[234]\b|\b429\b|rate limit|too many requests|quota exceeded:/.test(
    message,
  );
}

function httpStatus(response: JudgeResponse): number | undefined {
  const http = response.metadata?.http;
  if (typeof http !== "object" || http === null || !("status" in http)) return undefined;
  return typeof http.status === "number" ? http.status : undefined;
}

/** Synthetic permanent failures keep their disposition across nested fallback providers. */
function permanentError(response: JudgeResponse): boolean {
  const fallback = response.metadata?.fallback;
  return (
    typeof fallback === "object" &&
    fallback !== null &&
    "permanentError" in fallback &&
    fallback.permanentError === true
  );
}

/** 408, 429, 5xx and status 0 (network or timeout), else Promptfoo's transient patterns. */
function retryable(response: JudgeResponse): boolean {
  if (permanentError(response)) return false;
  const status = httpStatus(response);
  if (status !== undefined)
    return status === 0 || status === 408 || status === 429 || (status >= 500 && status < 600);
  return transient(response.error ?? "");
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

/**
 * The identity a judge's cooldown is kept under. A live instance is its own identity; a
 * `{ text: … }` map is the judge it names; any other spec is a fingerprint of everything
 * that decides which judge loads: the spec, its environment and the base path relative
 * references resolve against. The same id under another account, or the same relative
 * `file://` judge in another suite, cools separately.
 */
function judgeKey(
  spec: unknown,
  load: { basePath?: string; env?: Record<string, string> },
): string {
  if (isJudge(spec)) {
    let key = state.instances.get(spec);
    if (!key) {
      key = `instance:${++state.nextInstance}`;
      state.instances.set(spec, key);
    }
    return key;
  }
  if (
    typeof spec === "object" &&
    spec !== null &&
    !("id" in spec && typeof spec.id === "string") &&
    "text" in spec &&
    spec.text !== undefined
  )
    return judgeKey(spec.text, load);
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        spec,
        env: load.env ?? null,
        basePath: load.basePath ? resolve(load.basePath) : null,
      }),
    )
    .digest("hex");
  return `spec:${fingerprint}`;
}

function abortSignal(options: object | undefined): AbortSignal | undefined {
  if (!options || !("abortSignal" in options)) return undefined;
  return options.abortSignal instanceof AbortSignal ? options.abortSignal : undefined;
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
    // A cancelled evaluation is not a judge failure: never fail over past it.
    const signal = abortSignal(callOptions);
    signal?.throwIfAborted();
    const now = Date.now();
    const judges = this.providers.map((spec, index) => ({
      spec,
      index,
      key: judgeKey(spec, { basePath: this.options.config?.basePath, env: this.options.env }),
    }));
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
    const accounting = new JudgeAccountingCollector();
    let lastMetadata: JudgeResponse["metadata"];
    for (const { spec, index, key } of order) {
      signal?.throwIfAborted();
      let name = "unloaded judge";
      if (typeof spec === "string") name = spec;
      else if (typeof spec === "object" && spec !== null) {
        if ("label" in spec && typeof spec.label === "string") name = spec.label;
        else if ("id" in spec && typeof spec.id === "string") name = spec.id;
      }
      let loaded = false;
      const started = performance.now();
      let response: JudgeResponse;
      // A transient throw was classified on the error itself, code included.
      let threwTransient = false;
      let threwPermanent = false;
      let propagation: { error: unknown } | undefined;
      const failureContext = new JudgeFailureContext();
      try {
        const judge = await this.judge(index);
        loaded = true;
        name = judgeName(spec, judge);
        response = await failureContext.run(() => judge.callApi(prompt, context, callOptions));
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof Error && error.name === "AbortError") throw error;
        const evidence = failureContext.forError(error);
        // Evidence is published only by a nested fallback's permanent throw. Do not
        // reclassify it by message or replace its executed leaves with one attempt.
        threwTransient = loaded && evidence === undefined && transient(error);
        if (!threwTransient) {
          threwPermanent = true;
          if (!accounting.hasCopilotAccounting) propagation = { error };
        }
        response = {
          ...(propagation ? {} : { error: judgeFailureMessage(error) }),
          ...(evidence
            ? { tokenUsage: evidence.usage, metadata: { judgeAccounting: evidence.ledger } }
            : {}),
        };
      }
      const tokens = response.tokenUsage ?? {};
      for (const field of ["total", "prompt", "completion", "cached"] as const) {
        const value = tokens[field];
        if (typeof value === "number" && Number.isFinite(value)) usage[field] += value;
      }
      usage.numRequests +=
        typeof tokens.numRequests === "number" ? tokens.numRequests : response.cached ? 0 : 1;
      accounting.record(response.metadata, response.cached, response.cost);
      if (propagation) {
        // Native-only calls still throw the exact value, including frozen objects
        // and primitives; an enclosing accounted call can retain their evidence.
        preserveJudgeFailure({ error: propagation.error, ledger: accounting.ledger, usage });
        throw propagation.error;
      }
      if (threwPermanent) {
        // The previous reply's transport status is not the throwing attempt's status.
        const { http: _http, ...diagnostics } = lastMetadata ?? {};
        lastMetadata = diagnostics;
      } else {
        lastMetadata = response.metadata;
      }
      const status = httpStatus(response);
      attempts.push({
        provider: name,
        ...(status === undefined ? {} : { status }),
        ...(response.error ? { error: response.error } : {}),
        cached: response.cached === true,
        latencyMs: Math.round(performance.now() - started),
      });
      if (!threwPermanent && (threwTransient || (response.error && retryable(response)))) {
        // A failure caused by the caller's cancellation neither cools the judge nor moves on.
        signal?.throwIfAborted();
        const coolFor = Math.max(this.cooldownMs, retryAfterMs(response) ?? 0);
        if (coolFor > 0) cooldowns.set(key, Date.now() + coolFor);
        continue;
      }
      if (!response.error) cooldowns.delete(key);
      const { cost: _responseCost, ...reply } = response;
      const cost = accounting.cost;
      return {
        ...reply,
        cached: accounting.ledger.attempts.every((leaf) => leaf.cached),
        tokenUsage: usage,
        ...(cost === undefined ? {} : { cost }),
        metadata: {
          ...lastMetadata,
          judgeAccounting: accounting.ledger,
          fallback: {
            answeredBy: name,
            attempts,
            ...(threwPermanent || permanentError(response) ? { permanentError: true } : {}),
          },
        },
      };
    }
    const skipped = judges.length - attempts.length;
    const cost = accounting.cost;
    return {
      error: `All ${attempts.length} judges failed${skipped ? ` (${skipped} skipped while cooling down)` : ""}: ${attempts
        .map(({ provider, error }) => `${provider}: ${error}`)
        .join("; ")}`,
      tokenUsage: usage,
      ...(cost === undefined ? {} : { cost }),
      metadata: { ...lastMetadata, judgeAccounting: accounting.ledger, fallback: { attempts } },
    };
  }
}
