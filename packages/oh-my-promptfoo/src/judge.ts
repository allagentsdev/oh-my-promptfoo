import { dirname, sep } from "node:path";
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

type Peer = { load: LoadApiProvider; installRoot: string };

let peer: Promise<Peer> | undefined;

/**
 * The project a Promptfoo peer at `entry` is installed in: the parent of the outermost
 * `node_modules` on its path, so pnpm's `node_modules/.pnpm/…/node_modules` store still
 * names the project that installed it.
 */
export function installRoot(entry: string): string {
  const parts = entry.split(sep);
  const index = parts.indexOf("node_modules");
  if (index < 1) throw new Error(`The Promptfoo peer ${entry} is not installed in node_modules`);
  const root = parts.slice(0, index).join(sep);
  return index === 1 ? root + sep : root;
}

function promptfooPeer(): Promise<Peer> {
  peer ??= (async () => {
    const here =
      typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));
    // The peer is the evaluation project's Promptfoo, located at run time with its
    // import conditions; a static import would bind whichever copy the bundler saw.
    const entry = resolvePeer(here, "promptfoo");
    const module = await import(pathToFileURL(entry).href);
    const load = module.loadApiProvider ?? module.default?.loadApiProvider;
    if (typeof load !== "function")
      throw new Error("The consumer Promptfoo peer does not export loadApiProvider");
    const typed: LoadApiProvider = load;
    return { load: typed, installRoot: installRoot(entry) };
  })().catch((error) => {
    peer = undefined;
    throw error;
  });
  return peer;
}

/**
 * Promptfoo's public `loadApiProvider`, from the consumer's installed peer, the way the
 * delegate runner loads providers. Promptfoo's grader resolution is internal, so this is
 * the supported way to construct a provider from a grading config.
 */
export async function promptfooLoader(): Promise<LoadApiProvider> {
  return (await promptfooPeer()).load;
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
 *
 * Ids resolve from `context.basePath`, else from the project the Promptfoo peer is
 * installed in. Promptfoo's grader passes its eval base path (`cliState.basePath`), but
 * the CLI keeps that state in its own bundle: the library entry loaded here holds a
 * separate, unset copy, and its `loadApiProvider` would fall back to `process.cwd()`.
 */
export async function loadJudge(
  spec: unknown,
  context: { basePath?: string; env?: object } = {},
): Promise<Judge> {
  if (Array.isArray(spec)) throw new Error(JUDGE_LIST_ERROR);
  if (isJudge(spec)) return spec;
  const load = async (id: string, options?: object) => {
    const promptfoo = await promptfooPeer();
    return promptfoo.load(id, {
      basePath: context.basePath || promptfoo.installRoot,
      ...(context.env ? { env: context.env } : {}),
      ...(options ? { options } : {}),
    });
  };
  if (typeof spec === "string" && spec.trim()) return load(spec);
  if (typeof spec === "object" && spec !== null) {
    if ("id" in spec && typeof spec.id === "string" && spec.id.trim()) return load(spec.id, spec);
    if ("text" in spec && spec.text !== undefined) return loadJudge(spec.text, context);
  }
  throw new Error(
    `A judge must be a provider id, a provider object with an id, or a { text: … } map; received ${JSON.stringify(spec) ?? String(spec)}`,
  );
}

/**
 * The name a result uses for a judge: its label when it has one, as Promptfoo shows it.
 * The loaded provider's label comes first, because Promptfoo renders `{{ env.* }}` in it.
 */
export function judgeName(spec: unknown, judge: Judge): string {
  if (judge.label) return judge.label;
  if (
    typeof spec === "object" &&
    spec !== null &&
    !isJudge(spec) &&
    "label" in spec &&
    typeof spec.label === "string" &&
    spec.label
  )
    return spec.label;
  return judge.id();
}
