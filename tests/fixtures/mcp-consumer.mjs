import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

async function connect(server, cwd) {
  const child = spawn(server.command, server.args, {
    cwd: server.workingDirectory ?? cwd,
    // Real SDK transports inherit the runtime environment. The package must enforce
    // the literal-only boundary even when the consumer merges it this way.
    env: { ...process.env, ...server.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let sequence = 0;
  const pending = new Map();
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const response = JSON.parse(line);
    const request = pending.get(response.id);
    pending.delete(response.id);
    if (response.error) request?.reject(Error(response.error.message));
    else request?.resolve(response.result);
  });
  const fail = (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", () => fail(Error(`MCP exited: ${stderr}`)));
  return {
    request(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill();
      await exited;
    },
  };
}
function scenario(prompt) {
  return prompt.startsWith("mcp:") ? JSON.parse(prompt.slice(4)) : {};
}

async function execute(connection, request, server) {
  await connection.request("initialize");
  const listing = await connection.request("tools/list");
  if (request.list) return JSON.stringify(listing.tools.map((tool) => tool.name));
  const result = await connection.request("tools/call", {
    name: request.tool ?? "search_code",
    arguments: { ...(request.arguments ?? { query: "fixtures" }), controlFile: server.args[1] },
  });
  if (!request.control) return result.content[0].text;
  return JSON.stringify({
    ...JSON.parse(result.content[0].text),
    control: {
      file: server.args[1],
      mode: (await stat(server.args[1])).mode & 0o777,
      args: server.args,
    },
  });
}

export class CopilotClient {
  async createSession(config) {
    let callback = () => {};
    let connection;
    return {
      rpc: {
        skills: {
          async getInvoked() {
            return { skills: [] };
          },
        },
      },
      on(fn) {
        callback = fn;
        return () => {
          callback = () => {};
        };
      },
      async sendAndWait({ prompt }) {
        const request = scenario(prompt);
        const serverName = request.server ?? "fixture";
        const server = config.mcpServers?.[serverName];
        if (config.enableConfigDiscovery !== false) throw Error("Config discovery enabled");
        if (request.permissions) {
          const permissions = await Promise.all(
            request.permissions.map((item) => config.onPermissionRequest({ kind: "mcp", ...item })),
          );
          callback({ type: "session.idle", data: {} });
          return { data: { content: JSON.stringify(permissions.map((item) => item.kind)) } };
        }
        if (!server) throw Error("Configured MCP server is unavailable");
        if (!request.bypassPermission && !request.list) {
          const permission = await config.onPermissionRequest({
            kind: "mcp",
            serverName,
            toolName: request.tool ?? "search_code",
          });
          if (permission.kind !== "approve-once") throw Error("Configured tool denied");
        }
        connection = await connect(server, config.workingDirectory);
        callback({
          type: "tool.execution_start",
          data: {
            toolCallId: "mcp-1",
            toolName: "fixture-search_code",
            mcpServerName: serverName,
            mcpToolName: request.tool ?? "search_code",
            arguments: { query: "fixtures" },
          },
        });
        const content = await execute(connection, request, server);
        callback({ type: "tool.execution_complete", data: { toolCallId: "mcp-1", success: true } });
        callback({ type: "assistant.message", data: { content } });
        callback({ type: "session.idle", data: {} });
        return { data: { content } };
      },
      async abort() {
        await connection?.close();
      },
      async disconnect() {
        callback = () => {};
        await connection?.close();
      },
    };
  }
  async stop() {
    return [];
  }
  async forceStop() {}
}

// A model-free SDK boundary executor: consume stock Promptfoo's effective tool
// availability/permissions and perform real native filesystem actions, rather
// than returning copied option arrays for tests to inspect.
async function nativeActions(options) {
  const enabled = (name) => !Array.isArray(options.tools) || options.tools.includes(name);
  const permitted = (name) => {
    if (!enabled(name) || options.disallowedTools?.includes(name)) return false;
    if (options.permissionMode === "plan" && name !== "Read") return false;
    if (options.permissionMode === "bypassPermissions") return true;
    if (options.allowedTools?.includes(name)) return true;
    if (name === "Read") return true;
    return options.permissionMode === "acceptEdits" && (name === "Write" || name === "Edit");
  };
  const result = { read: "denied", write: "denied", edit: "denied" };
  if (permitted("Read"))
    result.read = await readFile(join(options.cwd, ".eval-mocks/native.txt"), "utf8");
  if (permitted("Write")) {
    await writeFile(join(options.cwd, "native-write.txt"), "native write executed");
    result.write = await readFile(join(options.cwd, "native-write.txt"), "utf8");
  }
  if (permitted("Edit")) {
    await writeFile(join(options.cwd, "native-edit.txt"), "native edit executed");
    result.edit = await readFile(join(options.cwd, "native-edit.txt"), "utf8");
  }
  return result;
}

// Loaded by stock Promptfoo's real Claude provider, not a replacement provider.
export async function* query({ prompt, options }) {
  const request = scenario(prompt);
  if (options.strictMcpConfig !== true || options.settingSources?.length)
    throw Error("Claude config discovery enabled");
  const serverName = request.server ?? "fixture";
  const server = options.mcpServers?.[serverName];
  if (!server) throw Error("Configured MCP server is unavailable");
  const tool = request.tool ?? "search_code";
  const name = `mcp__${serverName}__${tool}`;
  if (
    !request.bypassPermission &&
    !request.list &&
    options.allowedTools &&
    !options.allowedTools.some((pattern) => pattern === name || pattern === `mcp__${serverName}__*`)
  )
    throw Error("Claude MCP tool was not allowed");
  const connection = await connect(server, options.cwd);
  const abort = () => {
    void connection.close();
  };
  options.abortController.signal.addEventListener("abort", abort, { once: true });
  try {
    yield {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "mcp-1", name, input: { query: "fixtures" } }] },
    };
    let content = await execute(connection, request, server);
    if (request.native)
      content = JSON.stringify({ ...JSON.parse(content), native: await nativeActions(options) });
    yield {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "mcp-1", content }] },
    };
    yield {
      type: "result",
      subtype: "success",
      result: content,
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
      session_id: "mcp-fixture",
      num_turns: 1,
      duration_ms: 1,
      duration_api_ms: 0,
    };
  } finally {
    options.abortController.signal.removeEventListener("abort", abort);
    await connection.close();
  }
}
