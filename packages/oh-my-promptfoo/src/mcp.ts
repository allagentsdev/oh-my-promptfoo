import { existsSync } from "node:fs";
import { realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonObject, McpServer } from "./config.js";
import { withinReadRoot } from "./grader-policy.js";
import type { CallFrame } from "./protocol.js";

export interface ResolvedMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  tools?: string[];
  timeoutMs?: number;
}

function launcherPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const built = join(here, "mcp-launcher.js");
  if (existsSync(built)) return built;
  const entries = process.env.OH_MY_PROMPTFOO_TEST_ENTRIES;
  if (entries && existsSync(join(here, "mcp.ts"))) return join(entries, "mcp-launcher.js");
  throw new Error("MCP launcher is missing; build or reinstall oh-my-promptfoo");
}

/** Roots are supplied by the workspace owner, never by authored delegate configuration. */
export async function resolveMcpServers(frame: CallFrame): Promise<ResolvedMcpServer[]> {
  const configured = frame.config.mcpServers as Record<string, McpServer> | undefined;
  if (!configured || !Object.keys(configured).length) return [];
  if (frame.readOnly) throw new Error("Read-only graders cannot configure mcpServers");
  const directory = frame.mcpConfigDir;
  if (!directory) throw new Error("MCP requires an owned private configuration directory");
  const roots = await Promise.all(
    (frame.mcpRoots ?? [frame.workingDir]).map(async (root) => {
      if (typeof root !== "string" || !isAbsolute(root))
        throw new Error("Invalid trusted MCP root");
      const physical = await realpath(root);
      if (!(await stat(physical)).isDirectory()) throw new Error("Invalid trusted MCP root");
      return physical;
    }),
  );
  const servers: ResolvedMcpServer[] = [];
  for (const [name, server] of Object.entries(configured)) {
    const entry = await realpath(resolve(frame.workingDir, server.path));
    if (!roots.some((root) => withinReadRoot(root, entry)))
      throw new Error(`MCP server ${name} must stay inside the workspace or a protected source`);
    if (!(await stat(entry)).isFile()) throw new Error(`MCP server ${name} must be a regular file`);
    const env = server.env ?? {};
    const payload = JSON.stringify({ ...server, path: entry, cwd: frame.workingDir, env });
    if (Buffer.byteLength(payload) > 16 * 1024 * 1024)
      throw new Error("MCP configuration exceeds its bound");
    const configFile = join(directory, `${servers.length}.json`);
    await writeFile(configFile, payload, { mode: 0o600, flag: "wx" });
    servers.push({
      name,
      command: process.execPath,
      // Both SDKs merge inherited environment into stdio children. The launcher is
      // the literal-env boundary and supplies Claude's missing per-server filters/timeouts.
      args: [launcherPath(), configFile],
      env,
      cwd: frame.workingDir,
      ...(server.tools !== undefined ? { tools: server.tools } : {}),
      ...(server.timeoutMs !== undefined ? { timeoutMs: server.timeoutMs } : {}),
    });
  }
  return servers;
}

export function mcpToolAllowed(server: Pick<McpServer, "tools">, tool: unknown): boolean {
  return (
    typeof tool === "string" &&
    (server.tools === undefined || server.tools.includes("*") || server.tools.includes(tool))
  );
}

export function copilotMcpOptions(servers: ResolvedMcpServer[]): JsonObject {
  return Object.fromEntries(
    servers.map(({ name, command, args, env, cwd, tools, timeoutMs }) => [
      name,
      {
        type: "stdio",
        command,
        args,
        env,
        workingDirectory: cwd,
        tools: tools ?? ["*"],
        ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
      },
    ]),
  );
}

export function claudeMcpOptions(config: JsonObject, servers: ResolvedMcpServer[]): JsonObject {
  const { mcpServers: _authored, ...rest } = config;
  const allowed = servers.flatMap(({ name, tools }) =>
    (tools ?? ["*"]).map((tool) => `mcp__${name}__${tool}`),
  );
  // Promptfoo forbids append + custom, and allow_all_tools + either. Preserve the
  // existing native tool policy; the launcher enforces MCP filters in every mode.
  const permissionTools =
    rest.allow_all_tools === true
      ? {}
      : Object.hasOwn(rest, "custom_allowed_tools")
        ? {
            custom_allowed_tools: [
              ...new Set([...(rest.custom_allowed_tools as string[]), ...allowed]),
            ],
          }
        : {
            append_allowed_tools: [
              ...new Set([...((rest.append_allowed_tools ?? []) as string[]), ...allowed]),
            ],
          };
  return {
    ...rest,
    ...permissionTools,
    strict_mcp_config: true,
    setting_sources: [],
    mcp: {
      enabled: true,
      servers: servers.map(({ name, command, args, env }) => ({ name, command, args, env })),
    },
  };
}

export function nativeMcpAttributes(
  attributes: JsonObject,
  servers: ResolvedMcpServer[],
): JsonObject {
  const name = attributes["gen_ai.tool.name"];
  if (typeof name !== "string") return {};
  // Validation excludes ambiguous Claude prefixes while allowing isolated '__' names.
  const server = servers.find(({ name: serverName }) => name.startsWith(`mcp__${serverName}__`));
  if (!server) return {};
  const tool = name.slice(`mcp__${server.name}__`.length);
  return tool
    ? {
        "gen_ai.tool.mcp.server": server.name,
        "gen_ai.tool.mcp.tool": tool,
        ...(attributes["gen_ai.tool.call.arguments"] === undefined &&
        typeof attributes["tool.input"] === "string"
          ? { "gen_ai.tool.call.arguments": attributes["tool.input"] }
          : {}),
      }
    : {};
}

export function copilotMcpAttributes(data: JsonObject): JsonObject {
  const server = data.mcpConfigServerName ?? data.mcpServerName;
  if (typeof server !== "string") return {};
  let tool = data.mcpToolName ?? data.toolName;
  if (typeof tool !== "string") return {};
  if (data.mcpToolName === undefined) {
    const prefix = [`mcp__${server}__`, `mcp_${server}_`].find((value) =>
      (tool as string).startsWith(value),
    );
    if (prefix) tool = tool.slice(prefix.length);
  }
  return { "gen_ai.tool.mcp.server": server, "gen_ai.tool.mcp.tool": tool };
}
