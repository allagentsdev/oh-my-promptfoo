import { type ChildProcess, fork } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePeer } from "./protocol.js";

const DEADLINE_MS = 90_000;
const SHUTDOWN_DEADLINE_MS = 5_000;

/** A session credential the Copilot runtime issued for one model's Responses endpoint. */
export interface CopilotSessionToken {
  token: string;
  /** The request header that carries `token`. */
  header: string;
  /** The model the credential is bound to, when the runtime binds it. */
  model?: string;
  /** ISO 8601 expiry, when known. */
  expiresAt?: string;
}

/** The Responses endpoint snapshot `session.rpc.provider.getEndpoint` reports. */
export interface CopilotEndpoint {
  type: string;
  wireApi?: string;
  transport?: string;
  baseUrl: string;
  apiKey?: string;
  headers: Record<string, string | undefined>;
  sessionToken?: CopilotSessionToken;
  [key: string]: unknown;
}

/** A model entry from the SDK's `listModels()`, as far as this package reads it. */
export interface CopilotModelInfo {
  id: string;
  billing?: { tokenPrices?: Record<string, unknown> } & Record<string, unknown>;
  [key: string]: unknown;
}

/** A private Copilot SDK worker that discovers inference endpoints for `GH_TOKEN`. */
export interface CopilotEndpointClient {
  /** The Responses endpoint for `model`, or the runtime's default model when omitted. */
  endpoint(model?: string): Promise<CopilotEndpoint>;
  /** The SDK's model list, including Copilot's reported token prices. */
  models(): Promise<CopilotModelInfo[]>;
  /** Stop the worker and its runtime; idempotent. */
  close(): Promise<void>;
}

export interface CopilotEndpointClientOptions {
  /** The GitHub token to authenticate with; defaults to `process.env.GH_TOKEN`. */
  token?: string;
}

/**
 * The worker's environment: no preloads, alternate model providers or personal
 * credentials, and a private home so stored user logins are never consulted.
 */
export function isolatedEnvironment(
  home: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const name of Object.keys(env)) {
    if (
      /^(?:COPILOT_|GITHUB_(?:TOKEN$|AUTH_TOKEN$|API_TOKEN$|ENTERPRISE_TOKEN$|COPILOT_)|GH_|OPENAI_|AZURE_|ANTHROPIC_|CLAUDE_|BEDROCK_|AWS_|GOOGLE_|GEMINI_|VERTEX_|OLLAMA_|LITELLM_|S2STOKENS$|OTEL_|APPLICATIONINSIGHTS_|NODE_OPTIONS$|NODE_PATH$|PROMPTFOO_|ALLAGENTS_)/i.test(
        name,
      )
    )
      delete env[name];
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"),
    TMPDIR: join(home, "tmp"),
  };
}

/**
 * Start a private Copilot SDK worker for endpoint discovery. The token is handed to
 * the worker once and not retained; errors never carry SDK text, which may include
 * credentials. The worker holds the event loop open only while a request is pending.
 */
export function createCopilotEndpointClient(
  options: CopilotEndpointClientOptions = {},
): CopilotEndpointClient {
  const token = options.token === undefined ? process.env.GH_TOKEN : options.token;
  if (typeof token !== "string" || !token.trim() || /[\0\r\n]/.test(token))
    throw new Error("Copilot endpoint discovery requires an explicit GH_TOKEN.");
  if (process.platform === "win32")
    throw new Error("Copilot endpoint discovery is not supported on Windows.");
  const here = typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));
  // The SDK is a peer installed beside this package, located with its import conditions.
  const sdk = resolvePeer(here, "@github/copilot-sdk");
  return startCopilotEndpointClient(token, workerPath(here), sdk);
}

function workerPath(here: string): string {
  const built = join(here, "copilot-endpoint-worker.js");
  if (existsSync(built)) return built;
  // Tests run the source against entries their global setup bundled.
  const prebuilt = process.env.OH_MY_PROMPTFOO_TEST_ENTRIES;
  if (prebuilt && existsSync(join(here, "copilot-endpoint-worker.ts")))
    return join(prebuilt, "copilot-endpoint-worker.js");
  throw new Error("Copilot endpoint worker is missing; build or reinstall oh-my-promptfoo");
}

/** @internal The worker script and SDK entry are parameters so tests can substitute peers. */
export function startCopilotEndpointClient(
  token: string | undefined,
  worker: string,
  sdk: string,
): CopilotEndpointClient {
  const directory = mkdtempSync(join(tmpdir(), "copilot-endpoint-"));
  let child: ChildProcess;
  try {
    child = fork(worker, [], {
      cwd: directory,
      env: isolatedEnvironment(directory),
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      // The worker leads a process group that includes the SDK runtime it starts.
      detached: true,
      serialization: "advanced",
    });
  } catch {
    rmSync(directory, { recursive: true, force: true });
    throw new Error("Copilot endpoint worker could not start.");
  }
  type Pending = {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  let nextId = 0;
  let closed = false;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const pending = new Map<number, Pending>();
  const channel = child.channel as { ref?: () => void; unref?: () => void } | null | undefined;
  const updateRefs = () => {
    const method = pending.size || closing ? "ref" : "unref";
    child[method]();
    // Some runtimes' IPC channels lack ref/unref; the child handle still governs keep-alive.
    channel?.[method]?.();
  };
  const error = (message: string) => new Error(`Copilot endpoint ${message}.`);
  const kill = () => {
    // The runtime shares the detached worker's process group, including when the
    // worker crashes before the SDK has a chance to stop its subprocess.
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already exited.
    }
  };
  const onParentExit = () => {
    kill();
    rmSync(directory, { recursive: true, force: true });
  };
  let exited!: () => void;
  const exit = new Promise<void>((resolve) => {
    exited = resolve;
  });
  const rejectPending = (failure: Error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(failure);
    }
    pending.clear();
    updateRefs();
  };
  child.on("message", (message: unknown) => {
    // Replies come from the package's own worker: `{ id, ok, value? }`.
    const reply = (message ?? {}) as { id?: number; ok?: boolean; value?: unknown };
    const request = pending.get(reply.id as number);
    if (!request) return;
    pending.delete(reply.id as number);
    clearTimeout(request.timer);
    updateRefs();
    if (reply.ok === true) request.resolve(reply.value);
    // Never trust SDK error text: it can carry credentials and stack traces.
    else request.reject(error("operation failed"));
  });
  child.on("error", () => {
    closed = true;
    rejectPending(error("worker failed"));
    kill();
    if (!child.pid) {
      rmSync(directory, { recursive: true, force: true });
      process.removeListener("exit", onParentExit);
      exited();
    }
  });
  child.once("exit", () => {
    closed = true;
    rejectPending(error("worker exited"));
    kill();
    rmSync(directory, { recursive: true, force: true });
    process.removeListener("exit", onParentExit);
    exited();
  });
  process.once("exit", onParentExit);
  const rpc = <T>(method: string, params?: object, milliseconds = DEADLINE_MS) =>
    new Promise<T>((resolve, reject) => {
      if (closed || !child.connected) return reject(error("client is closed"));
      const id = ++nextId;
      const timer = setTimeout(() => {
        closed = true;
        rejectPending(error("operation timed out"));
        kill();
      }, milliseconds);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      updateRefs();
      child.send({ id, method, params }, (failure) => {
        if (!failure) return;
        closed = true;
        rejectPending(error("worker disconnected"));
        kill();
      });
    });
  const ready = rpc<void>("initialize", { token, directory, sdk });
  token = undefined;
  // Callers may close immediately without ever asking for metadata.
  ready.catch(() => {});
  return {
    async models() {
      await ready;
      return rpc<CopilotModelInfo[]>("models");
    },
    async endpoint(model?: string) {
      if (model !== undefined && (typeof model !== "string" || !model.trim()))
        throw error("model ID must be a nonempty string");
      await ready;
      return rpc<CopilotEndpoint>("endpoint", model === undefined ? {} : { modelId: model });
    },
    close() {
      closePromise ??= (async () => {
        closing = true;
        updateRefs();
        if (!closed) {
          // Initialization may still be running; close is deliberately not queued
          // behind it, so a stuck SDK cannot prevent shutdown.
          try {
            await rpc("close", undefined, SHUTDOWN_DEADLINE_MS);
          } catch {
            kill();
          }
        }
        closed = true;
        rejectPending(error("client is closed"));
        kill();
        await exit;
      })();
      return closePromise;
    },
  };
}
