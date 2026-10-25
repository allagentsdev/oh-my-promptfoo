import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { destination, resolveWorkspaceTimeoutMs } from "../../workspace-core/src/config.js";
import type { WorkspaceSpec } from "../../workspace-core/src/types.js";

export type JsonObject = Record<string, unknown>;
export type DelegateId =
  | "openai:codex-sdk"
  | "anthropic:claude-agent-sdk"
  | "copilot-sdk"
  | "pi-sdk";
export interface McpServer {
  path: string;
  args?: string[];
  env?: Record<string, string>;
  tools?: string[];
  timeoutMs?: number;
}
export interface CodexDelegate {
  id: "openai:codex-sdk";
  env?: Record<string, string>;
  config?: JsonObject;
}
export interface ClaudeDelegate {
  id: "anthropic:claude-agent-sdk";
  env?: Record<string, string>;
  config?: JsonObject;
}
export interface CopilotDelegate {
  id: "copilot-sdk";
  env?: Record<string, string>;
  config?: Omit<CopilotSdkConfig, "working_dir" | "env">;
}
export interface PiDelegate {
  id: "pi-sdk";
  env?: Record<string, string>;
  config: {
    provider: string;
    model: string;
    apiKey?: string;
    baseUrl?: string;
    thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    permissions?: { filesystem?: "read" | "write"; shell?: "deny" | "allow" };
  };
}
export type Delegate = CodexDelegate | ClaudeDelegate | CopilotDelegate | PiDelegate;
export interface AgentConfig {
  delegate: Delegate;
  workspace: WorkspaceSpec;
  workspaceTimeoutMs?: number;
  workingDir?: string;
  fileChanges?: boolean;
  timeoutMs?: number;
}
export interface CopilotSdkConfig {
  working_dir: string;
  model?: string;
  reasoning_effort?: "low" | "medium" | "high";
  timeoutMs?: number;
  mcpServers?: Record<string, McpServer>;
  provider?: {
    type?: "openai" | "azure" | "anthropic";
    wireApi?: "completions" | "responses";
    baseUrl: string;
    apiKey?: string;
    wireModel?: string;
    azure?: { apiVersion?: string };
  };
  permissions?: {
    filesystem?: "read" | "write";
    shell?: "deny" | "allow";
    network?: "deny" | "allow";
  };
  env?: Record<string, string>;
}
export interface ProviderOptions {
  id?: string;
  config?: JsonObject;
  env?: Record<string, string | undefined>;
}
export function immutable<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

type Rule = "string" | "boolean" | "number" | "object" | "strings" | readonly string[];
// Graders retain the pre-passthrough closed schemas; candidates use native Promptfoo validation.
const graderCodex: Record<string, Rule> = {
  apiKey: "string",
  base_url: "string",
  maxRetries: "number",
  model: "string",
  model_provider: "string",
  sandbox_mode: ["read-only", "workspace-write", "danger-full-access"],
  model_reasoning_effort: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  network_access_enabled: "boolean",
  web_search_enabled: "boolean",
  web_search_mode: ["disabled", "cached", "live"],
  collaboration_mode: ["coding", "plan"],
  approval_policy: ["never", "on-request", "on-failure", "untrusted"],
  output_schema: "object",
  enable_streaming: "boolean",
  deep_tracing: "boolean",
};
const graderClaude: Record<string, Rule> = {
  apiKey: "string",
  apiKeyRequired: "boolean",
  model: "string",
  fallback_model: "string",
  max_turns: "number",
  max_thinking_tokens: "number",
  max_budget_usd: "number",
  permission_mode: ["default", "plan", "acceptEdits", "bypassPermissions", "dontAsk", "auto"],
  allow_dangerously_skip_permissions: "boolean",
  custom_system_prompt: "string",
  append_system_prompt: "string",
  custom_allowed_tools: "strings",
  append_allowed_tools: "strings",
  allow_all_tools: "boolean",
  disallowed_tools: "strings",
  output_format: "object",
  include_partial_messages: "boolean",
  include_hook_events: "boolean",
  forward_subagent_text: "boolean",
  mcpServers: "object",
};
const copilot: Record<string, Rule> = {
  model: "string",
  reasoning_effort: ["low", "medium", "high"],
  timeoutMs: "number",
  mcpServers: "object",
};
const pi: Record<string, Rule> = {
  provider: "string",
  model: "string",
  apiKey: "string",
  baseUrl: "string",
  thinkingLevel: ["off", "minimal", "low", "medium", "high", "xhigh"],
  permissions: "object",
};

const workspaceOwned = "the provider owns the per-row workspace";
const sessionOwned = "the provider owns per-row session isolation";
const environmentOwned = "the provider owns the CLI environment; use delegate.env";
const nativeOwned: Partial<Record<DelegateId, Record<string, string>>> = {
  "openai:codex-sdk": {
    working_dir: workspaceOwned,
    copy_working_dir: workspaceOwned,
    skip_git_repo_check: workspaceOwned,
    thread_id: sessionOwned,
    persist_threads: sessionOwned,
    thread_pool_size: sessionOwned,
    inherit_process_env: environmentOwned,
    cli_env: environmentOwned,
  },
  "anthropic:claude-agent-sdk": {
    working_dir: workspaceOwned,
    resume: sessionOwned,
    fork_session: sessionOwned,
    resume_session_at: sessionOwned,
    continue: sessionOwned,
    session_id: sessionOwned,
    persist_session: sessionOwned,
    env: environmentOwned,
  },
};

export function object(value: unknown, path: string): JsonObject {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error(`${path} must be a plain object`);
  return value as JsonObject;
}
export function closed(value: unknown, keys: string[], path: string): JsonObject {
  const result = object(value, path);
  for (const key of Object.keys(result))
    if (!keys.includes(key)) throw new Error(`${path}.${key} is not supported`);
  return result;
}
function fields(value: unknown, rules: Record<string, Rule>, path: string): JsonObject {
  const result = closed(value, Object.keys(rules), path);
  for (const [key, v] of Object.entries(result)) {
    const rule = rules[key];
    if (Array.isArray(rule)) {
      if (!rule.includes(v as string)) throw new Error(`${path}.${key} has an unsupported value`);
    } else if (rule === "object") object(v, `${path}.${key}`);
    else if (rule === "strings") {
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
        throw new Error(`${path}.${key} must be an array of strings`);
    } else if (
      typeof v !== rule ||
      (rule === "number" && (!Number.isFinite(v) || (v as number) < 0))
    )
      throw new Error(`${path}.${key} must be ${rule}`);
  }
  return result;
}
export function validateEnv(value: unknown, path = "env"): Record<string, string> {
  const env = object(value, path);
  for (const [key, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof v !== "string")
      throw new Error(`${path} must map environment names to strings`);
    const canonical = key.toUpperCase();
    if (
      canonical.startsWith("ALLAGENTS_") ||
      [
        "NODE_OPTIONS",
        "NODE_PATH",
        "BUN_OPTIONS",
        "LD_PRELOAD",
        "LD_LIBRARY_PATH",
        "DYLD_INSERT_LIBRARIES",
        "PATH",
        "HOME",
        "TMPDIR",
      ].includes(canonical)
    )
      throw new Error(`${path}.${key} is reserved`);
  }
  return env as Record<string, string>;
}
function validateMcpServers(value: unknown, id: DelegateId): void {
  const servers = object(value, "delegate.config.mcpServers");
  if (id === "anthropic:claude-agent-sdk") {
    const namespaces = new Set(Object.keys(servers));
    for (const name of namespaces) {
      for (
        let separator = name.indexOf("__");
        separator >= 0;
        separator = name.indexOf("__", separator + 1)
      ) {
        if (namespaces.has(name.slice(0, separator)))
          throw new Error(
            "Claude MCP servers have ambiguous tool namespaces: a server name cannot prefix another followed by '__'",
          );
      }
    }
  }
  for (const [name, entry] of Object.entries(servers)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name))
      throw new Error("MCP server names must use 1–64 letters, numbers, underscores or hyphens");
    const path = `delegate.config.mcpServers.${name}`;
    const server = fields(
      entry,
      { path: "string", args: "strings", env: "object", tools: "strings", timeoutMs: "number" },
      path,
    );
    destination(server.path);
    if (server.args && (server.args as string[]).some((arg) => arg.includes("\0")))
      throw new Error(`${path}.args must not contain NUL`);
    if (server.tools && (server.tools as string[]).some((tool) => !tool || /[\s\0]/.test(tool)))
      throw new Error(`${path}.tools must contain nonempty tool names`);
    if (server.env !== undefined) {
      const env = validateEnv(server.env, `${path}.env`);
      for (const [key, literal] of Object.entries(env)) {
        if (
          literal.includes("\0") ||
          /(?:\bBearer\s+\S+|\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|https?:\/\/[^\s/]+:[^\s/@]+@)/i.test(
            literal,
          )
        )
          throw new Error(`${path}.env.${key} must not contain secret-shaped credentials or NUL`);
      }
    }
    if (
      server.timeoutMs !== undefined &&
      (!Number.isSafeInteger(server.timeoutMs) || (server.timeoutMs as number) <= 0)
    )
      throw new Error(`${path}.timeoutMs must be a positive safe integer`);
  }
}
function validateEndpoint(value: unknown): void {
  const p = fields(
    value,
    {
      type: ["openai", "azure", "anthropic"],
      wireApi: ["completions", "responses"],
      baseUrl: "string",
      apiKey: "string",
      wireModel: "string",
      azure: "object",
    },
    "provider",
  );
  if (typeof p.baseUrl !== "string" || !p.baseUrl) throw new Error("provider.baseUrl is required");
  let u: URL;
  try {
    u = new URL(p.baseUrl);
  } catch {
    throw new Error("provider.baseUrl must be an absolute HTTP(S) endpoint");
  }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    throw new Error("provider.baseUrl must be HTTP(S) without embedded credentials");
  if (p.azure !== undefined) fields(p.azure, { apiVersion: "string" }, "provider.azure");
}
export function validateDelegateConfig(
  id: DelegateId,
  value: unknown,
  scope: "candidate" | "grader" = "candidate",
): JsonObject {
  const owned = scope === "candidate" ? nativeOwned[id] : undefined;
  let config: JsonObject;
  if (owned) {
    config = object(value, "delegate.config");
    for (const key of Object.keys(config)) {
      if (Object.hasOwn(owned, key))
        throw new Error(`delegate.config.${key} is owned by the provider: ${owned[key]}`);
    }
  } else {
    const rules =
      id === "openai:codex-sdk"
        ? graderCodex
        : id === "anthropic:claude-agent-sdk"
          ? { ...graderClaude, tools: "object" as Rule }
          : id === "pi-sdk"
            ? pi
            : { ...copilot, provider: "object" as Rule, permissions: "object" as Rule };
    if (
      id === "anthropic:claude-agent-sdk" &&
      Array.isArray(object(value, "delegate.config").tools)
    ) {
      config = fields(value, { ...rules, tools: "strings" }, "delegate.config");
    } else config = fields(value, rules, "delegate.config");
  }
  if (config.mcpServers !== undefined) validateMcpServers(config.mcpServers, id);
  if (
    id === "anthropic:claude-agent-sdk" &&
    config.tools !== undefined &&
    !Array.isArray(config.tools)
  ) {
    const tools = closed(config.tools, ["type", "preset"], "delegate.config.tools");
    if (tools.type !== "preset" || tools.preset !== "claude_code")
      throw new Error("delegate.config.tools must use the claude_code preset");
  }
  if (id === "anthropic:claude-agent-sdk" && Array.isArray(config.tools)) {
    if (config.tools.some((tool) => typeof tool !== "string"))
      throw new Error("delegate.config.tools must be an array of strings");
  }
  if (owned) return config;
  if (id === "copilot-sdk") {
    if (
      config.timeoutMs !== undefined &&
      ((config.timeoutMs as number) <= 0 || (config.timeoutMs as number) > 2_147_483_647)
    )
      throw new Error("timeoutMs must fit a positive Node timer");
    if (config.provider !== undefined) validateEndpoint(config.provider);
    if (config.permissions !== undefined)
      fields(
        config.permissions,
        { filesystem: ["read", "write"], shell: ["deny", "allow"], network: ["deny", "allow"] },
        "permissions",
      );
  }
  if (id === "pi-sdk") {
    for (const key of ["provider", "model"])
      if (config[key] !== undefined && !(config[key] as string).trim())
        throw new Error(`delegate.config.${key} must be nonempty`);
    if (config.permissions !== undefined)
      fields(
        config.permissions,
        { filesystem: ["read", "write"], shell: ["deny", "allow"] },
        "permissions",
      );
  }
  for (const key of ["timeoutMs", "maxRetries", "max_turns", "max_thinking_tokens"])
    if (config[key] !== undefined && !Number.isSafeInteger(config[key]))
      throw new Error(`delegate.config.${key} must be an integer`);
  for (const key of ["base_url", "baseUrl"])
    if (config[key] !== undefined) {
      let url: URL;
      try {
        url = new URL(config[key] as string);
      } catch {
        throw new Error(`${key} must be an HTTP(S) URL`);
      }
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
        throw new Error(`${key} must not contain credentials`);
    }
  return config;
}
export function validateDelegate(value: unknown): Delegate {
  const d = closed(value, ["id", "config", "env"], "delegate");
  if (
    !["openai:codex-sdk", "anthropic:claude-agent-sdk", "copilot-sdk", "pi-sdk"].includes(
      d.id as string,
    )
  )
    throw new Error(
      "delegate.id must select openai:codex-sdk, anthropic:claude-agent-sdk, copilot-sdk, or pi-sdk",
    );
  const id = d.id as DelegateId;
  const config = validateDelegateConfig(id, d.config ?? {});
  if (id === "pi-sdk")
    for (const key of ["provider", "model"])
      if (typeof config[key] !== "string" || !(config[key] as string).trim())
        throw new Error(`delegate.config.${key} is required for pi-sdk`);
  return {
    id,
    config,
    ...(d.env !== undefined ? { env: validateEnv(d.env, "delegate.env") } : {}),
  } as Delegate;
}
export function envelope(options: ProviderOptions): { config: JsonObject; basePath: string } {
  const raw = object(options.config ?? {}, "config");
  const { basePath, ...config } = raw;
  if (basePath !== undefined && typeof basePath !== "string")
    throw new Error("Loader basePath must be a string");
  return { config, basePath: resolve((basePath as string | undefined) ?? process.cwd()) };
}
/**
 * Resolves relative source paths as Promptfoo resolves `file://` references: against the
 * loader basePath, which is the eval config's directory even when the provider comes from a
 * separate `providers: file://…` file. Absolute paths and `file:///` or `file://localhost/`
 * URLs are unchanged; validation of the result is left to the workspace specification.
 * See docs/adr/0010-resolve-provider-paths-against-the-eval-config.md.
 */
export function resolveSourcePaths(workspace: WorkspaceSpec, basePath: string): WorkspaceSpec {
  const sources: unknown = workspace.sources;
  if (!Array.isArray(sources)) return workspace;
  return {
    ...workspace,
    sources: sources.map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
      const source = raw as JsonObject;
      if (
        source.type === "local" &&
        typeof source.path === "string" &&
        source.path &&
        !isAbsolute(source.path)
      )
        return { ...source, path: resolve(basePath, source.path) };
      if (
        source.type === "git" &&
        typeof source.repository === "string" &&
        source.repository.startsWith("file://")
      ) {
        const path = source.repository.slice("file://".length);
        // URL hosts are case-insensitive: `file://LOCALHOST/abs` is as absolute as `file:///abs`.
        if (path && !isAbsolute(path) && !/^localhost(\/|$)/i.test(path))
          return { ...source, repository: pathToFileURL(resolve(basePath, path)).href };
      }
      return raw;
    }) as WorkspaceSpec["sources"],
  };
}
export function validateAgentConfig(value: unknown): AgentConfig {
  const c = closed(
    value,
    ["delegate", "workspace", "workspaceTimeoutMs", "workingDir", "fileChanges", "timeoutMs"],
    "config",
  );
  if (c.workingDir !== undefined) {
    try {
      destination(c.workingDir);
    } catch {
      throw new Error("config.workingDir must be a normalized contained relative path");
    }
  }
  if (c.fileChanges !== undefined && typeof c.fileChanges !== "boolean")
    throw new Error("config.fileChanges must be boolean");
  if (c.workspaceTimeoutMs !== undefined) resolveWorkspaceTimeoutMs(c.workspaceTimeoutMs);
  if (
    c.timeoutMs !== undefined &&
    (!Number.isSafeInteger(c.timeoutMs) ||
      (c.timeoutMs as number) <= 0 ||
      (c.timeoutMs as number) > 2_147_483_647)
  )
    throw new Error("config.timeoutMs must be a positive integer");
  object(c.workspace, "workspace");
  return { ...c, delegate: validateDelegate(c.delegate) } as unknown as AgentConfig;
}
export function validateCopilotConfig(value: unknown): CopilotSdkConfig {
  const c = closed(
    value,
    [
      "working_dir",
      "model",
      "reasoning_effort",
      "timeoutMs",
      "provider",
      "permissions",
      "env",
      "mcpServers",
    ],
    "config",
  );
  if (typeof c.working_dir !== "string" || !c.working_dir)
    throw new Error("config.working_dir is required");
  const { working_dir, env, ...rest } = c;
  validateDelegateConfig("copilot-sdk", rest);
  if (env !== undefined) validateEnv(env);
  return {
    working_dir,
    ...rest,
    ...(env !== undefined ? { env } : {}),
  } as CopilotSdkConfig;
}
export function promptConfig(context: unknown, id: DelegateId, original: JsonObject): JsonObject {
  const ctx = context as { prompt?: { config?: unknown } } | undefined;
  if (ctx?.prompt?.config === undefined) return original;
  // Promptfoo forwards grading metadata alongside generation overrides.
  const supplied = object(ctx.prompt.config, "prompt.config");
  const p = closed(
    Object.fromEntries(
      Object.entries(supplied).filter(
        ([key, value]) => key !== "provider" && key !== "rubricPrompt" && value !== undefined,
      ),
    ),
    ["delegate"],
    "prompt.config",
  );
  if (p.delegate === undefined) return original;
  const d = closed(p.delegate, ["config"], "prompt.config.delegate");
  if (d.config && Object.hasOwn(object(d.config, "prompt.config.delegate.config"), "timeoutMs"))
    throw new Error("prompt.config.delegate.config.timeoutMs is constructor-only");
  return validateDelegateConfig(id, { ...original, ...validateDelegateConfig(id, d.config ?? {}) });
}
