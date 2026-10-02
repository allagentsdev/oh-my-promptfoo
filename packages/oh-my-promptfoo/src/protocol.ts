import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type Attributes,
  context as otelContext,
  propagation,
  type Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { resolve as resolveImport } from "import-meta-resolve";
import { closed, type DelegateId, type JsonObject, object, validateEnv } from "./config.js";

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_STDERR_BYTES = 64 * 1024;
export const SHUTDOWN_GRACE_MS = 1500;
export interface CallFrame {
  version: 1;
  type: "call";
  delegate: DelegateId;
  basePath: string;
  workingDir: string;
  config: JsonObject;
  prompt: string;
  context: JsonObject;
  delegateEnvKeys?: string[];
}
export interface TraceFrame {
  version: 1;
  type: "tool";
  phase: "start" | "end";
  id: string;
  name?: string;
  attributes?: JsonObject;
  error?: string;
}
export type RunnerFrame =
  | { version: 1; type: "result"; response: JsonObject }
  | { version: 1; type: "error"; error: string }
  | TraceFrame;

export function jsonSafe(value: unknown, maxBytes = MAX_FRAME_BYTES): string {
  const seen = new Set<object>();
  function check(v: unknown, depth: number): void {
    if (depth > 100) throw new Error("JSON nesting exceeds the protocol limit");
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    if (typeof v !== "object" || !v) throw new Error("Value is not JSON-safe");
    if (seen.has(v)) throw new Error("Circular protocol value");
    if (
      !Array.isArray(v) &&
      Object.getPrototypeOf(v) !== Object.prototype &&
      Object.getPrototypeOf(v) !== null
    )
      throw new Error("Unsupported binary or non-plain protocol value");
    seen.add(v);
    if (Object.getOwnPropertySymbols(v).length)
      throw new Error("Symbol protocol keys are unsupported");
    if (Array.isArray(v)) for (const x of v) check(x, depth + 1);
    else
      for (const key of Object.keys(v)) {
        const descriptor = Object.getOwnPropertyDescriptor(v, key);
        if (!descriptor || !("value" in descriptor))
          throw new Error("Protocol getters are unsupported");
        // Optional native fields with undefined values represent absent JSON keys.
        // Array holes/undefined, functions, and every other lossy value still fail.
        if (descriptor.value !== undefined) check(descriptor.value, depth + 1);
      }
    seen.delete(v);
  }
  check(value, 0);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > maxBytes)
    throw new Error("Serialized protocol value exceeds the byte limit");
  return encoded;
}
export function wireContext(input: unknown): JsonObject {
  if (!input) return { bustCache: true };
  const c = input as JsonObject;
  const result: JsonObject = { bustCache: true };
  for (const key of [
    "vars",
    "debug",
    "traceparent",
    "tracestate",
    "evaluationId",
    "testId",
    "testIdx",
    "promptIdx",
    "repeatIndex",
  ])
    if (c[key] !== undefined) result[key] = c[key];
  if (c.test) {
    const test = c.test as JsonObject;
    result.test = Object.fromEntries(
      ["metadata", "description"].filter((k) => test[k] !== undefined).map((k) => [k, test[k]]),
    );
  }
  if (c.prompt) {
    const prompt = c.prompt as JsonObject;
    result.prompt = Object.fromEntries(
      ["raw", "label"].filter((k) => prompt[k] !== undefined).map((k) => [k, prompt[k]]),
    );
  }
  const carrier: Record<string, string> = {};
  propagation.inject(otelContext.active(), carrier);
  for (const key of ["traceparent", "tracestate"]) if (carrier[key]) result[key] = carrier[key];
  jsonSafe(result);
  return result;
}
export function secrets(config: JsonObject, env: Record<string, string>): string[] {
  const result = Object.entries(env)
    .filter(([k]) => /KEY|TOKEN|SECRET|PASSWORD|AUTH|HEADERS/i.test(k))
    .map(([, v]) => v);
  for (const [key, value] of Object.entries(env))
    if (/HEADERS/i.test(key)) {
      for (const header of value.split(",")) {
        const idx = header.indexOf("=");
        if (idx > 0) {
          try {
            result.push(decodeURIComponent(header.slice(idx + 1)));
          } catch {
            result.push(header.slice(idx + 1));
          }
        }
      }
    }
  function visit(v: unknown): void {
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v))
      if (/apiKey|token|password|secret/i.test(k) && typeof x === "string") result.push(x);
      else visit(x);
  }
  visit(config);
  return [...new Set(result.filter(Boolean))].sort((a, b) => b.length - a.length);
}
export function redact(value: string, sensitive: string[]): string {
  let result = value;
  for (const secret of sensitive) {
    result = result.split(secret).join("[REDACTED]");
    result = result.split(JSON.stringify(secret).slice(1, -1)).join("[REDACTED]");
    result = result.split(encodeURIComponent(secret)).join("[REDACTED]");
  }
  return result.replace(/(https?:\/\/)[^\s/]+:[^\s/@]+@/g, "$1[REDACTED]@");
}
export function minimalEnvironment(env: Record<string, string>): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SYSTEMROOT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_PROTOCOL",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_SERVICE_NAME",
    "OTEL_RESOURCE_ATTRIBUTES",
    "PROMPTFOO_OTEL_ENABLED",
    "PROMPTFOO_OTEL_OTLP_HTTP_ENDPOINT",
  ])
    if (process.env[key]) output[key] = process.env[key];
  return { ...output, ...env, PROMPTFOO_DISABLE_TELEMETRY: "1", PROMPTFOO_CACHE_ENABLED: "false" };
}
function runnerPath(): string {
  const here = typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));
  const built = join(here, "delegate-runner.js");
  if (existsSync(built)) return built;
  const source = join(here, "delegate-runner.ts");
  if (process.versions.bun && existsSync(source)) return source;
  throw new Error("Delegate runner is missing; build or reinstall oh-my-promptfoo");
}
export function resolvePeer(basePath: string, name: string): string {
  try {
    // Native peers are imported by URL; honor their import conditions from the
    // evaluation project rather than resolving an incompatible CommonJS branch.
    return fileURLToPath(
      resolveImport(name, pathToFileURL(join(basePath, "__allagents_peer__.mjs")).href),
    );
  } catch {
    throw new Error(
      `Install ${name}${name === "@github/copilot-sdk" ? "@1.0.6" : "@0.122.0"} in the evaluation project (${basePath})`,
    );
  }
}
export async function runDelegate(
  frame: CallFrame,
  env: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<JsonObject> {
  if (signal?.aborted) throw new Error("Delegate call aborted before execution");
  validateEnv(env, "delegate.env");
  const encoded = jsonSafe({ ...frame, delegateEnvKeys: Object.keys(env).sort() });
  const childEnvironment = minimalEnvironment(env);
  const sensitive = secrets(
    frame.config,
    Object.fromEntries(
      Object.entries(childEnvironment).filter(([, v]) => v !== undefined),
    ) as Record<string, string>,
  );
  const child = spawn(process.execPath, [runnerPath()], {
    // Native SDK discovery uses the consumer cwd; the adapter separately forces
    // working_dir to the isolated workspace for all agent operations.
    cwd: frame.delegate === "copilot-sdk" ? frame.workingDir : frame.basePath,
    env: childEnvironment,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const spans = new Map<string, Span>();
  const parentContext = propagation.extract(otelContext.active(), {
    ...(typeof frame.context.traceparent === "string"
      ? { traceparent: frame.context.traceparent }
      : {}),
    ...(typeof frame.context.tracestate === "string"
      ? { tracestate: frame.context.tracestate }
      : {}),
  });
  let stdout = Buffer.alloc(0),
    stderr = "",
    stderrBytes = 0;
  let terminal: RunnerFrame | undefined,
    failure: Error | undefined,
    stopping = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let completionGrace: ReturnType<typeof setTimeout> | undefined;
  function killGroup(sig: NodeJS.Signals): void {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill(sig);
      else process.kill(-child.pid, sig);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH")
        failure ??= new Error("Unable to terminate delegate process group");
    }
  }
  function stop(error: Error): void {
    failure ??= error;
    if (stopping) return;
    stopping = true;
    child.stdin.write('{"version":1,"type":"abort"}\n', () => {});
    killGroup("SIGTERM");
    escalation = setTimeout(() => killGroup("SIGKILL"), SHUTDOWN_GRACE_MS);
  }
  const abort = () => stop(new Error("Delegate call aborted"));
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => stop(new Error(`Delegate exceeded timeout of ${timeoutMs} ms`)),
    timeoutMs,
  );
  child.stdin.on("error", () => {});
  child.once("exit", () => killGroup("SIGKILL"));
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = Buffer.concat([stdout, chunk]);
    if (stdout.length > MAX_FRAME_BYTES) {
      stop(new Error("Delegate frame exceeds the byte limit"));
      return;
    }
    while (true) {
      const newline = stdout.indexOf(10);
      if (newline < 0) break;
      const line = stdout.subarray(0, newline).toString("utf8");
      stdout = stdout.subarray(newline + 1);
      try {
        const f = object(JSON.parse(line), "runner frame");
        if (f.version !== 1) throw new Error("Unsupported delegate protocol version");
        if (terminal) throw new Error("Duplicate or post-terminal delegate frame");
        if (f.type === "result") {
          closed(f, ["version", "type", "response"], "result frame");
          object(f.response, "delegate response");
          jsonSafe(f.response);
          terminal = f as unknown as RunnerFrame;
          completionGrace = setTimeout(
            () => stop(new Error("Delegate did not exit after its terminal frame")),
            SHUTDOWN_GRACE_MS,
          );
        } else if (f.type === "error") {
          closed(f, ["version", "type", "error"], "error frame");
          if (typeof f.error !== "string") throw new Error("Malformed delegate error");
          terminal = f as unknown as RunnerFrame;
          completionGrace = setTimeout(
            () => stop(new Error("Delegate did not exit after its terminal frame")),
            SHUTDOWN_GRACE_MS,
          );
        } else if (f.type === "tool") {
          closed(
            f,
            [
              "version",
              "type",
              "phase",
              "id",
              "name",
              "attributes",
              "error",
              "parentId",
              "startTime",
              "endTime",
            ],
            "tool frame",
          );
          if (typeof f.id !== "string") throw new Error("Malformed tool identity");
          for (const key of ["startTime", "endTime"])
            if (
              f[key] !== undefined &&
              (!Array.isArray(f[key]) ||
                (f[key] as unknown[]).length !== 2 ||
                (f[key] as unknown[]).some((x) => !Number.isSafeInteger(x) || (x as number) < 0))
            )
              throw new Error("Malformed span timestamp");
          const nativeAttrs: Attributes = {};
          if (f.attributes)
            for (const [k, v] of Object.entries(object(f.attributes, "tool attributes"))) {
              if (typeof v === "string") nativeAttrs[k] = redact(v, sensitive);
              else if (typeof v === "number" || typeof v === "boolean" || Array.isArray(v))
                nativeAttrs[k] = JSON.parse(redact(jsonSafe(v), sensitive)) as Attributes[string];
              else nativeAttrs[k] = redact(jsonSafe(v), sensitive);
            }
          if (f.phase === "start") {
            if (spans.has(f.id) || typeof f.name !== "string")
              throw new Error("Duplicate or malformed tool start");
            const attrs: Attributes = f.id.startsWith("native:")
              ? {}
              : { "gen_ai.tool.name": redact(f.name, sensitive), "gen_ai.tool.call.id": f.id };
            Object.assign(attrs, nativeAttrs);
            const parentSpan = typeof f.parentId === "string" ? spans.get(f.parentId) : undefined;
            spans.set(
              f.id,
              trace.getTracer("oh-my-promptfoo").startSpan(
                f.id.startsWith("native:")
                  ? redact(f.name, sensitive)
                  : `execute_tool ${attrs["gen_ai.tool.name"]}`,
                {
                  attributes: attrs,
                  ...(f.startTime ? { startTime: f.startTime as [number, number] } : {}),
                },
                parentSpan ? trace.setSpan(parentContext, parentSpan) : parentContext,
              ),
            );
          } else if (f.phase === "end") {
            const span = spans.get(f.id);
            if (!span) throw new Error("Tool end without start");
            if (f.error)
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: redact(String(f.error), sensitive),
              });
            span.setAttributes(nativeAttrs);
            span.end(f.endTime as [number, number] | undefined);
            spans.delete(f.id);
          } else throw new Error("Malformed tool phase");
        } else throw new Error("Unknown delegate frame");
      } catch (e) {
        stop(new Error(`Invalid delegate protocol: ${(e as Error).message}`));
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= MAX_STDERR_BYTES) stderr += chunk.toString("utf8");
    else stop(new Error("Delegate stderr exceeds the byte limit"));
  });
  child.stdin.write(`${encoded}\n`);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        if (code !== 0 && !failure)
          failure = new Error(`Delegate runner exited with ${code}: ${stderr}`);
        resolve();
      });
    });
    // Descendants can outlive their runner even after a valid terminal response.
    killGroup("SIGKILL");
    if (stdout.length) throw new Error("Delegate emitted an unterminated protocol frame");
    if (failure) throw failure;
    if (!terminal) throw new Error(`Delegate runner exited without a terminal frame: ${stderr}`);
    if (terminal.type === "error") throw new Error(terminal.error);
    if (terminal.type !== "result") throw new Error("Delegate terminal frame is invalid");
    if (terminal.response.cached === true)
      throw new Error("Delegate returned a cached response; workspace calls require execution");
    return JSON.parse(redact(jsonSafe(terminal.response), sensitive)) as JsonObject;
  } catch (error) {
    throw new Error(redact(error instanceof Error ? error.message : String(error), sensitive));
  } finally {
    clearTimeout(timer);
    clearTimeout(escalation);
    clearTimeout(completionGrace);
    signal?.removeEventListener("abort", abort);
    for (const span of spans.values()) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: "Delegate terminated" });
      span.end();
    }
  }
}
