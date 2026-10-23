// The private Copilot SDK worker behind createCopilotEndpointClient. It runs in its own
// process group with an isolated home, no inherited stdio and no SDK logging, and it
// answers IPC requests with values only: SDK errors, which may carry credentials, never
// leave this process.
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface Session {
  disconnect(): Promise<void>;
  rpc: { provider: { getEndpoint(params: object): Promise<unknown> } };
}
interface Client {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  getAuthStatus(): Promise<{ isAuthenticated?: boolean }>;
  listModels(): Promise<unknown>;
  createSession(config: object): Promise<Session>;
}
interface InitializeParams {
  token?: string;
  directory: string;
  sdk: string;
}

let client: Client | undefined;
let session: Session | undefined;
let models: unknown;
let directory: string | undefined;
let closing = false;
let initialized = false;
let cleanup: Promise<void> | undefined;

function active(): void {
  if (closing) throw new Error("Closed");
}
function reply(id: unknown, ok: boolean, value?: unknown): void {
  if (process.connected) process.send!({ id, ok, ...(ok ? { value } : {}) });
}
function shutdown(): Promise<void> {
  if (cleanup) return cleanup;
  closing = true;
  cleanup = (async () => {
    const force = setTimeout(() => {
      // Also terminate a runtime left behind by a hung SDK stop or disconnect.
      if (directory) rmSync(directory, { recursive: true, force: true });
      try {
        process.kill(-process.pid, "SIGKILL");
      } catch {
        process.exit(1);
      }
    }, 4_000);
    try {
      await session?.disconnect();
    } catch {
      // No runtime messages or credential-bearing errors escape.
    }
    try {
      await client?.stop();
    } catch {
      // The parent also kills the worker's process group.
    }
    if (directory) rmSync(directory, { recursive: true, force: true });
    clearTimeout(force);
  })();
  return cleanup;
}
async function initialize(params: InitializeParams): Promise<void> {
  if (initialized) throw new Error("Already initialized");
  initialized = true;
  directory = params.directory;
  for (const path of [
    process.env.XDG_CONFIG_HOME,
    process.env.XDG_CACHE_HOME,
    process.env.XDG_DATA_HOME,
    process.env.XDG_STATE_HOME,
    process.env.TMPDIR,
    join(directory, "workspace"),
  ])
    if (path) mkdirSync(path, { recursive: true, mode: 0o700 });
  // The parent resolved the consumer's installed SDK peer; a static import would bind
  // whichever copy the bundler saw.
  const sdk = await import(pathToFileURL(params.sdk).href);
  if (typeof sdk.CopilotClient !== "function") throw new Error("Unsupported SDK");
  active();
  client = new sdk.CopilotClient({
    env: {
      ...process.env,
      COPILOT_GITHUB_TOKEN: params.token,
      S2STOKENS: "true",
      COPILOT_ALLOW_GET_PROVIDER_ENDPOINT: "true",
    },
    useLoggedInUser: true,
    mode: "empty",
    baseDirectory: join(directory, "copilot"),
    workingDirectory: join(directory, "workspace"),
    logLevel: "none",
  }) as Client;
  params.token = undefined;
  await client.start();
  active();
  const auth = await client.getAuthStatus();
  active();
  if (auth.isAuthenticated !== true) throw new Error("Authentication failed");
  models = await client.listModels();
  active();
  session = await client.createSession({
    tools: [],
    availableTools: [],
    enableConfigDiscovery: false,
    configDirectory: join(directory, "session-config"),
    onPermissionRequest: () => ({
      kind: "denied-no-approval-rule-and-could-not-request-from-user",
    }),
  });
  active();
}

process.on("message", async (message: unknown) => {
  // Requests come from the parent client: `{ id, method, params? }`.
  const { id, method, params } = (message ?? {}) as {
    id?: unknown;
    method?: unknown;
    params?: unknown;
  };
  try {
    if (method === "close") {
      await shutdown();
      reply(id, true);
      process.disconnect();
      return;
    }
    active();
    let value: unknown;
    if (method === "initialize") await initialize(params as InitializeParams);
    else if (method === "models" && session) value = models;
    else if (method === "endpoint" && session)
      value = await session.rpc.provider.getEndpoint(params as object);
    else throw new Error("Invalid request");
    active();
    reply(id, true, value);
  } catch {
    reply(id, false);
    await shutdown();
    if (process.connected) process.disconnect();
  }
});
const exit = () => {
  void shutdown().finally(() => process.exit(0));
};
process.once("disconnect", exit);
process.once("SIGTERM", exit);
process.once("SIGINT", exit);
