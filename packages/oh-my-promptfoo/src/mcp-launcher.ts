import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import type { Writable } from "node:stream";
import type { McpServer } from "./config.js";
import { mcpToolAllowed } from "./mcp.js";

// Private process entry: the runner alone constructs this payload after realpath
// containment. Never accept a command, transport, shell flag or inherited env here.
const configFile = process.argv[2]!;
if (statSync(configFile).size > 16 * 1024 * 1024)
  throw new Error("MCP configuration exceeds its bound");
const server = JSON.parse(readFileSync(configFile, "utf8")) as McpServer & { cwd: string };
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_PENDING = 1024;
const pending = new Map<
  string | number,
  { method: string; timer?: ReturnType<typeof setTimeout> }
>();
// The private pipe is owned by the launcher and monitored on a separate thread:
// EOF must kill the whole process even when the suite script blocks its main loop.
// Wait for an actual byte through fd3 before importing any user code, rather than
// treating successful Worker construction as proof that the inherited pipe works.
const guard = `
const {Socket}=require('node:net');
const {parentPort}=require('node:worker_threads');
const stop=()=>process.kill(process.pid,'SIGKILL');
process.on('uncaughtException',stop);
const pipe=new Socket({fd:3,readable:true,writable:false});
let ready=false;
pipe.on('data',chunk=>{
  if(ready||chunk.length!==1||chunk[0]!==1){stop();return;}
  ready=true;
  parentPort.postMessage('ready');
});
pipe.on('end',stop);
pipe.on('close',stop);
pipe.on('error',stop);
pipe.resume();`;
// Node/Windows may add env defaults. Scrub before both Worker and suite startup.
// Do not inherit --import in the guard Worker, which would recursively preload it.
const preload = `
import{readFileSync}from'node:fs';
import{Worker}from'node:worker_threads';
const{env}=JSON.parse(readFileSync(${JSON.stringify(configFile)},'utf8'));
for(const key of Object.keys(process.env))delete process.env[key];
Object.assign(process.env,env);
const guard=new Worker(${JSON.stringify(guard)},{eval:true,execArgv:[]});
guard.on('error',()=>process.kill(process.pid,'SIGKILL'));
await new Promise(resolve=>guard.once('message',resolve));
guard.unref();`;
const child = spawn(
  process.execPath,
  [
    "--import",
    `data:text/javascript,${encodeURIComponent(preload)}`,
    server.path,
    ...(server.args ?? []),
  ],
  {
    cwd: server.cwd,
    env: server.env ?? {},
    // A private fd3 pipe, not main-thread IPC, survives until launcher teardown.
    stdio: ["pipe", "pipe", "inherit", "pipe"],
    windowsHide: true,
  },
);
const lifeline = child.stdio[3] as Writable;
lifeline.on("error", () => child.kill("SIGKILL"));
lifeline.write(Buffer.from([1]));
const input = child.stdin!;
const output = child.stdout!;
let closing = false;
let escalation: ReturnType<typeof setTimeout> | undefined;
function close(): void {
  if (closing) return;
  closing = true;
  process.stdin.destroy();
  for (const request of pending.values()) clearTimeout(request.timer);
  pending.clear();
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    escalation = setTimeout(() => child.kill("SIGKILL"), 500);
  }
}
function fail(): void {
  process.exitCode = 1;
  close();
}
process.on("SIGTERM", close);
process.on("SIGINT", close);
process.stdin.on("end", close);
process.stdin.on("error", fail);
process.stdout.on("error", fail);
child.on("error", fail);
input.on("error", fail);
output.on("error", fail);
child.on("close", (code) => {
  const wasClosing = closing;
  close();
  clearTimeout(escalation);
  if (!wasClosing) process.exitCode = code ?? 1;
});

function replyError(id: string | number, message: string): void {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } })}\n`,
  );
}
function toolTimer(id: string | number, timeoutMs: number): ReturnType<typeof setTimeout> {
  const started = Date.now();
  const tick = (): void => {
    const left = timeoutMs - (Date.now() - started);
    if (left > 0) {
      const request = pending.get(id);
      if (request) request.timer = setTimeout(tick, Math.min(left, 2_147_483_647));
      return;
    }
    replyError(id, "MCP tool exceeded configured timeoutMs");
    // Terminate rather than allow timed-out work to mutate fixture state later.
    close();
  };
  return setTimeout(tick, Math.min(timeoutMs, 2_147_483_647));
}
interface RpcMessage {
  jsonrpc: string;
  id?: string | number;
  method?: string;
  params?: { name?: unknown };
  result?: { tools?: { name?: unknown }[] };
}

function lines(
  stream: NodeJS.ReadableStream,
  consume: (message: RpcMessage, line: string) => void,
): void {
  let buffer = Buffer.alloc(0);
  let used = 0;
  stream.on("data", (chunk: Buffer) => {
    if (closing) return;
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset);
      const stop = end < 0 ? chunk.length : end;
      const required = used + stop - offset;
      if (required > MAX_BYTES) {
        fail();
        return;
      }
      if (required > buffer.length) {
        const capacity = Math.min(MAX_BYTES, Math.max(required, buffer.length * 2, 4096));
        const next = Buffer.allocUnsafe(capacity);
        buffer.copy(next, 0, 0, used);
        buffer = next;
      }
      chunk.copy(buffer, used, offset, stop);
      used = required;
      if (end < 0) break;
      const line = buffer.toString("utf8", 0, used);
      used = 0;
      try {
        const message = JSON.parse(line);
        if (
          !message ||
          typeof message !== "object" ||
          Array.isArray(message) ||
          message.jsonrpc !== "2.0" ||
          (message.method !== undefined &&
            (typeof message.method !== "string" || message.method.length > 256))
        )
          throw new Error("Invalid MCP JSON-RPC message");
        consume(message, line);
      } catch {
        fail();
        return;
      }
      if (closing) return;
      offset = end + 1;
    }
  });
  stream.on("end", () => {
    if (used) fail();
  });
}

lines(process.stdin, (message, line) => {
  const id = message.id;
  if (
    message.method &&
    id !== undefined &&
    ((typeof id !== "string" && typeof id !== "number") ||
      (typeof id === "string" && id.length > 1024) ||
      (typeof id === "number" && !Number.isFinite(id)) ||
      pending.has(id) ||
      pending.size >= MAX_PENDING)
  )
    throw new Error("Invalid or excessive MCP requests");
  if (message.method === "tools/call") {
    if (id === undefined) return; // Tool invocations are requests, not notifications.
    if (!mcpToolAllowed(server, message.params?.name)) {
      replyError(id, "MCP tool is not configured in tools allow-list");
      return;
    }
  }
  if (message.method && id !== undefined) {
    const request: { method: string; timer?: ReturnType<typeof setTimeout> } = {
      method: message.method,
    };
    pending.set(id, request);
    if (message.method === "tools/call" && server.timeoutMs !== undefined)
      request.timer = toolTimer(id, server.timeoutMs);
  }
  if (!input.write(`${line}\n`)) process.stdin.pause();
});
input.on("drain", () => process.stdin.resume());
lines(output, (message, line) => {
  const request =
    message.method === undefined && message.id !== undefined ? pending.get(message.id) : undefined;
  if (request) {
    clearTimeout(request.timer);
    pending.delete(message.id!);
    if (request.method === "tools/list" && Array.isArray(message.result?.tools)) {
      message.result.tools = message.result.tools.filter((tool: { name?: unknown }) =>
        mcpToolAllowed(server, tool.name),
      );
      line = JSON.stringify(message);
    }
  }
  if (!process.stdout.write(`${line}\n`)) output.pause();
});
process.stdout.on("drain", () => output.resume());
