import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import * as bundledTelemetry from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { resolve as resolveImport } from "import-meta-resolve";
import { destination } from "../../workspace-core/src/config.js";
import {
  type CopilotSdkConfig,
  closed,
  type JsonObject,
  object,
  validateDelegateConfig,
  validateEnv,
} from "./config.js";
import {
  type CopilotAccounting,
  copilotUsageValue,
  safeCount,
  safeMultiplier,
  sessionAccounting,
} from "./copilot-accounting.js";
import { copilotInput } from "./copilot-input.js";
import { claudeReadAllowed, graderConfig, graderReadScope } from "./grader-policy.js";
import {
  claudeMcpOptions,
  copilotMcpAttributes,
  copilotMcpOptions,
  mcpToolAllowed,
  nativeMcpAttributes,
  type ResolvedMcpServer,
  resolveMcpServers,
} from "./mcp.js";
import { NativeToolInventory } from "./native-tool-inventory.js";
import { runPi } from "./pi-runner.js";
import {
  type CallFrame,
  jsonSafe,
  MAX_FRAME_BYTES,
  redact,
  resolvePeer,
  secrets,
} from "./protocol.js";
import {
  completedShellSkillRead,
  observedShellSkillRead,
  observedSkillRead,
  type ShellSkillRead,
  type SkillCall,
  workspaceSkillDirectories,
} from "./skill-evidence.js";
import { type ToolInventory, ToolInventoryBuilder } from "./tool-inventory.js";

// Reserve stdout for protocol even if a peer logs during import or execution.
const protocolWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
function emit(frame: JsonObject): void {
  protocolWrite(`${jsonSafe(frame)}\n`);
}
const controller = new AbortController();
let accepted = false,
  terminal = false,
  buffer = Buffer.alloc(0),
  fatal: Error | undefined;
let sensitive: string[] = [];
let mcpServers: ResolvedMcpServer[] = [];
let telemetryApi = bundledTelemetry;
let nativeInventory: NativeToolInventory | undefined;
// Native Promptfoo agent spans are collected in this child, then replayed on the
// host's row trace. No unconfigured exporter or separate root trace is created.
const tracerProvider = new NodeTracerProvider({
  spanProcessors: [
    {
      onStart(span, parentContext) {
        nativeInventory?.span(span, false);
        if (terminal) return;
        const attributes: JsonObject = JSON.parse(redact(jsonSafe(span.attributes), sensitive));
        emit({
          version: 1,
          type: "tool",
          phase: "start",
          id: `native:${span.spanContext().spanId}`,
          name: redact(span.name, sensitive),
          startTime: span.startTime,
          parentId: `native:${telemetryApi.trace.getSpan(parentContext)?.spanContext().spanId ?? ""}`,
          attributes: {
            ...attributes,
            ...nativeMcpAttributes(attributes, mcpServers),
          },
        });
      },
      onEnd(span) {
        if (terminal) return;
        const mcpAttributes = nativeMcpAttributes(span.attributes, mcpServers);
        nativeInventory?.span(span, true, mcpAttributes);
        const id = `native:${span.spanContext().spanId}`;
        const attributes: JsonObject = {};
        for (const [key, value] of Object.entries(span.attributes))
          if (value !== undefined)
            attributes[key] = typeof value === "string" ? redact(value, sensitive) : value;
        for (const key in mcpAttributes) {
          const value = mcpAttributes[key];
          attributes[key] = typeof value === "string" ? redact(value, sensitive) : value;
        }
        emit({
          version: 1,
          type: "tool",
          phase: "end",
          id,
          endTime: span.endTime,
          attributes,
          ...(span.status.code === 2
            ? { error: redact(span.status.message ?? "Native agent span failed", sensitive) }
            : {}),
        });
      },
      async shutdown() {},
      async forceFlush() {},
    },
  ],
});
function fail(error: unknown): void {
  fatal ??= error instanceof Error ? error : new Error(String(error));
  controller.abort();
  if (!accepted && !terminal) {
    terminal = true;
    emit({ version: 1, type: "error", error: redact(fatal.message, sensitive) });
    process.exitCode = 1;
    process.stdin.destroy();
  }
}
process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());
process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  if (buffer.length > MAX_FRAME_BYTES) {
    fail(new Error("Request frame exceeds protocol byte limit"));
    return;
  }
  while (true) {
    const idx = buffer.indexOf(10);
    if (idx < 0) break;
    const line = buffer.subarray(0, idx).toString("utf8");
    buffer = buffer.subarray(idx + 1);
    try {
      const f = object(JSON.parse(line), "request frame");
      if (f.version !== 1) throw new Error("Unsupported request protocol version");
      if (f.type === "abort") {
        closed(f, ["version", "type"], "abort");
        if (!accepted || terminal) throw new Error("Unexpected abort frame");
        controller.abort();
      } else if (f.type === "call") {
        if (accepted || terminal) throw new Error("Duplicate call frame");
        accepted = true;
        void execute(f).catch(fail);
      } else throw new Error("Unknown request frame");
    } catch (error) {
      fail(error);
    }
  }
});
process.stdin.on("end", () => {
  if (!accepted || buffer.length) fail(new Error("Incomplete request protocol"));
});

async function execute(input: JsonObject): Promise<void> {
  let response: JsonObject | undefined;
  let inventory: ToolInventory | undefined;
  let error: unknown;
  let tracingRegistered = false;
  try {
    closed(
      input,
      [
        "version",
        "type",
        "delegate",
        "basePath",
        "workingDir",
        "config",
        "prompt",
        "context",
        "delegateEnvKeys",
        "readOnly",
        "mcpRoots",
        "mcpConfigDir",
        "deadlineMs",
      ],
      "call",
    );
    if (
      !["openai:codex-sdk", "anthropic:claude-agent-sdk", "copilot-sdk", "pi-sdk"].includes(
        input.delegate as string,
      )
    )
      throw new Error("Unsupported delegate");
    if (
      typeof input.prompt !== "string" ||
      typeof input.basePath !== "string" ||
      !isAbsolute(input.basePath) ||
      typeof input.workingDir !== "string" ||
      !isAbsolute(input.workingDir)
    )
      throw new Error("Call requires a string prompt and absolute trusted paths");
    if (!(await stat(input.workingDir)).isDirectory())
      throw new Error("working_dir is not a directory");
    const frame = input as unknown as CallFrame;
    validateDelegateConfig(frame.delegate, frame.config);
    if (frame.deadlineMs !== undefined && (!safeCount(frame.deadlineMs) || frame.deadlineMs === 0))
      throw new Error("Call deadline must be a positive safe integer");
    if (frame.readOnly !== undefined) {
      const policy = closed(frame.readOnly, ["sourceRoots", "codexHome"], "readOnly");
      if (!Array.isArray(policy.sourceRoots))
        throw new Error("readOnly.sourceRoots must be an array");
      for (const path of policy.sourceRoots) destination(path);
      graderConfig(frame.delegate, frame.config);
      if (
        frame.delegate === "openai:codex-sdk" &&
        (typeof policy.codexHome !== "string" ||
          !isAbsolute(policy.codexHome) ||
          policy.codexHome !== process.env.CODEX_HOME)
      )
        throw new Error("Read-only Codex grading requires its owned authentication home");
    }
    if (frame.mcpRoots !== undefined && !Array.isArray(frame.mcpRoots))
      throw new Error("Invalid trusted MCP roots");
    mcpServers = (await resolveMcpServers(frame)).sort((a, b) => b.name.length - a.name.length);
    if (
      !Array.isArray(frame.delegateEnvKeys) ||
      frame.delegateEnvKeys.some((key) => typeof key !== "string")
    )
      throw new Error("Call requires explicit delegate environment names");
    validateEnv(
      Object.fromEntries(frame.delegateEnvKeys.map((key) => [key, process.env[key] ?? ""])),
      "delegate.env",
    );
    object(frame.context, "context");
    sensitive = secrets(
      frame.config,
      Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<
        string,
        string
      >,
    );
    const nativePeer =
      frame.delegate === "openai:codex-sdk" || frame.delegate === "anthropic:claude-agent-sdk"
        ? resolvePeer(frame.basePath, "promptfoo")
        : undefined;
    if (nativePeer) {
      // Register through the actual consumer peer, not our bundled API: newer
      // API readers cannot see a global registry created by an older minor.
      telemetryApi = await import(
        resolveImport("@opentelemetry/api", pathToFileURL(nativePeer).href)
      );
    }
    if (nativePeer) nativeInventory = new NativeToolInventory(sensitive, mcpServers);
    tracingRegistered = true;
    telemetryApi.trace.setGlobalTracerProvider(tracerProvider);
    telemetryApi.context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    telemetryApi.propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    const carrier: Record<string, string> = {};
    for (const key of ["traceparent", "tracestate"])
      if (typeof frame.context[key] === "string") carrier[key] = frame.context[key] as string;
    const extracted = telemetryApi.propagation.extract(telemetryApi.context.active(), carrier);
    response = await telemetryApi.context.with(extracted, () =>
      nativePeer
        ? runNative(frame, controller.signal, nativePeer)
        : frame.delegate === "pi-sdk"
          ? runPi(frame, controller.signal, emit, sensitive)
          : runCopilot(frame, controller.signal),
    );
    const metadata =
      response.metadata === undefined ? {} : object(response.metadata, "delegate metadata");
    if (nativeInventory) {
      nativeInventory.response(response);
      inventory = nativeInventory.finish();
    } else inventory = metadata.toolInventory as ToolInventory;
    delete metadata.toolInventory;
    response.metadata = metadata;
    jsonSafe(response);
  } catch (e) {
    error = e;
  }
  try {
    await tracerProvider.forceFlush();
  } catch (e) {
    error ??= e;
  }
  try {
    await tracerProvider.shutdown();
  } catch (e) {
    error ??= e;
  } finally {
    if (tracingRegistered) {
      telemetryApi.trace.disable();
      telemetryApi.propagation.disable();
      telemetryApi.context.disable();
    }
  }
  if (terminal) return;
  terminal = true;
  if (fatal) error = fatal;
  try {
    if (error)
      emit({
        version: 1,
        type: "error",
        error: redact(error instanceof Error ? error.message : String(error), sensitive),
      });
    else
      emit({
        version: 1,
        type: "result",
        response: JSON.parse(redact(jsonSafe(response), sensitive)),
        toolInventory: inventory,
      });
  } catch (e) {
    emit({ version: 1, type: "error", error: redact((e as Error).message, sensitive) });
  }
  process.stdin.destroy();
  // Cleanup already finished. The parent kills any orphaned descendants after close.
  process.exitCode = 0;
}
async function runNative(
  frame: CallFrame,
  signal: AbortSignal,
  peerPath: string,
): Promise<JsonObject> {
  const peer = await import(pathToFileURL(peerPath).href);
  const load = peer.loadApiProvider ?? peer.default?.loadApiProvider;
  if (typeof load !== "function")
    throw new Error("The consumer Promptfoo peer does not export loadApiProvider");
  let provider:
    | { callApi: (...args: unknown[]) => Promise<JsonObject>; cleanup?: () => Promise<void> }
    | undefined;
  try {
    // Codex graders are stock Promptfoo: graderConfig forces its read-only options.
    let nativePolicy: JsonObject = {};
    if (frame.readOnly && frame.delegate === "anthropic:claude-agent-sdk") {
      const allowed = await graderReadScope(frame.workingDir, frame.readOnly.sourceRoots);
      const canRead = (tool: string, input: unknown) => claudeReadAllowed(tool, input, allowed);
      nativePolicy = {
        setting_sources: [],
        skills: [],
        strict_mcp_config: true,
        can_use_tool: async (tool: string, input: unknown) =>
          (await canRead(tool, input))
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: "Read-only workspace grader" },
        // Native in-workspace reads can bypass permission prompts; check those too.
        hooks: {
          PreToolUse: [
            {
              matcher: "Read|Glob|Grep",
              hooks: [
                async (event: { tool_name: string; tool_input: unknown }) =>
                  (await canRead(event.tool_name, event.tool_input))
                    ? {}
                    : {
                        hookSpecificOutput: {
                          hookEventName: "PreToolUse",
                          permissionDecision: "deny",
                          permissionDecisionReason:
                            "Read is outside the grader workspace or protected sources",
                        },
                      },
              ],
            },
          ],
        },
      };
    }
    const candidateConfig =
      frame.delegate === "anthropic:claude-agent-sdk" && !frame.readOnly && mcpServers.length > 0
        ? claudeMcpOptions(frame.config, mcpServers)
        : frame.config;
    const config = {
      ...(frame.readOnly ? graderConfig(frame.delegate, frame.config) : candidateConfig),
      ...nativePolicy,
      working_dir: frame.workingDir,
      ...(frame.delegate === "openai:codex-sdk"
        ? {
            skip_git_repo_check: true,
            cli_env: Object.fromEntries(
              (frame.delegateEnvKeys ?? []).map((key) => [key, process.env[key]]),
            ),
          }
        : {}),
    };
    provider = await load(frame.delegate, {
      basePath: frame.basePath,
      options: { config, env: process.env },
    });
    return await provider!.callApi(
      frame.prompt,
      { ...frame.context, bustCache: true },
      { abortSignal: signal },
    );
  } finally {
    if (typeof provider?.cleanup === "function") await provider.cleanup();
  }
}

interface SessionLike {
  rpc?: {
    skills?: { getInvoked?: () => Promise<{ skills: unknown }> };
    usage?: { getMetrics?: () => Promise<unknown> };
  };
  on(
    callback: (event: {
      type: string;
      data: JsonObject;
      timestamp?: string;
      agentId?: string;
    }) => void,
  ): (() => void) | undefined;
  sendAndWait(
    options: { prompt: string },
    timeout: number,
  ): Promise<{ data?: { content?: string } } | undefined>;
  abort(): Promise<unknown>;
  disconnect(): Promise<unknown>;
}
interface ClientLike {
  createSession(config: JsonObject): Promise<SessionLike>;
  stop(): Promise<unknown>;
  forceStop(): Promise<unknown>;
}

// Copilot CLI redacts secret-shaped text in loaded skill content, including harmless
// prose such as "Bearer authentication", by replacing each match with this mask. Its
// rules include runtime-known secret values, so the redaction cannot be reproduced here.
const REDACTION_MASK = "******";
const MAX_MASKS = 64;
const MAX_MASKED_SPAN = 256;
const MAX_ALIGNMENT_STEPS = 1_000_000;

/**
 * Exact equality, or a bounded redaction of the local body: every visible character
 * matches in order, each mask hides one non-empty single-line span of at most
 * MAX_MASKED_SPAN characters, and at least 90% of the body stays visible.
 */
function matchesLoadedBody(body: string, content: string): boolean {
  if (body === content) return true;
  const parts = content.split(REDACTION_MASK);
  const masks = parts.length - 1;
  const visible = content.length - masks * REDACTION_MASK.length;
  if (masks === 0 || masks > MAX_MASKS || visible * 10 < body.length * 9) return false;
  if (!body.startsWith(parts[0]!)) return false;
  const failed = new Set<string>();
  let steps = 0;
  // Memoized states still multiply with masks and span length on crafted single-line
  // bodies, so a fixed step budget rejects them instead of blocking the runner.
  const align = (index: number, position: number): boolean => {
    if (index === masks) return position === body.length;
    const key = `${index}:${position}`;
    if (failed.has(key)) return false;
    const next = parts[index + 1]!;
    for (let span = 1; span <= MAX_MASKED_SPAN && position + span <= body.length; span++) {
      if (body[position + span - 1] === "\n" || ++steps > MAX_ALIGNMENT_STEPS) break;
      const start = position + span;
      if (body.startsWith(next, start) && align(index + 1, start + next.length)) return true;
    }
    failed.add(key);
    return false;
  };
  return align(0, parts[0]!.length);
}

function verifiedSkillLoaderRecord(entry: unknown, workingDir: string): SkillCall | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
  const { name, path, content } = entry as Record<string, unknown>;
  if (typeof name !== "string" || typeof path !== "string" || typeof content !== "string") return;
  const local = observedSkillRead("read_file", { path }, workingDir);
  if (!local || local.name !== name) return;
  try {
    // The SDK returns the loaded SKILL.md body without YAML frontmatter.
    const body = readFileSync(local.path, "utf8")
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
      .replace(/\r\n/g, "\n")
      .trim();
    if (!body || !matchesLoadedBody(body, content.replace(/\r\n/g, "\n").trim())) return;
    return { ...local, source: "sdk-skill-loader" };
  } catch {
    return;
  }
}
async function runCopilot(frame: CallFrame, signal: AbortSignal): Promise<JsonObject> {
  const input = copilotInput(
    frame.prompt,
    frame.config.inputFormat as CopilotSdkConfig["inputFormat"],
  );
  const sdk = await import(pathToFileURL(resolvePeer(frame.basePath, "@github/copilot-sdk")).href);
  if (typeof sdk.CopilotClient !== "function")
    throw new Error("Install the supported @github/copilot-sdk@1.0.22 peer");
  const skillDirectories = frame.readOnly ? [] : workspaceSkillDirectories(frame.workingDir);
  const allowedRead = frame.readOnly
    ? await graderReadScope(frame.workingDir, frame.readOnly.sourceRoots)
    : undefined;
  const client: ClientLike = new sdk.CopilotClient({
    workingDirectory: frame.workingDir,
    env: process.env,
    onGetTraceContext: () => ({
      traceparent: frame.context.traceparent,
      tracestate: frame.context.tracestate,
    }),
    ...(process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      ? {
          telemetry: {
            otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
            otlpProtocol: process.env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "http/protobuf",
            exporterType: "otlp-http",
            captureContent: false,
          },
        }
      : {}),
  });
  let session: SessionLike | undefined, unsubscribe: (() => void) | undefined;
  let output = "",
    sessionError: string | undefined;
  const usage = { prompt: 0, completion: 0, total: 0, cached: 0, numRequests: 0 };
  let premiumCost = 0;
  let premiumCostComplete = true;
  let events = 0,
    eventBytes = 0;
  let accounting: CopilotAccounting = {
    ...sessionAccounting(undefined, false, frame.config.model),
    reason: "session_not_created",
  };
  let callError: unknown;
  let callFailed = false;
  const cleanupErrors: unknown[] = [];
  const tools = new Set<string>();
  const skillReads = new Map<string, SkillCall>();
  const shellSkillReads = new Map<string, ShellSkillRead>();
  const skillCalls: SkillCall[] = [];
  const inventory = new ToolInventoryBuilder(sensitive);
  const subagents = new Map<
    string,
    { active: boolean; observed: number; reported?: number; agentId?: string }
  >();
  const agentParents = new Map<string, string>();
  const toolParents = new Map<string, string>();
  const observedAgentIds = new Set<string>();
  const observedParentIds = new Set<string>();
  let mainSettled = false;
  let observedIdle = false;
  const bindSubagent = (parentId: string, agentId: unknown): boolean => {
    if (agentId === undefined) return true;
    if (typeof agentId !== "string" || !agentId || agentId.length > 512) {
      inventory.incomplete("malformed-subagent-lifecycle");
      return false;
    }
    const child = subagents.get(parentId);
    const mappedParent = agentParents.get(agentId);
    if (
      !child ||
      (child.agentId !== undefined && child.agentId !== agentId) ||
      (mappedParent !== undefined && mappedParent !== parentId)
    ) {
      inventory.incomplete("subagent-lifecycle-identity-mismatch");
      return false;
    }
    if (agentParents.size >= 1024 && mappedParent === undefined) {
      inventory.incomplete("malformed-subagent-lifecycle");
      return false;
    }
    child.agentId = agentId;
    agentParents.set(agentId, parentId);
    return true;
  };
  const permissions = (frame.config.permissions ?? {}) as JsonObject;
  const approve = (request: JsonObject): JsonObject | Promise<JsonObject> => {
    if (request.kind === "read" && allowedRead)
      return allowedRead(request.path).then((allowed) =>
        allowed ? { kind: "approve-once" } : { kind: "reject" },
      );
    const allowed =
      request.kind === "read" ||
      (request.kind === "write" && permissions.filesystem === "write") ||
      (request.kind === "shell" && permissions.shell === "allow") ||
      (request.kind === "url" && permissions.network === "allow") ||
      (request.kind === "mcp" &&
        !frame.readOnly &&
        mcpServers.some(
          (server) =>
            server.name === request.serverName && mcpToolAllowed(server, request.toolName),
        ));
    return allowed ? { kind: "approve-once" } : { kind: "reject" };
  };
  const abort = () => {
    void session?.abort().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw new Error("Copilot call aborted");
    session = await client.createSession({
      workingDirectory: frame.workingDir,
      ...(input.systemMessage ? { systemMessage: input.systemMessage } : {}),
      ...(frame.config.model ? { model: frame.config.model } : {}),
      ...(frame.config.reasoning_effort ? { reasoningEffort: frame.config.reasoning_effort } : {}),
      ...(frame.config.provider ? { provider: frame.config.provider } : {}),
      onPermissionRequest: approve,
      mcpServers: copilotMcpOptions(mcpServers),
      enableConfigDiscovery: false,
      includeSubAgentStreamingEvents: true,
      // Keep general config discovery off; expose only physical workspace skill directories.
      ...(frame.readOnly
        ? { enableSkills: false, skipCustomInstructions: true }
        : skillDirectories.length
          ? { enableSkills: true, skillDirectories }
          : {}),
      infiniteSessions: { enabled: false },
    });
    unsubscribe = session.on((event) => {
      try {
        events++;
        eventBytes += Buffer.byteLength(JSON.stringify(event));
        if (events > 100_000 || eventBytes > MAX_FRAME_BYTES) {
          sessionError = "Copilot event stream exceeds its bound";
          inventory.incomplete("event-stream-bound");
          abort();
          return;
        }
        const data = event.data;
        for (const identity of [event.agentId, data.parentToolCallId])
          if (
            identity !== undefined &&
            (typeof identity !== "string" || !identity || identity.length > 512)
          )
            inventory.incomplete("malformed-subagent-lifecycle");
        const subagentEvent = Boolean(event.agentId || data.parentToolCallId);
        if (typeof event.agentId === "string") {
          if (observedAgentIds.size < 1024) observedAgentIds.add(event.agentId);
          else inventory.incomplete("malformed-subagent-lifecycle");
        }
        if (typeof data.parentToolCallId === "string") {
          if (observedParentIds.size < 1024) observedParentIds.add(data.parentToolCallId);
          else inventory.incomplete("malformed-subagent-lifecycle");
        }
        const agentActivity =
          event.type.startsWith("tool.") ||
          event.type.startsWith("skill.") ||
          event.type.startsWith("subagent.");
        if ((observedIdle || mainSettled) && agentActivity)
          inventory.incomplete("post-idle-agent-activity");
        if (event.type === "abort") inventory.incomplete("session-aborted");
        if (event.type === "session.shutdown" && data.shutdownType === "error")
          inventory.incomplete("session-shutdown-error");
        if (event.type === "session.idle") {
          if (data.aborted === true) inventory.incomplete("session-idle-aborted");
          else if (data.aborted !== undefined && typeof data.aborted !== "boolean")
            inventory.incomplete("malformed-session-idle");
          else if (!subagentEvent && data.mode !== "autopilot") observedIdle = true;
        }
        if (event.type === "subagent.started") {
          const id = data.toolCallId;
          if (
            typeof id !== "string" ||
            !id ||
            id.length > 512 ||
            subagents.has(id) ||
            subagents.size >= 1024
          )
            inventory.incomplete("malformed-subagent-lifecycle");
          else {
            subagents.set(id, { active: true, observed: 0 });
            bindSubagent(id, event.agentId);
          }
        } else if (event.type === "subagent.completed" || event.type === "subagent.failed") {
          if (data.cancelled !== undefined && typeof data.cancelled !== "boolean")
            inventory.incomplete("malformed-subagent-lifecycle");
          const id = data.toolCallId;
          const child = typeof id === "string" ? subagents.get(id) : undefined;
          if (!child?.active || typeof id !== "string")
            inventory.incomplete("unmatched-subagent-completion");
          else if (bindSubagent(id, event.agentId)) {
            child.active = false;
            if (data.totalToolCalls !== undefined) {
              if (safeCount(data.totalToolCalls)) child.reported = data.totalToolCalls;
              else inventory.incomplete("malformed-subagent-tool-count");
            }
          }
          if (event.type === "subagent.failed" || data.cancelled === true)
            inventory.incomplete("subagent-execution-incomplete");
        }
        // Lifecycle envelopes identify the child instance and its spawning tool.
        // Older streams can also establish that same pair on attributed tool events.
        const lifecycleEvent =
          event.type === "subagent.started" ||
          event.type === "subagent.completed" ||
          event.type === "subagent.failed";
        if (subagentEvent && !lifecycleEvent) {
          const parent =
            typeof data.parentToolCallId === "string" ? data.parentToolCallId : undefined;
          const mapped =
            typeof event.agentId === "string" ? agentParents.get(event.agentId) : undefined;
          const childId = parent ?? mapped;
          const child = childId === undefined ? undefined : subagents.get(childId);
          if (!child?.active || childId === undefined || (parent && mapped && parent !== mapped))
            inventory.incomplete("subagent-lifecycle-unavailable");
          else if (bindSubagent(childId, event.agentId)) {
            if (event.type === "tool.execution_start") {
              child.observed++;
              if (typeof data.toolCallId === "string" && toolParents.size < 1024)
                toolParents.set(data.toolCallId, childId);
            } else if (
              event.type === "tool.execution_complete" &&
              typeof data.toolCallId === "string" &&
              toolParents.get(data.toolCallId) !== childId
            )
              inventory.incomplete("subagent-tool-attribution-mismatch");
          }
        }
        if (event.type === "assistant.message" && typeof data.content === "string")
          output = data.content;
        else if (event.type === "assistant.usage") {
          const input = typeof data.inputTokens === "number" ? data.inputTokens : 0,
            completion = typeof data.outputTokens === "number" ? data.outputTokens : 0;
          usage.prompt += input;
          usage.completion += completion;
          usage.total += input + completion;
          usage.cached += typeof data.cacheReadTokens === "number" ? data.cacheReadTokens : 0;
          usage.numRequests++;
          if (safeMultiplier(data.cost) && safeMultiplier(premiumCost + data.cost))
            premiumCost += data.cost;
          else premiumCostComplete = false;
        } else if (event.type === "session.error")
          sessionError = typeof data.message === "string" ? data.message : "Copilot session failed";
        else if (event.type === "tool.execution_start") {
          const mcpAttributes = copilotMcpAttributes(data);
          inventory.start(
            data.toolCallId,
            data.toolName,
            data.arguments,
            event.timestamp,
            mcpAttributes["gen_ai.tool.mcp.server"] ??
              data.mcpConfigServerName ??
              data.mcpServerName,
            mcpAttributes["gen_ai.tool.mcp.tool"] ?? data.mcpToolName,
          );
          if (typeof data.toolCallId !== "string" || typeof data.toolName !== "string")
            throw new Error("Malformed Copilot tool start");
          if (tools.has(data.toolCallId)) throw new Error("Duplicate Copilot tool identity");
          tools.add(data.toolCallId);
          if (!data.mcpServerName && !data.mcpConfigServerName) {
            const skillRead = observedSkillRead(data.toolName, data.arguments, frame.workingDir);
            if (skillRead) skillReads.set(data.toolCallId, skillRead);
            const shellRead = observedShellSkillRead(
              data.toolName,
              data.arguments,
              frame.workingDir,
            );
            if (shellRead) shellSkillReads.set(data.toolCallId, shellRead);
          }
          const attributes: JsonObject = JSON.parse(redact(jsonSafe(mcpAttributes), sensitive));
          try {
            if (data.arguments)
              attributes["gen_ai.tool.call.arguments"] = redact(
                jsonSafe(data.arguments),
                sensitive,
              );
          } finally {
            // Keep the trace paired even when argument validation rejects the event.
            emit({
              version: 1,
              type: "tool",
              phase: "start",
              id: data.toolCallId,
              name: redact(data.toolName, sensitive),
              attributes,
            });
          }
        } else if (event.type === "tool.execution_complete") {
          inventory.end(data.toolCallId, data.success, event.timestamp);
          if (typeof data.toolCallId !== "string" || !tools.delete(data.toolCallId))
            throw new Error("Copilot tool completion without start");
          const skillRead = skillReads.get(data.toolCallId);
          skillReads.delete(data.toolCallId);
          if (skillRead && data.success === true) skillCalls.push(skillRead);
          const shellRead = shellSkillReads.get(data.toolCallId);
          shellSkillReads.delete(data.toolCallId);
          const completedRead =
            shellRead && completedShellSkillRead(shellRead, data, frame.workingDir);
          if (completedRead) skillCalls.push(completedRead);
          emit({
            version: 1,
            type: "tool",
            phase: "end",
            id: data.toolCallId,
            ...(data.success === false ? { error: "Copilot tool failed" } : {}),
          });
        }
      } catch (e) {
        sessionError = (e as Error).message;
        abort();
      }
    });
    const final = await session.sendAndWait(
      { prompt: input.prompt },
      (frame.config.timeoutMs as number | undefined) ?? 900_000,
    );
    mainSettled = true;
    if (signal.aborted) throw new Error("Copilot call aborted");
    if (!sessionError) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const getInvoked = session.rpc?.skills?.getInvoked;
        if (getInvoked) {
          const budget = Math.max(
            0,
            Math.min(1000, (frame.deadlineMs ?? Infinity) - Date.now() - 50),
          );
          if (!budget) throw new Error("SDK skill inventory deadline elapsed");
          const invoked = await Promise.race([
            getInvoked.call(session.rpc!.skills),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("SDK skill inventory timeout")), budget);
            }),
          ]);
          // Positive local-body evidence remains independent of strict snapshot validation.
          if (Array.isArray(invoked.skills))
            for (const entry of invoked.skills.slice(0, 1024)) {
              const loaded = verifiedSkillLoaderRecord(entry, frame.workingDir);
              if (loaded) skillCalls.push(loaded);
            }
          inventory.sdkSkills(invoked.skills);
        }
      } catch {
        inventory.skillFailure();
      } finally {
        clearTimeout(timer);
      }
    }
    output = final?.data?.content ?? output;
  } catch (error) {
    callFailed = true;
    callError = error;
  } finally {
    // The cumulative snapshot is the only monetary source. Capture even after a
    // failed send, while the session and its subscription are still available.
    if (session) {
      const budget = Math.max(
        0,
        Math.min(
          1000,
          (frame.config.timeoutMs as number | undefined) ?? 900_000,
          (frame.deadlineMs ?? Infinity) - Date.now() - 50,
        ),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const getMetrics = session.rpc?.usage?.getMetrics;
        if (!getMetrics) accounting.reason = "unsupported";
        else if (!budget) accounting.reason = "timeout";
        else {
          const timeout = Symbol("metrics timeout");
          const metrics = await Promise.race([
            Promise.resolve().then(() => getMetrics.call(session!.rpc!.usage)),
            new Promise<symbol>((resolve) => {
              timer = setTimeout(() => resolve(timeout), budget);
            }),
          ]);
          if (metrics === timeout) accounting.reason = "timeout";
          else
            accounting = sessionAccounting(
              metrics,
              !callFailed && !sessionError && !signal.aborted,
              frame.config.model,
            );
        }
      } catch {
        accounting.reason = "capture_failed";
      } finally {
        clearTimeout(timer);
      }
    }
    signal.removeEventListener("abort", abort);
    try {
      if (!observedIdle) inventory.incomplete("missing-session-idle");
      for (const id of observedAgentIds)
        if (!agentParents.has(id)) inventory.incomplete("subagent-lifecycle-unavailable");
      for (const id of observedParentIds)
        if (!subagents.has(id)) inventory.incomplete("subagent-lifecycle-unavailable");
      for (const child of subagents.values()) {
        if (child.active) inventory.incomplete("pending-subagents-at-shutdown");
        if (child.reported !== undefined && child.reported > child.observed)
          inventory.incomplete("missing-subagent-tool-events");
        else if (child.reported !== undefined && child.reported < child.observed)
          inventory.incomplete("subagent-tool-count-mismatch");
      }
      if (session) await session.disconnect();
    } catch (e) {
      cleanupErrors.push(e);
    }
    try {
      const errors = await client.stop();
      if (Array.isArray(errors) && errors.length) {
        inventory.incomplete("client-shutdown-failed");
        await client.forceStop();
      }
    } catch {
      inventory.incomplete("client-shutdown-failed");
      try {
        await client.forceStop();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      if (typeof unsubscribe === "function") unsubscribe();
    } catch (error) {
      cleanupErrors.push(error);
    }
    for (const id of tools)
      emit({
        version: 1,
        type: "tool",
        phase: "end",
        id,
        error: "Tool did not complete before session shutdown",
      });
  }
  const error = cleanupErrors.length
    ? "Copilot cleanup failed"
    : callFailed
      ? (callError instanceof Error ? callError.message : String(callError)) ||
        "Copilot execution failed"
      : sessionError;
  if ((callFailed || error || signal.aborted) && accounting.status === "complete") {
    accounting.status = "partial";
    accounting.reason = "execution_incomplete";
  }
  const cost = copilotUsageValue(accounting);
  if (callFailed || error || signal.aborted) inventory.incomplete("execution-incomplete");
  return {
    ...(error ? { error } : signal.aborted ? { error: "Copilot call aborted" } : {}),
    output,
    tokenUsage: usage,
    ...(cost === undefined ? {} : { cost }),
    metadata: {
      copilot: {
        sdkVersion: "1.0.22",
        skillSupport: true,
        accounting,
        premiumRequestUsage: {
          source: "assistant.usage",
          scope: "received-events",
          numRequests: usage.numRequests,
          ...(usage.numRequests && premiumCostComplete ? { reportedCost: premiumCost } : {}),
        },
      },
      skillCalls,
      toolInventory: inventory.finish(),
    },
  };
}
