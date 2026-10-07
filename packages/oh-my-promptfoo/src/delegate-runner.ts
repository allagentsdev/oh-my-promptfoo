import { lstatSync, readFileSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { context as otelContext, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { closed, type JsonObject, object, validateDelegateConfig, validateEnv } from "./config.js";
import {
  type CallFrame,
  jsonSafe,
  MAX_FRAME_BYTES,
  redact,
  resolvePeer,
  secrets,
} from "./protocol.js";

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
// Native Promptfoo agent spans are collected in this child, then replayed on the
// host's row trace. No unconfigured exporter or separate root trace is created.
const tracerProvider = new NodeTracerProvider({
  spanProcessors: [
    {
      onStart(span, parentContext) {
        if (terminal) return;
        emit({
          version: 1,
          type: "tool",
          phase: "start",
          id: `native:${span.spanContext().spanId}`,
          name: redact(span.name, sensitive),
          startTime: span.startTime,
          parentId: `native:${trace.getSpan(parentContext)?.spanContext().spanId ?? ""}`,
          attributes: JSON.parse(redact(jsonSafe(span.attributes), sensitive)),
        });
      },
      onEnd(span) {
        if (terminal) return;
        const id = `native:${span.spanContext().spanId}`;
        const attributes: JsonObject = {};
        for (const [key, value] of Object.entries(span.attributes))
          if (value !== undefined)
            attributes[key] = typeof value === "string" ? redact(value, sensitive) : value;
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
tracerProvider.register({
  contextManager: new AsyncLocalStorageContextManager(),
  propagator: new W3CTraceContextPropagator(),
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
  let error: unknown;
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
      ],
      "call",
    );
    if (
      !["openai:codex-sdk", "anthropic:claude-agent-sdk", "copilot-sdk"].includes(
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
    const carrier: Record<string, string> = {};
    for (const key of ["traceparent", "tracestate"])
      if (typeof frame.context[key] === "string") carrier[key] = frame.context[key] as string;
    const extracted = propagation.extract(otelContext.active(), carrier);
    response = await otelContext.with(extracted, () =>
      frame.delegate === "copilot-sdk"
        ? runCopilot(frame, controller.signal)
        : runNative(frame, controller.signal),
    );
    jsonSafe(response);
  } catch (e) {
    error = e;
  }
  await tracerProvider.forceFlush();
  await tracerProvider.shutdown();
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
      });
  } catch (e) {
    emit({ version: 1, type: "error", error: redact((e as Error).message, sensitive) });
  }
  process.stdin.destroy();
  // Cleanup already finished. The parent kills any orphaned descendants after close.
  process.exitCode = 0;
}
async function runNative(frame: CallFrame, signal: AbortSignal): Promise<JsonObject> {
  const peer = await import(pathToFileURL(resolvePeer(frame.basePath, "promptfoo")).href);
  const load = peer.loadApiProvider ?? peer.default?.loadApiProvider;
  if (typeof load !== "function")
    throw new Error("The consumer Promptfoo peer does not export loadApiProvider");
  // Native providers may retain conversation caches: every runner handles exactly one row.
  const config = {
    ...frame.config,
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
  const provider = await load(frame.delegate, {
    basePath: frame.basePath,
    options: { config, env: process.env },
  });
  let response: JsonObject;
  try {
    response = await provider.callApi(
      frame.prompt,
      { ...frame.context, bustCache: true },
      { abortSignal: signal },
    );
  } finally {
    if (typeof provider.cleanup === "function") await provider.cleanup();
  }
  return response;
}

interface SessionLike {
  rpc?: {
    skills?: { getInvoked?: () => Promise<{ skills: unknown }> };
  };
  on(callback: (event: { type: string; data: JsonObject }) => void): (() => void) | undefined;
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
interface SkillCall {
  name: string;
  path: string;
  source: "read-tool" | "sdk-skill-loader";
}
const skillParentDirectories: readonly string[] = [".agents", ".claude", ".github"];

function workspaceSkillDirectories(workingDir: string): string[] {
  const directories: string[] = [];
  for (const name of skillParentDirectories) {
    const parent = resolve(workingDir, name);
    const skills = resolve(parent, "skills");
    try {
      if (lstatSync(parent).isDirectory() && lstatSync(skills).isDirectory())
        directories.push(skills);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return directories;
}

function observedSkillRead(
  toolName: string,
  args: unknown,
  workingDir: string,
): SkillCall | undefined {
  if (
    !["read", "read_file", "view"].includes(toolName) ||
    !args ||
    typeof args !== "object" ||
    Array.isArray(args)
  )
    return;
  const fields = args as JsonObject;
  const path = fields.path ?? fields.file_path ?? fields.filePath;
  if (typeof path !== "string" || !path || basename(path) !== "SKILL.md") return;
  const candidate = resolve(workingDir, path);
  const skillDirectory = dirname(candidate);
  const skillsDirectory = dirname(skillDirectory);
  if (
    basename(skillsDirectory) !== "skills" ||
    !skillParentDirectories.includes(basename(dirname(skillsDirectory)))
  )
    return;
  try {
    const rootPath = resolve(workingDir);
    const root = statSync(rootPath, { bigint: true });
    if (root.ino === 0n) return;
    let cursor = candidate;
    let file = true;
    while (true) {
      const info = lstatSync(cursor, { bigint: true });
      // Workspace Provider may bind its verified working directory to a protected source link.
      const allowedAlias = info.isSymbolicLink() && cursor === rootPath;
      if ((info.isSymbolicLink() && !allowedAlias) || (file && !info.isFile())) return;
      const physical = allowedAlias ? statSync(cursor, { bigint: true }) : info;
      if (physical.dev === root.dev && physical.ino === root.ino)
        return { name: basename(skillDirectory), path: candidate, source: "read-tool" };
      const parent = dirname(cursor);
      if (parent === cursor) return;
      cursor = parent;
      file = false;
    }
  } catch {
    return;
  }
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
    if (!body || body !== content.replace(/\r\n/g, "\n").trim()) return;
    return { ...local, source: "sdk-skill-loader" };
  } catch {
    return;
  }
}
async function runCopilot(frame: CallFrame, signal: AbortSignal): Promise<JsonObject> {
  const sdk = await import(pathToFileURL(resolvePeer(frame.basePath, "@github/copilot-sdk")).href);
  if (typeof sdk.CopilotClient !== "function")
    throw new Error("Install the supported @github/copilot-sdk@1.0.17 peer");
  const skillDirectories = workspaceSkillDirectories(frame.workingDir);
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
  let cost = 0,
    events = 0,
    eventBytes = 0;
  let result: JsonObject | undefined;
  let callError: unknown;
  const cleanupErrors: unknown[] = [];
  const tools = new Set<string>();
  const skillReads = new Map<string, SkillCall>();
  const skillCalls: SkillCall[] = [];
  const permissions = (frame.config.permissions ?? {}) as JsonObject;
  const approve = (request: JsonObject): JsonObject => {
    const allowed =
      request.kind === "read" ||
      (request.kind === "write" && permissions.filesystem === "write") ||
      (request.kind === "shell" && permissions.shell === "allow") ||
      (request.kind === "url" && permissions.network === "allow");
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
      ...(frame.config.model ? { model: frame.config.model } : {}),
      ...(frame.config.reasoning_effort ? { reasoningEffort: frame.config.reasoning_effort } : {}),
      ...(frame.config.provider ? { provider: frame.config.provider } : {}),
      onPermissionRequest: approve,
      enableConfigDiscovery: false,
      // Keep general config discovery off; expose only physical workspace skill directories.
      ...(skillDirectories.length ? { enableSkills: true, skillDirectories } : {}),
      infiniteSessions: { enabled: false },
    });
    unsubscribe = session.on((event) => {
      try {
        events++;
        eventBytes += Buffer.byteLength(JSON.stringify(event));
        if (events > 100_000 || eventBytes > MAX_FRAME_BYTES) {
          sessionError = "Copilot event stream exceeds its bound";
          abort();
          return;
        }
        const data = event.data;
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
          cost += typeof data.cost === "number" ? data.cost : 0;
        } else if (event.type === "session.error")
          sessionError = typeof data.message === "string" ? data.message : "Copilot session failed";
        else if (
          event.type === "tool.execution_start" &&
          typeof data.toolCallId === "string" &&
          typeof data.toolName === "string"
        ) {
          if (tools.has(data.toolCallId)) throw new Error("Duplicate Copilot tool identity");
          tools.add(data.toolCallId);
          if (!data.mcpServerName) {
            const skillRead = observedSkillRead(data.toolName, data.arguments, frame.workingDir);
            if (skillRead) skillReads.set(data.toolCallId, skillRead);
          }
          emit({
            version: 1,
            type: "tool",
            phase: "start",
            id: data.toolCallId,
            name: redact(data.toolName, sensitive),
            attributes: {
              ...(data.arguments
                ? { "gen_ai.tool.call.arguments": redact(jsonSafe(data.arguments), sensitive) }
                : {}),
            },
          });
        } else if (
          event.type === "tool.execution_complete" &&
          typeof data.toolCallId === "string" &&
          tools.delete(data.toolCallId)
        ) {
          const skillRead = skillReads.get(data.toolCallId);
          skillReads.delete(data.toolCallId);
          if (skillRead && data.success === true) skillCalls.push(skillRead);
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
      { prompt: frame.prompt },
      (frame.config.timeoutMs as number | undefined) ?? 900_000,
    );
    if (signal.aborted) throw new Error("Copilot call aborted");
    if (!sessionError) {
      try {
        const invoked = await session.rpc?.skills?.getInvoked?.();
        if (Array.isArray(invoked?.skills) && invoked.skills.length) {
          for (const entry of invoked.skills) {
            const loaded = verifiedSkillLoaderRecord(entry, frame.workingDir);
            if (loaded) skillCalls.push(loaded);
          }
        }
      } catch {
        // Experimental SDK inventory is optional; explicit read-tool evidence remains valid.
      }
    }
    if (sessionError)
      result = { error: sessionError, ...(output ? { output } : {}), tokenUsage: usage, cost };
    else {
      output = final?.data?.content ?? output;
      result = {
        output,
        tokenUsage: usage,
        cost,
        metadata: {
          copilot: { sdkVersion: "1.0.17", skillSupport: true },
          skillCalls,
        },
      };
    }
  } catch (error) {
    callError = error;
  } finally {
    signal.removeEventListener("abort", abort);
    if (typeof unsubscribe === "function") unsubscribe();
    for (const id of tools)
      emit({
        version: 1,
        type: "tool",
        phase: "end",
        id,
        error: "Tool did not complete before session shutdown",
      });
    try {
      if (session) await session.disconnect();
    } catch (e) {
      cleanupErrors.push(e);
    }
    try {
      const errors = await client.stop();
      if (Array.isArray(errors) && errors.length) await client.forceStop();
    } catch {
      try {
        await client.forceStop();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      [...(callError ? [callError] : []), ...cleanupErrors],
      "Copilot cleanup failed",
    );
  if (callError) throw callError;
  if (!result) throw new Error("Copilot session returned no result");
  return result;
}
