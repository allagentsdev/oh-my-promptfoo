import { validateHeaderName, validateHeaderValue } from "node:http";
import {
  type CopilotEndpoint,
  type CopilotEndpointClient,
  type CopilotModel,
  createCopilotEndpointClient,
} from "./copilot-endpoint.js";
import { type Judge, type JudgeResponse, promptfooLoader } from "./judge.js";

const REFRESH_MARGIN_MS = 5_000;
const EFFORTS = ["low", "medium", "high"] as const;
const PRICE_FIELDS = [
  "inputPrice",
  "cacheReadPrice",
  "cacheWritePrice",
  "outputPrice",
  "maxPromptTokens",
] as const;

export type CopilotReasoningEffort = (typeof EFFORTS)[number];

/** Request settings; endpoint and authentication always come from Copilot discovery. */
export interface CopilotResponsesConfig {
  /** The Copilot model ID, exactly as `listModels()` reports it. */
  model: string;
  reasoning_effort?: CopilotReasoningEffort;
  response_format?: { type: "json_object" };
}

export interface CopilotResponsesProviderOptions {
  id?: string;
  label?: string;
  config?: CopilotResponsesConfig & {
    /** Set by Promptfoo to the eval config's directory when it loads this provider. */
    basePath?: string;
  };
  env?: Record<string, string | undefined>;
}

/** One pricing tier of Copilot's reported per-batch token prices. */
export interface CopilotTokenPriceTier {
  inputPrice?: number;
  cacheReadPrice?: number;
  cacheWritePrice?: number;
  outputPrice?: number;
  maxPromptTokens?: number;
}

/** `metadata.copilotTokenPrices`: the model's prices from the SDK model list, per `batchSize` tokens. */
export interface CopilotTokenPrices {
  model: string;
  batchSize?: number;
  default: CopilotTokenPriceTier;
  longContext?: CopilotTokenPriceTier;
}

/** The native Promptfoo provider that performs inference with discovered credentials. */
export interface NativeResponsesProvider extends Judge {
  cleanup?(): unknown;
}

/** @internal Seams that keep lifecycle tests free of the SDK and of model calls. */
export interface CopilotResponsesDependencies {
  createEndpointClient?: () => CopilotEndpointClient;
  loadProvider?: (id: string, context: { options: object }) => Promise<NativeResponsesProvider>;
  now?: () => number;
}

type ProviderReply = JudgeResponse & Record<string, unknown>;

interface Generation {
  provider: NativeResponsesProvider;
  prices?: CopilotTokenPrices;
  refreshAt: number;
  active: number;
  retired: boolean;
  cleanup?: Promise<unknown>;
}

interface Entry {
  current?: Generation;
  loading?: Promise<Generation>;
}

const CONFIG_KEYS: Record<string, true> = {
  model: true,
  reasoning_effort: true,
  response_format: true,
  basePath: true,
};

/** Validate authored config; anything that could redirect endpoint or authentication is rejected. */
export function copilotResponsesConfig(input: unknown): Readonly<CopilotResponsesConfig> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("CopilotResponsesProvider config must be an object.");
  const config = input as Record<string, unknown>;
  const unsupported = Object.keys(config).filter((key) => !Object.hasOwn(CONFIG_KEYS, key));
  if (unsupported.length)
    throw new Error(
      `CopilotResponsesProvider does not accept config.${unsupported.join(", config.")}; the endpoint and credentials come from Copilot discovery.`,
    );
  const { model, reasoning_effort, response_format } = config;
  if (typeof model !== "string" || !model.trim() || model !== model.trim())
    throw new Error("CopilotResponsesProvider requires an explicit config.model.");
  if (
    reasoning_effort !== undefined &&
    !EFFORTS.includes(reasoning_effort as CopilotReasoningEffort)
  )
    throw new Error(
      `CopilotResponsesProvider config.reasoning_effort must be one of: ${EFFORTS.join(", ")}.`,
    );
  if (
    response_format !== undefined &&
    (typeof response_format !== "object" ||
      response_format === null ||
      Object.keys(response_format).join() !== "type" ||
      !("type" in response_format) ||
      response_format.type !== "json_object")
  )
    throw new Error(
      'CopilotResponsesProvider config.response_format must be { type: "json_object" }.',
    );
  return Object.freeze({
    model,
    ...(reasoning_effort === undefined
      ? {}
      : { reasoning_effort: reasoning_effort as CopilotReasoningEffort }),
    ...(response_format === undefined
      ? {}
      : { response_format: Object.freeze({ type: "json_object" as const }) }),
  });
}

/** Validate a discovery snapshot and build its request headers and refresh deadline. */
function connection(
  snapshot: CopilotEndpoint,
  model: string,
  now: () => number,
): { headers: Record<string, string>; refreshAt: number } {
  if (
    snapshot?.type !== "openai" ||
    (snapshot.wireApi !== undefined && snapshot.wireApi !== "responses") ||
    (snapshot.transport !== undefined && snapshot.transport !== "http") ||
    typeof snapshot.baseUrl !== "string" ||
    !snapshot.baseUrl ||
    (snapshot.apiKey !== undefined && (typeof snapshot.apiKey !== "string" || !snapshot.apiKey)) ||
    !snapshot.headers ||
    typeof snapshot.headers !== "object" ||
    Array.isArray(snapshot.headers)
  )
    throw new Error("Copilot discovery returned an unsupported Responses endpoint.");
  const headers = new Map<string, [string, string]>();
  const addHeader = (name: string, value: unknown) => {
    try {
      validateHeaderName(name);
      if (typeof value !== "string") throw new Error();
      validateHeaderValue(name, value);
    } catch {
      throw new Error("Copilot discovery returned an invalid credential header.");
    }
    const previous = headers.get(name.toLowerCase());
    if (previous && previous[1] !== value)
      throw new Error("Copilot discovery returned conflicting credential headers.");
    if (!previous) headers.set(name.toLowerCase(), [name, value]);
  };
  for (const [name, value] of Object.entries(snapshot.headers))
    if (value !== undefined) addHeader(name, value);
  let refreshAt = Number.POSITIVE_INFINITY;
  const token = snapshot.sessionToken;
  if (token !== undefined) {
    if (
      !token ||
      typeof token.token !== "string" ||
      !token.token ||
      typeof token.header !== "string"
    )
      throw new Error("Copilot discovery returned an incomplete session credential.");
    if (token.model !== undefined && token.model !== model)
      throw new Error("Copilot session credential is bound to a different model.");
    addHeader(token.header, token.token);
    if (token.expiresAt !== undefined) {
      const expiresAt =
        typeof token.expiresAt === "string" ? Date.parse(token.expiresAt) : Number.NaN;
      if (!Number.isFinite(expiresAt))
        throw new Error("Copilot session credential has an invalid expiry.");
      refreshAt = expiresAt - REFRESH_MARGIN_MS;
      if (refreshAt <= now()) throw new Error("Copilot session credential expires too soon.");
    }
  }
  return { headers: Object.fromEntries(headers.values()), refreshAt };
}

/**
 * Copilot's reported per-batch prices for the model. They ride on every reply so cost
 * reporting prices tokens at the live rate, not a copied table. Numeric fields only.
 */
function tokenPrices(models: unknown, model: string): CopilotTokenPrices | undefined {
  const prices = Array.isArray(models)
    ? (models as CopilotModel[]).find((entry) => entry?.id === model)?.billing?.tokenPrices
    : undefined;
  if (!prices || typeof prices !== "object") return undefined;
  const tier = (value: unknown): CopilotTokenPriceTier | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const source = value as Record<string, unknown>;
    return Object.freeze(
      Object.fromEntries(
        PRICE_FIELDS.filter((key) => typeof source[key] === "number").map((key) => [
          key,
          source[key],
        ]),
      ),
    );
  };
  const longContext = tier(prices.longContext);
  return Object.freeze({
    model,
    ...(typeof prices.batchSize === "number" ? { batchSize: prices.batchSize } : {}),
    default: tier(prices)!,
    ...(longContext ? { longContext } : {}),
  });
}

/**
 * Promptfoo's native provider prices replies at OpenAI list rates, which is not Copilot
 * billing; the recorded Copilot token prices replace that cost.
 */
function copilotReply(response: unknown, prices: CopilotTokenPrices | undefined): unknown {
  if (!response || typeof response !== "object") return response;
  const { cost: _listPrice, ...reply } = response as ProviderReply;
  return prices ? { ...reply, metadata: { ...reply.metadata, copilotTokenPrices: prices } } : reply;
}

const loadNativeProvider = async (
  id: string,
  context: { options: object },
): Promise<NativeResponsesProvider> => (await promptfooLoader())(id, context);

/**
 * @internal Build a provider class over one SDK worker and native-provider cache. Every
 * instance of the returned class shares them; config cannot replace authentication or
 * the native transport.
 */
export function createCopilotResponsesProvider({
  createEndpointClient = () => createCopilotEndpointClient(),
  loadProvider = loadNativeProvider,
  now = Date.now,
}: CopilotResponsesDependencies = {}): CopilotResponsesProviderConstructor {
  let client: CopilotEndpointClient | undefined;
  let owners = 0;
  let closing: Promise<void> | undefined;
  const entries = new Map<string, Entry>();
  const calls = new Set<Promise<unknown>>();
  const dispose = (generation: Generation) => {
    generation.cleanup ??= Promise.resolve().then(() => generation.provider.cleanup?.());
    return generation.cleanup;
  };
  const acquire = (generation: Generation) => {
    generation.active++;
    return generation;
  };
  const load = async (config: Readonly<CopilotResponsesConfig>): Promise<Generation> => {
    client ??= createEndpointClient();
    const owner = client;
    let snapshot: CopilotEndpoint;
    try {
      snapshot = await owner.endpoint(config.model);
    } catch (error) {
      // A failed discovery shuts the SDK worker down. Drop that client so the next
      // request bootstraps a fresh one instead of failing for the rest of the run.
      if (client === owner) client = undefined;
      await owner.close().catch(() => {
        // The discovery error is the actionable one.
      });
      throw error;
    }
    const { headers, refreshAt } = connection(snapshot, config.model, now);
    let prices: CopilotTokenPrices | undefined;
    try {
      prices = tokenPrices(await owner.models(), config.model);
    } catch {
      // Prices only inform cost reporting; a missing model list leaves them unreported.
    }
    const provider = await loadProvider(`openai:responses:${config.model}`, {
      options: {
        config: {
          ...(config.reasoning_effort === undefined
            ? {}
            : { reasoning_effort: config.reasoning_effort }),
          ...(config.response_format === undefined
            ? {}
            : { response_format: config.response_format }),
          store: false,
          apiBaseUrl: snapshot.baseUrl,
          apiKey: snapshot.apiKey,
          apiKeyRequired: snapshot.apiKey !== undefined,
          useDefaultApiKey: false,
          headers,
        },
      },
    });
    const generation: Generation = { provider, prices, refreshAt, active: 0, retired: false };
    if (now() >= refreshAt) {
      await dispose(generation);
      throw new Error("Copilot session credential expired during provider initialization.");
    }
    return generation;
  };
  const native = async (config: Readonly<CopilotResponsesConfig>): Promise<Generation> => {
    // Each distinct request configuration owns its native provider; credentials are per model.
    const key = JSON.stringify(config);
    let entry = entries.get(key);
    if (!entry) {
      entry = {};
      entries.set(key, entry);
    }
    if (entry.loading) return acquire(await entry.loading);
    if (entry.current && now() < entry.current.refreshAt) return acquire(entry.current);
    const target = entry;
    target.loading = (async () => {
      const generation = await load(config);
      const previous = target.current;
      target.current = generation;
      if (previous) {
        previous.retired = true;
        if (!previous.active) await dispose(previous);
      }
      return generation;
    })();
    try {
      return acquire(await target.loading);
    } finally {
      target.loading = undefined;
    }
  };

  return class implements CopilotResponsesProvider {
    readonly #config: Readonly<CopilotResponsesConfig>;
    #closed = false;
    #cleanup: Promise<void> | undefined;

    constructor(options: CopilotResponsesProviderOptions = {}) {
      if (closing) throw new Error("Copilot provider cleanup is in progress.");
      this.#config = copilotResponsesConfig(options.config ?? {});
      owners++;
    }

    get config(): Readonly<CopilotResponsesConfig> {
      return this.#config;
    }

    id(): string {
      return `copilot:responses:${this.#config.model}`;
    }

    toJSON(): { id: string; config: Readonly<CopilotResponsesConfig> } {
      return { id: this.id(), config: this.#config };
    }

    callApi(prompt: string, context?: object, options?: object): Promise<ProviderReply> {
      if (this.#closed) return Promise.reject(new Error("Copilot provider is closed."));
      const request = (async () => {
        const generation = await native(this.#config);
        try {
          return copilotReply(
            await generation.provider.callApi(prompt, context, options),
            generation.prices,
          ) as ProviderReply;
        } finally {
          generation.active--;
          if (generation.retired && !generation.active) await dispose(generation);
        }
      })();
      calls.add(request);
      const settled = () => calls.delete(request);
      request.then(settled, settled);
      return request;
    }

    cleanup(): Promise<void> {
      if (this.#closed) return this.#cleanup!;
      this.#closed = true;
      owners--;
      if (owners) {
        this.#cleanup = Promise.resolve();
        return this.#cleanup;
      }
      this.#cleanup = closing = (async () => {
        try {
          await Promise.allSettled([...calls]);
          await Promise.all(
            [...entries.values()].map((entry) => entry.current && dispose(entry.current)),
          );
        } finally {
          try {
            await client?.close();
          } finally {
            client = undefined;
            entries.clear();
            closing = undefined;
          }
        }
      })();
      return this.#cleanup;
    }
  };
}

/**
 * A Promptfoo provider for Copilot inference over the Responses API. GH_TOKEN
 * authenticates a private Copilot SDK worker that discovers the model's endpoint and
 * short-lived credentials; Promptfoo's native `openai:responses` provider then runs the
 * request. Replies carry Copilot's reported token prices instead of an OpenAI list-price
 * `cost`. Every instance in a process shares one SDK worker.
 */
export interface CopilotResponsesProvider {
  readonly config: Readonly<CopilotResponsesConfig>;
  /** `copilot:responses:<model>`. */
  id(): string;
  /** The provider's id and request settings; never credentials. */
  toJSON(): { id: string; config: Readonly<CopilotResponsesConfig> };
  callApi(prompt: string, context?: object, options?: object): Promise<ProviderReply>;
  /** Release this instance; the last one stops the shared SDK worker. */
  cleanup(): Promise<void>;
}

export interface CopilotResponsesProviderConstructor {
  new (options?: CopilotResponsesProviderOptions): CopilotResponsesProvider;
}

// One SDK worker per process, shared by every instance and by the ESM and CJS builds.
const sharedKey = Symbol.for("oh-my-promptfoo.CopilotResponsesProvider");
const shared = globalThis as typeof globalThis & {
  [sharedKey]?: CopilotResponsesProviderConstructor;
};
export const CopilotResponsesProvider: CopilotResponsesProviderConstructor =
  shared[sharedKey] ?? createCopilotResponsesProvider();
shared[sharedKey] = CopilotResponsesProvider;
