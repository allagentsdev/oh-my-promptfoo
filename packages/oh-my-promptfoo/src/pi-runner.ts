import { access, lstat, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type * as PiSdkModule from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  CreateAgentSessionOptions,
  CreateModelRuntimeOptions,
  ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { resolve as resolveImport } from "import-meta-resolve";
import type { JsonObject } from "./config.js";
import { graderConfig, graderReadScope } from "./grader-policy.js";
import { type CallFrame, jsonSafe, MAX_FRAME_BYTES, redact, resolvePeer } from "./protocol.js";
import { observedSkillRead, type SkillCall, workspaceSkillDirectories } from "./skill-evidence.js";

type PiSdk = typeof PiSdkModule;
const SDK_VERSION = "1.3.0";

/** Supply only staged resources; the default loader also discovers executable extensions. */
async function resourceLoader(
  sdk: PiSdk,
  frame: CallFrame,
  agentDir: string,
): Promise<ResourceLoader> {
  const skillPaths: string[] = [];
  const agentsFiles: { path: string; content: string }[] = [];
  if (!frame.readOnly) {
    for (const directory of workspaceSkillDirectories(frame.workingDir)) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const path = join(directory, entry.name, "SKILL.md");
        if (observedSkillRead("read", { path }, frame.workingDir)) skillPaths.push(path);
      }
    }
    const path = join(frame.workingDir, "AGENTS.md");
    try {
      if ((await lstat(path)).isFile())
        agentsFiles.push({ path, content: await readFile(path, "utf8") });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const skills = frame.readOnly
    ? { skills: [], diagnostics: [] }
    : sdk.loadSkills({ cwd: frame.workingDir, agentDir, skillPaths, includeDefaults: false });
  const extensions = { extensions: [], errors: [], runtime: sdk.createExtensionRuntime() };
  return {
    getExtensions: () => extensions,
    getSkills: () => skills,
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles }),
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources() {},
    async reload() {},
  };
}

export async function runPi(
  frame: CallFrame,
  signal: AbortSignal,
  emit: (frame: JsonObject) => void,
  sensitive: string[],
): Promise<JsonObject> {
  const config = frame.readOnly ? graderConfig("pi-sdk", frame.config) : frame.config;
  const provider = config.provider;
  const modelId = config.model;
  if (
    typeof provider !== "string" ||
    !provider.trim() ||
    typeof modelId !== "string" ||
    !modelId.trim()
  )
    throw new Error("pi-sdk requires nonempty config.provider and config.model");
  // This optional peer must resolve from the evaluation project, not this adapter's install.
  const sdkUrl = pathToFileURL(resolvePeer(frame.basePath, "@earendil-works/pi-coding-agent")).href;
  const sdk = (await import(sdkUrl)) as PiSdk;
  if (
    sdk.VERSION !== SDK_VERSION ||
    typeof sdk.createAgentSession !== "function" ||
    typeof sdk.ModelRuntime?.create !== "function" ||
    typeof sdk.createReadToolDefinition !== "function"
  )
    throw new Error(
      `pi-sdk requires @earendil-works/pi-coding-agent@${SDK_VERSION}; installed SDK reports ${String(sdk.VERSION ?? "an unsupported version")}`,
    );
  // The SDK is optional; resolve its credential store from the consumer install, not this package.
  const authSdk: {
    InMemoryCredentialStore: new () => NonNullable<CreateModelRuntimeOptions["credentials"]>;
  } = await import(resolveImport("@earendil-works/pi-ai", sdkUrl));
  const agentDir = await mkdtemp(join(tmpdir(), "oh-my-promptfoo-pi-"));
  let session: AgentSession | undefined;
  let unsubscribe: (() => void) | undefined;
  let output = "";
  let failure: unknown;
  let streamError: string | undefined;
  let events = 0;
  let eventBytes = 0;
  let cost = 0;
  const usage = { prompt: 0, completion: 0, total: 0, cached: 0, numRequests: 0 };
  const tools = new Set<string>();
  const skillReads = new Map<string, SkillCall>();
  const skillCalls: SkillCall[] = [];
  const cleanupErrors: unknown[] = [];
  let abortPromise: Promise<void> | undefined;
  const abort = () => {
    if (session && !abortPromise)
      abortPromise = session.abort().catch((error) => {
        cleanupErrors.push(error);
      });
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const runtime = await sdk.ModelRuntime.create({
      credentials: new authSdk.InMemoryCredentialStore(),
      // Null also selects the SDK's in-memory catalog store, not just disabled model-file discovery.
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
      signal,
    });
    if (!runtime.getProvider(provider))
      throw new Error(
        `Unknown Pi provider ${provider}; choose a built-in provider from SDK ${SDK_VERSION}`,
      );
    if (typeof config.baseUrl === "string")
      runtime.registerProvider(provider, { baseUrl: config.baseUrl });
    const model = runtime.getModel(provider, modelId);
    if (!model)
      throw new Error(
        `Unknown Pi model ${provider}/${modelId}; choose a built-in chat model from SDK ${SDK_VERSION} (baseUrl changes the endpoint, not the model catalog)`,
      );
    if (typeof config.apiKey === "string")
      await runtime.setRuntimeApiKey(provider, config.apiKey, { signal });
    const env = Object.fromEntries(
      (frame.delegateEnvKeys ?? []).map((key) => [key, process.env[key] ?? ""]),
    );
    const auth = await runtime.getAuth(model, { env, signal });
    if (!auth)
      throw new Error(
        `No Pi credentials for ${provider}; set delegate.config.apiKey or the provider's credential variables through delegate.env. Global Pi logins are not imported`,
      );
    const allowedRead = frame.readOnly
      ? await graderReadScope(frame.workingDir, frame.readOnly.sourceRoots)
      : undefined;
    const requireRead = async (path: string) => {
      if (allowedRead && !(await allowedRead(path)))
        throw new Error("Pi read is outside the grader workspace or protected sources");
    };
    const read = sdk.createReadToolDefinition(
      frame.workingDir,
      allowedRead
        ? {
            operations: {
              async access(path) {
                await requireRead(path);
                await access(path);
              },
              async readFile(path) {
                await requireRead(path);
                return readFile(path);
              },
              async detectImageMimeType(path) {
                await requireRead(path);
                return sdk.detectSupportedImageMimeTypeFromFile(path);
              },
            },
          }
        : undefined,
    );
    const list = sdk.createLsToolDefinition(
      frame.workingDir,
      allowedRead
        ? {
            operations: {
              async exists(path) {
                await requireRead(path);
                try {
                  await access(path);
                  return true;
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
                  throw error;
                }
              },
              async stat(path) {
                await requireRead(path);
                return stat(path);
              },
              async readdir(path) {
                await requireRead(path);
                return readdir(path);
              },
            },
          }
        : undefined,
    );
    const permissions = (config.permissions ?? {}) as JsonObject;
    const activeTools = ["read", "ls"];
    if (!frame.readOnly && permissions.filesystem === "write") activeTools.push("edit", "write");
    if (!frame.readOnly && permissions.shell === "allow") activeTools.push("bash");
    const trackedRead: typeof read = {
      ...read,
      async execute(id, args, toolSignal, onUpdate, context) {
        const before = frame.readOnly
          ? undefined
          : observedSkillRead("read", args, frame.workingDir);
        const result = await read.execute(id, args, toolSignal, onUpdate, context);
        const after = before && observedSkillRead("read", args, frame.workingDir);
        if (before && after && before.path === after.path) skillReads.set(id, after);
        return result;
      },
    };
    // Pi's heterogeneous tool array erases schema-specific renderer types; the schema and executor remain paired.
    const customTools = [trackedRead, list] as unknown as CreateAgentSessionOptions["customTools"];
    const resources = await resourceLoader(sdk, frame, agentDir);
    signal.throwIfAborted();
    ({ session } = await sdk.createAgentSession({
      cwd: frame.workingDir,
      agentDir,
      modelRuntime: runtime,
      model,
      ...(config.thinkingLevel
        ? { thinkingLevel: config.thinkingLevel as CreateAgentSessionOptions["thinkingLevel"] }
        : {}),
      tools: activeTools,
      customTools,
      resourceLoader: resources,
      sessionManager: sdk.SessionManager.inMemory(frame.workingDir),
      settingsManager: sdk.SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
        cacheWarming: "off",
        enableAnalytics: false,
        enableInstallTelemetry: false,
        enableSkillCommands: false,
      }),
    }));
    const meter = (payload: string) => {
      eventBytes += Buffer.byteLength(payload);
      if (eventBytes > MAX_FRAME_BYTES) throw new Error("Pi event stream exceeds its bound");
    };
    unsubscribe = session.subscribe((event) => {
      try {
        if (event.type === "message_start" && event.message.role === "assistant") output = "";
        if (event.type === "message_update" && event.message.role === "assistant") {
          const update = event.assistantMessageEvent;
          // Updates also carry accumulated snapshots; meter only new content.
          if ("delta" in update && typeof update.delta === "string") {
            meter(update.delta);
            if (update.type === "text_delta") output += update.delta;
          }
        } else if (event.type === "message_end" && event.message.role === "assistant") {
          const message = event.message;
          usage.prompt += message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
          usage.completion += message.usage.output;
          usage.total += message.usage.totalTokens;
          usage.cached += message.usage.cacheRead;
          usage.numRequests++;
          cost += message.usage.cost.total;
          if (message.stopReason === "error" || message.stopReason === "aborted")
            streamError ??= message.errorMessage || `Pi response ${message.stopReason}`;
          jsonSafe(message.content);
          output = message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
        }
        if (++events > 100_000) throw new Error("Pi event stream exceeds its bound");
        if (event.type === "tool_execution_start") {
          if (tools.has(event.toolCallId)) throw new Error("Duplicate Pi tool identity");
          const argumentsJson = jsonSafe(event.args);
          meter(argumentsJson);
          emit({
            version: 1,
            type: "tool",
            phase: "start",
            id: event.toolCallId,
            name: redact(event.toolName, sensitive),
            attributes: { "gen_ai.tool.call.arguments": redact(argumentsJson, sensitive) },
          });
          tools.add(event.toolCallId);
        } else if (event.type === "tool_execution_end" && tools.has(event.toolCallId)) {
          meter(jsonSafe(event.result));
          tools.delete(event.toolCallId);
          const skill = skillReads.get(event.toolCallId);
          skillReads.delete(event.toolCallId);
          if (
            skill &&
            !event.isError &&
            observedSkillRead("read", { path: skill.path }, frame.workingDir)
          )
            skillCalls.push(skill);
          emit({
            version: 1,
            type: "tool",
            phase: "end",
            id: event.toolCallId,
            ...(event.isError ? { error: "Pi tool failed" } : {}),
          });
        }
      } catch (error) {
        streamError ??= error instanceof Error ? error.message : String(error);
        abort();
      }
    });
    if (signal.aborted) {
      abort();
      throw new Error("Pi call aborted");
    }
    await session.prompt(frame.prompt, { expandPromptTemplates: false });
    if (signal.aborted) throw new Error("Pi call aborted");
    if (streamError) throw new Error(streamError);
  } catch (error) {
    failure = error;
  } finally {
    signal.removeEventListener("abort", abort);
    if (session) {
      try {
        if (abortPromise) await abortPromise;
        else await session.abort();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    unsubscribe?.();
    for (const id of tools)
      emit({
        version: 1,
        type: "tool",
        phase: "end",
        id,
        error: "Tool did not complete before session shutdown",
      });
    try {
      session?.dispose();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await rm(agentDir, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length) {
    const errors = [...(failure ? [failure] : []), ...cleanupErrors];
    failure = new AggregateError(
      errors,
      errors.map((error) => (error instanceof Error ? error.message : String(error))).join("; "),
    );
  }
  const metadata = {
    pi: { sdkVersion: SDK_VERSION, provider, model: modelId, skillSupport: true },
    skillCalls,
  };
  if (failure) {
    if (!usage.numRequests && !cost) throw failure;
    return {
      error: failure instanceof Error ? failure.message : String(failure),
      ...(output ? { output } : {}),
      tokenUsage: usage,
      cost,
      metadata,
    };
  }
  return { output, tokenUsage: usage, cost, metadata };
}
