import { validateHeaderName, validateHeaderValue } from "node:http";
import {
  type CopilotEndpoint,
  type CopilotEndpointClient,
  type CopilotModelInfo,
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
export interface CopilotModelConfig {
  /** The Copilot model ID, exactly as `listModels()` reports it. */
  model: string;
  reasoning_effort?: CopilotReasoningEffort;
  response_format?: { type: "json_object" };
  /**
   * Output token limit for each reply. Defaults to the model's maximum output tokens from
   * Copilot's model list.
   */
  max_tokens?: number;
}

export interface CopilotModelOptions {
  id?: string;
  label?: string;
  config?: CopilotModelConfig & {
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

/**
 * `metadata.copilotEndpoint`: the Copilot API that served the reply, which fixes how its
 * `tokenUsage` counts tokens.
 */
export type CopilotModelEndpoint = "responses" | "chat/completions" | "messages";

/** The native Promptfoo provider that performs inference with discovered credentials. */
export interface NativeProvider extends Judge {
  cleanup?(): unknown;
}

/** @internal Seams that keep lifecycle tests free of the SDK and of model calls. */
export interface CopilotModelDependencies {
  createEndpointClient?: () => CopilotEndpointClient;
  loadProvider?: (id: string, context: { options: object }) => Promise<NativeProvider>;
  now?: () => number;
}

type ProviderReply = JudgeResponse & Record<string, unknown>;

interface Generation {
  provider: NativeProvider;
  endpoint: CopilotModelEndpoint;
  prices?: CopilotTokenPrices;
  maxOutputTokens?: number;
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
  max_tokens: true,
  basePath: true,
};

/** Validate authored config; anything that could redirect endpoint or authentication is rejected. */
export function copilotModelConfig(input: unknown): Readonly<CopilotModelConfig> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new Error("CopilotModel config must be an object.");
  const config = input as Record<string, unknown>;
  const unsupported = Object.keys(config).filter((key) => !Object.hasOwn(CONFIG_KEYS, key));
  if (unsupported.length)
    throw new Error(
      `CopilotModel does not accept config.${unsupported.join(", config.")}; the endpoint and credentials come from Copilot discovery.`,
    );
  const { model, reasoning_effort, response_format, max_tokens } = config;
  if (typeof model !== "string" || !model.trim() || model !== model.trim())
    throw new Error("CopilotModel requires an explicit config.model.");
  if (
    reasoning_effort !== undefined &&
    !EFFORTS.includes(reasoning_effort as CopilotReasoningEffort)
  )
    throw new Error(`CopilotModel config.reasoning_effort must be one of: ${EFFORTS.join(", ")}.`);
  if (
    response_format !== undefined &&
    (typeof response_format !== "object" ||
      response_format === null ||
      Object.keys(response_format).join() !== "type" ||
      !("type" in response_format) ||
      response_format.type !== "json_object")
  )
    throw new Error('CopilotModel config.response_format must be { type: "json_object" }.');
  if (max_tokens !== undefined && !positiveInteger(max_tokens))
    throw new Error("CopilotModel config.max_tokens must be a positive integer.");
  return Object.freeze({
    model,
    ...(reasoning_effort === undefined
      ? {}
      : { reasoning_effort: reasoning_effort as CopilotReasoningEffort }),
    ...(response_format === undefined
      ? {}
      : { response_format: Object.freeze({ type: "json_object" as const }) }),
    ...(max_tokens === undefined ? {} : { max_tokens: max_tokens as number }),
  });
}

const describe = (value: unknown) => (typeof value === "string" ? JSON.stringify(value) : "none");

const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/**
 * The model's maximum output tokens from Copilot's model list
 * (`capabilities.limits.max_output_tokens`), when reported.
 */
function modelOutputLimit(models: unknown, model: string): number | undefined {
  if (!Array.isArray(models)) return undefined;
  const entry = (models as CopilotModelInfo[]).find((candidate) => candidate?.id === model);
  const limits = entry?.capabilities?.limits as { max_output_tokens?: unknown } | undefined;
  const limit = limits && typeof limits === "object" ? limits.max_output_tokens : undefined;
  return positiveInteger(limit) ? limit : undefined;
}

/** The Copilot API a discovery snapshot describes; anything but the three HTTP APIs is rejected. */
function endpointOf(snapshot: CopilotEndpoint, model: string): CopilotModelEndpoint {
  const { type, wireApi, transport } = (snapshot ?? {}) as Partial<CopilotEndpoint>;
  let endpoint: CopilotModelEndpoint | undefined;
  if (transport === undefined || transport === "http") {
    if (type === "openai" && (wireApi === undefined || wireApi === "responses"))
      endpoint = "responses";
    else if (type === "openai" && wireApi === "completions") endpoint = "chat/completions";
    else if (type === "anthropic" && wireApi === undefined) endpoint = "messages";
  }
  if (!endpoint)
    throw new Error(
      `Copilot serves ${model} over an unsupported API (type ${describe(type)}, wireApi ${describe(wireApi)}, transport ${describe(transport)}); CopilotModel supports OpenAI Responses, OpenAI Chat Completions and Anthropic Messages over HTTP.`,
    );
  return endpoint;
}

interface Connection {
  endpoint: CopilotModelEndpoint;
  headers: Record<string, string>;
  refreshAt: number;
}

/** Validate a discovery snapshot and build its request headers and refresh deadline. */
function connection(snapshot: CopilotEndpoint, model: string, now: () => number): Connection {
  const endpoint = endpointOf(snapshot, model);
  if (
    typeof snapshot.baseUrl !== "string" ||
    !snapshot.baseUrl ||
    (snapshot.apiKey !== undefined && (typeof snapshot.apiKey !== "string" || !snapshot.apiKey)) ||
    !snapshot.headers ||
    typeof snapshot.headers !== "object" ||
    Array.isArray(snapshot.headers)
  )
    throw new Error("Copilot discovery returned an unsupported endpoint.");
  if (endpoint === "messages") {
    // Promptfoo's Anthropic provider falls back to ANTHROPIC_API_KEY without a key, and
    // the Anthropic SDK appends `/v1/messages` to the base URL as a string.
    if (snapshot.apiKey === undefined)
      throw new Error("Copilot discovery returned no credential for the Messages endpoint.");
    let url: URL | undefined;
    try {
      url = new URL(snapshot.baseUrl);
    } catch {
      // Reported below.
    }
    if (!url || url.search || url.hash)
      throw new Error("Copilot discovery returned an unsupported Messages endpoint.");
  }
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
  // The OpenAI targets send the key as a bearer token; Messages gets the same one.
  if (endpoint === "messages" && !headers.has("authorization"))
    addHeader("Authorization", `Bearer ${snapshot.apiKey}`);
  return { endpoint, headers: Object.fromEntries(headers.values()), refreshAt };
}

/**
 * Promptfoo's Anthropic config for a reasoning effort: adaptive thinking at that effort,
 * applied only when Copilot's model list says the model takes the effort.
 */
function anthropicReasoning(
  models: unknown,
  model: string,
  effort: CopilotReasoningEffort,
): { thinking: { type: "adaptive" }; effort: CopilotReasoningEffort } {
  if (!Array.isArray(models))
    throw new Error(
      `CopilotModel cannot apply config.reasoning_effort to ${model}: Copilot's model list is unavailable, so its reasoning support is unknown.`,
    );
  const entry = (models as CopilotModelInfo[]).find((candidate) => candidate?.id === model);
  if (entry?.capabilities?.supports?.reasoningEffort !== true)
    throw new Error(
      `CopilotModel config.reasoning_effort is not supported for ${model}: Copilot's model list does not report reasoning effort support for it.`,
    );
  const supported = entry.supportedReasoningEfforts;
  if (Array.isArray(supported) && !supported.includes(effort))
    throw new Error(
      `CopilotModel config.reasoning_effort ${effort} is not supported for ${model}; Copilot reports: ${supported.filter((value) => typeof value === "string").join(", ")}.`,
    );
  return { thinking: { type: "adaptive" }, effort };
}

/**
 * The Promptfoo provider id and options that send `config` to the discovered endpoint.
 * `maxOutputTokens` replaces Promptfoo's default output cap and ambient `*_MAX_TOKENS`;
 * without it Promptfoo's default stands. Temperature is never sent: Promptfoo defaults it
 * to 0 (or ambient `*_TEMPERATURE`), which some models reject, so an `undefined` override
 * that is spread last drops the key from the request body.
 */
function nativeProvider(
  config: Readonly<CopilotModelConfig>,
  snapshot: CopilotEndpoint,
  { endpoint, headers }: Connection,
  models: unknown,
  maxOutputTokens: number | undefined,
): { id: string; options: object } {
  const noTemperature = { temperature: undefined };
  const { model, reasoning_effort, response_format } = config;
  if (endpoint === "messages") {
    if (response_format !== undefined)
      throw new Error(
        `CopilotModel config.response_format is not supported for ${model}: Copilot serves it over the Anthropic Messages API, which has no JSON-object mode.`,
      );
    const hasApiKeyHeader = Object.keys(headers).some((name) => name.toLowerCase() === "x-api-key");
    return {
      id: `anthropic:messages:${model}`,
      options: {
        config: {
          ...(reasoning_effort === undefined
            ? {}
            : anthropicReasoning(models, model, reasoning_effort)),
          ...(maxOutputTokens === undefined ? {} : { max_tokens: maxOutputTokens }),
          // The Anthropic SDK refuses non-streaming requests whose max_tokens implies more
          // than ten minutes; a model's full output limit does.
          stream: true,
          extra_body: noTemperature,
          // Only the answer: thinking text would precede a judge's JSON verdict.
          showThinking: false,
          apiBaseUrl: snapshot.baseUrl,
          // Keeps Promptfoo off ANTHROPIC_API_KEY; Copilot authenticates with the
          // Authorization header, so the SDK's `X-Api-Key` copy is removed.
          apiKey: snapshot.apiKey,
          headers: hasApiKeyHeader ? headers : { ...headers, "x-api-key": null },
        },
        // A defined value makes Promptfoo null out ambient ANTHROPIC_CUSTOM_HEADERS,
        // which the Anthropic SDK would otherwise send to Copilot.
        env: { ANTHROPIC_CUSTOM_HEADERS: "" },
      },
    };
  }
  const openai = {
    ...(response_format === undefined ? {} : { response_format }),
    apiBaseUrl: snapshot.baseUrl,
    apiKey: snapshot.apiKey,
    apiKeyRequired: snapshot.apiKey !== undefined,
    useDefaultApiKey: false,
    headers,
  };
  if (endpoint === "chat/completions")
    return {
      id: `openai:chat:${model}`,
      options: {
        config: {
          // Promptfoo sends reasoning_effort on Chat Completions only for model names it
          // knows reason; the passthrough puts it on the wire for every model.
          ...(reasoning_effort === undefined ? {} : { reasoning_effort }),
          // Promptfoo caps reasoning models with max_completion_tokens, others with max_tokens.
          ...(maxOutputTokens === undefined
            ? {}
            : { max_tokens: maxOutputTokens, max_completion_tokens: maxOutputTokens }),
          passthrough: {
            ...(reasoning_effort === undefined ? {} : { reasoning_effort }),
            ...noTemperature,
          },
          ...openai,
        },
      },
    };
  return {
    id: `openai:responses:${model}`,
    options: {
      config: {
        ...(reasoning_effort === undefined ? {} : { reasoning_effort }),
        ...(maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }),
        passthrough: noTemperature,
        store: false,
        ...openai,
      },
    },
  };
}

/**
 * Copilot's reported per-batch prices for the model. They ride on every reply so cost
 * reporting prices tokens at the live rate, not a copied table. Numeric fields only.
 */
function tokenPrices(models: unknown, model: string): CopilotTokenPrices | undefined {
  const prices = Array.isArray(models)
    ? (models as CopilotModelInfo[]).find((entry) => entry?.id === model)?.billing?.tokenPrices
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

const tokenCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/**
 * Promptfoo reports Responses prompt-cache reads only when they are non-zero; the raw
 * usage has the reported count, zero included.
 */
function cacheReads(reply: ProviderReply, endpoint: CopilotModelEndpoint): ProviderReply {
  const usage = reply.tokenUsage;
  if (endpoint !== "responses" || reply.cached || !usage || typeof usage !== "object") return reply;
  const details = (usage.completionDetails ?? {}) as Record<string, unknown>;
  const raw = reply.raw as { usage?: { input_tokens_details?: { cached_tokens?: unknown } } };
  const reads = tokenCount(raw?.usage?.input_tokens_details?.cached_tokens);
  if (reads === undefined || details.cacheReadInputTokens !== undefined) return reply;
  return {
    ...reply,
    tokenUsage: { ...usage, completionDetails: { ...details, cacheReadInputTokens: reads } },
  };
}

/**
 * Promptfoo's native providers price replies at OpenAI or Anthropic list rates, which is
 * not Copilot billing; the recorded Copilot token prices replace that cost. Every reply
 * names the API that served it.
 */
function copilotReply(response: unknown, generation: Generation): unknown {
  if (!response || typeof response !== "object") return response;
  const { cost: _listPrice, ...reply } = response as ProviderReply;
  return cacheReads(
    {
      ...reply,
      metadata: {
        ...reply.metadata,
        copilotEndpoint: generation.endpoint,
        ...(generation.prices ? { copilotTokenPrices: generation.prices } : {}),
        ...(generation.maxOutputTokens === undefined
          ? {}
          : { copilotMaxOutputTokens: generation.maxOutputTokens }),
      },
    },
    generation.endpoint,
  );
}

const loadNativeProvider = async (
  id: string,
  context: { options: object },
): Promise<NativeProvider> => (await promptfooLoader())(id, context);

/**
 * @internal Build a provider class over one SDK worker and native-provider cache. Every
 * instance of the returned class shares them; config cannot replace authentication or
 * the native transport.
 */
export function createCopilotModel({
  createEndpointClient = () => createCopilotEndpointClient(),
  loadProvider = loadNativeProvider,
  now = Date.now,
}: CopilotModelDependencies = {}): CopilotModelConstructor {
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
  const load = async (config: Readonly<CopilotModelConfig>): Promise<Generation> => {
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
    const route = connection(snapshot, config.model, now);
    let models: unknown;
    try {
      models = await owner.models();
    } catch {
      // Without the model list, prices go unreported and settings that need it fail.
    }
    const maxOutputTokens = config.max_tokens ?? modelOutputLimit(models, config.model);
    const { id, options } = nativeProvider(config, snapshot, route, models, maxOutputTokens);
    const { endpoint, refreshAt } = route;
    const prices = tokenPrices(models, config.model);
    const provider = await loadProvider(id, { options });
    // Promptfoo's OpenAI providers send ambient OPENAI_ORGANIZATION as `OpenAI-Organization`
    // unless a header overrides it, and config cannot unset it; Copilot's headers decide.
    const organization = provider as { getOrganization?: unknown };
    if (endpoint !== "messages" && typeof organization.getOrganization === "function")
      organization.getOrganization = () => undefined;
    const generation: Generation = {
      provider,
      endpoint,
      prices,
      maxOutputTokens,
      refreshAt,
      active: 0,
      retired: false,
    };
    if (now() >= refreshAt) {
      await dispose(generation);
      throw new Error("Copilot session credential expired during provider initialization.");
    }
    return generation;
  };
  const native = async (config: Readonly<CopilotModelConfig>): Promise<Generation> => {
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

  return class implements CopilotModel {
    readonly #config: Readonly<CopilotModelConfig>;
    #closed = false;
    #cleanup: Promise<void> | undefined;

    constructor(options: CopilotModelOptions = {}) {
      if (closing) throw new Error("Copilot provider cleanup is in progress.");
      this.#config = copilotModelConfig(options.config ?? {});
      owners++;
    }

    get config(): Readonly<CopilotModelConfig> {
      return this.#config;
    }

    id(): string {
      return `copilot:${this.#config.model}`;
    }

    toJSON(): { id: string; config: Readonly<CopilotModelConfig> } {
      return { id: this.id(), config: this.#config };
    }

    callApi(prompt: string, context?: object, options?: object): Promise<ProviderReply> {
      if (this.#closed) return Promise.reject(new Error("Copilot provider is closed."));
      const request = (async () => {
        const generation = await native(this.#config);
        try {
          return copilotReply(
            await generation.provider.callApi(prompt, context, options),
            generation,
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
 * A Promptfoo provider for direct Copilot inference. GH_TOKEN authenticates a private
 * Copilot SDK worker that discovers the model's endpoint and short-lived credentials;
 * Promptfoo's native provider for the API Copilot serves the model on
 * (`openai:responses`, `openai:chat` or `anthropic:messages`) then runs the request.
 * Replies carry Copilot's reported token prices and endpoint instead of a list-price
 * `cost`. Every instance in a process shares one SDK worker.
 */
export interface CopilotModel {
  readonly config: Readonly<CopilotModelConfig>;
  /** `copilot:<model>`, whichever API serves the model. */
  id(): string;
  /** The provider's id and request settings; never credentials. */
  toJSON(): { id: string; config: Readonly<CopilotModelConfig> };
  callApi(prompt: string, context?: object, options?: object): Promise<ProviderReply>;
  /** Release this instance; the last one stops the shared SDK worker. */
  cleanup(): Promise<void>;
}

export interface CopilotModelConstructor {
  new (options?: CopilotModelOptions): CopilotModel;
}

// One SDK worker per process, shared by every instance and by the ESM and CJS builds.
const sharedKey = Symbol.for("oh-my-promptfoo.CopilotModel");
const shared = globalThis as typeof globalThis & {
  [sharedKey]?: CopilotModelConstructor;
};
export const CopilotModel: CopilotModelConstructor = shared[sharedKey] ?? createCopilotModel();
shared[sharedKey] = CopilotModel;
