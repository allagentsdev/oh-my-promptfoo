import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolvePeer } from "./protocol.js";

/** The parts of a Promptfoo `ProviderResponse` a judge's caller reads. */
export interface JudgeResponse {
  output?: unknown;
  error?: string;
  tokenUsage?: Record<string, unknown>;
  cost?: number;
  cached?: boolean;
  metadata?: Record<string, unknown>;
}

/** A loaded Promptfoo `ApiProvider`, as far as grading needs one. */
export interface Judge {
  id(): string;
  label?: string;
  callApi(prompt: string, context?: object, options?: object): Promise<JudgeResponse>;
}

type LoadContext = { options?: object; basePath?: string; env?: object };
type LoadApiProvider = (providerPath: string, context?: LoadContext) => Promise<Judge>;

export const JUDGE_LIST_ERROR =
  "A list of judges is not a provider: to try judges in order, use package:oh-my-promptfoo/providers:FallbackProvider with config.providers";

let loader: Promise<LoadApiProvider> | undefined;

/**
 * Promptfoo's public `loadApiProvider`, from the consumer's installed peer, the way the
 * delegate runner loads providers. Promptfoo's grader resolution is internal, so this is
 * the supported way to construct a provider from a grading config.
 */
function promptfooLoader(): Promise<LoadApiProvider> {
  loader ??= (async () => {
    const here =
      typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));
    // The peer is the evaluation project's Promptfoo, located at run time with its
    // import conditions; a static import would bind whichever copy the bundler saw.
    const peer = await import(pathToFileURL(resolvePeer(here, "promptfoo")).href);
    const load = peer.loadApiProvider ?? peer.default?.loadApiProvider;
    if (typeof load !== "function")
      throw new Error("The consumer Promptfoo peer does not export loadApiProvider");
    const typed: LoadApiProvider = load;
    return typed;
  })().catch((error) => {
    loader = undefined;
    throw error;
  });
  return loader;
}

export function isJudge(value: unknown): value is Judge {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "function" &&
    "callApi" in value &&
    typeof value.callApi === "function"
  );
}

/**
 * Turn a grading-provider value into a provider, unpacking the shapes Promptfoo's own
 * `getGradingProvider` accepts for a text grader: an id, `ProviderOptions` with an `id`,
 * an `ApiProvider` instance, or a `{ text: … }` map.
 */
export async function loadJudge(
  spec: unknown,
  context: { basePath?: string; env?: object } = {},
): Promise<Judge> {
  if (Array.isArray(spec)) throw new Error(JUDGE_LIST_ERROR);
  if (isJudge(spec)) return spec;
  const load: LoadContext = {
    ...(context.basePath ? { basePath: context.basePath } : {}),
    ...(context.env ? { env: context.env } : {}),
  };
  if (typeof spec === "string" && spec.trim()) return (await promptfooLoader())(spec, load);
  if (typeof spec === "object" && spec !== null) {
    if ("id" in spec && typeof spec.id === "string" && spec.id.trim())
      return (await promptfooLoader())(spec.id, { ...load, options: spec });
    if ("text" in spec && spec.text !== undefined) return loadJudge(spec.text, context);
  }
  throw new Error(
    `A judge must be a provider id, a provider object with an id, or a { text: … } map; received ${JSON.stringify(spec) ?? String(spec)}`,
  );
}

/** The name a result uses for a judge: its label when it has one, as Promptfoo shows it. */
export function judgeName(spec: unknown, judge: Judge): string {
  if (
    typeof spec === "object" &&
    spec !== null &&
    !isJudge(spec) &&
    "label" in spec &&
    typeof spec.label === "string" &&
    spec.label
  )
    return spec.label;
  return judge.label || judge.id();
}
