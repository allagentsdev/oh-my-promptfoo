import { resolve } from "node:path";
import { destination } from "../../workspace-core/src/config.js";
import type { WorkspaceSpec } from "../../workspace-core/src/types.js";

export type JsonObject = Record<string, unknown>;
export type DelegateId = "openai:codex-sdk" | "anthropic:claude-agent-sdk" | "copilot-sdk";
export interface CodexDelegate {
  id: "openai:codex-sdk";
  env?: Record<string, string>;
  config?: {
    apiKey?: string;
    base_url?: string;
    maxRetries?: number;
    model?: string;
    model_provider?: string;
    sandbox_mode?: "read-only" | "workspace-write" | "danger-full-access";
    model_reasoning_effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
    network_access_enabled?: boolean;
    web_search_enabled?: boolean;
    web_search_mode?: "disabled" | "cached" | "live";
    collaboration_mode?: "coding" | "plan";
    approval_policy?: "never" | "on-request" | "on-failure" | "untrusted";
    output_schema?: JsonObject;
    enable_streaming?: boolean;
    deep_tracing?: boolean;
  };
}
export interface ClaudeDelegate {
  id: "anthropic:claude-agent-sdk";
  env?: Record<string, string>;
  config?: {
    apiKey?: string;
    apiKeyRequired?: boolean;
    model?: string;
    fallback_model?: string;
    max_turns?: number;
    max_thinking_tokens?: number;
    max_budget_usd?: number;
    permission_mode?: "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk" | "auto";
    allow_dangerously_skip_permissions?: boolean;
    custom_system_prompt?: string;
    append_system_prompt?: string;
    tools?: string[] | { type: "preset"; preset: "claude_code" };
    custom_allowed_tools?: string[];
    append_allowed_tools?: string[];
    allow_all_tools?: boolean;
    disallowed_tools?: string[];
    output_format?: JsonObject;
    include_partial_messages?: boolean;
    include_hook_events?: boolean;
    forward_subagent_text?: boolean;
  };
}
export interface CopilotDelegate {
  id: "copilot-sdk";
  env?: Record<string, string>;
  config?: Omit<CopilotSdkProviderConfig, "working_dir" | "env">;
}
export type Delegate = CodexDelegate | ClaudeDelegate | CopilotDelegate;
export interface ProviderConfig {
  delegate: Delegate;
  workspace: WorkspaceSpec;
  workingDir?: string;
  fileChanges?: boolean;
  timeoutMs?: number;
}
export interface CopilotSdkProviderConfig {
  working_dir: string;
  model?: string;
  reasoning_effort?: "low" | "medium" | "high";
  timeoutMs?: number;
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
const codex: Record<string, Rule> = {
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
const claude: Record<string, Rule> = {
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
};
const copilot: Record<string, Rule> = {
  model: "string",
  reasoning_effort: ["low", "medium", "high"],
  timeoutMs: "number",
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
    if (
      key.startsWith("ALLAGENTS_") ||
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
      ].includes(key)
    )
      throw new Error(`${path}.${key} is reserved`);
  }
  return env as Record<string, string>;
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
export function validateDelegateConfig(id: DelegateId, value: unknown): JsonObject {
  const rules =
    id === "openai:codex-sdk"
      ? codex
      : id === "anthropic:claude-agent-sdk"
        ? { ...claude, tools: "object" as Rule }
        : { ...copilot, provider: "object" as Rule, permissions: "object" as Rule };
  let config: JsonObject;
  if (
    id === "anthropic:claude-agent-sdk" &&
    Array.isArray(object(value, "delegate.config").tools)
  ) {
    config = fields(value, { ...rules, tools: "strings" }, "delegate.config");
  } else config = fields(value, rules, "delegate.config");
  if (
    id === "anthropic:claude-agent-sdk" &&
    config.tools !== undefined &&
    !Array.isArray(config.tools)
  ) {
    const tools = closed(config.tools, ["type", "preset"], "delegate.config.tools");
    if (tools.type !== "preset" || tools.preset !== "claude_code")
      throw new Error("delegate.config.tools must use the claude_code preset");
  }
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
  for (const key of ["timeoutMs", "maxRetries", "max_turns", "max_thinking_tokens"])
    if (config[key] !== undefined && !Number.isSafeInteger(config[key]))
      throw new Error(`delegate.config.${key} must be an integer`);
  for (const key of ["base_url"])
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
  if (!["openai:codex-sdk", "anthropic:claude-agent-sdk", "copilot-sdk"].includes(d.id as string))
    throw new Error(
      "delegate.id must select openai:codex-sdk, anthropic:claude-agent-sdk, or copilot-sdk",
    );
  const id = d.id as DelegateId;
  return {
    id,
    config: validateDelegateConfig(id, d.config ?? {}),
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
export function validateProviderConfig(value: unknown): ProviderConfig {
  const c = closed(
    value,
    ["delegate", "workspace", "workingDir", "fileChanges", "timeoutMs"],
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
  if (
    c.timeoutMs !== undefined &&
    (!Number.isSafeInteger(c.timeoutMs) ||
      (c.timeoutMs as number) <= 0 ||
      (c.timeoutMs as number) > 2_147_483_647)
  )
    throw new Error("config.timeoutMs must be a positive integer");
  object(c.workspace, "workspace");
  return { ...c, delegate: validateDelegate(c.delegate) } as unknown as ProviderConfig;
}
export function validateCopilotConfig(value: unknown): CopilotSdkProviderConfig {
  const c = closed(
    value,
    ["working_dir", "model", "reasoning_effort", "timeoutMs", "provider", "permissions", "env"],
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
  } as CopilotSdkProviderConfig;
}
export function promptConfig(context: unknown, id: DelegateId, original: JsonObject): JsonObject {
  const ctx = context as { prompt?: { config?: unknown } } | undefined;
  if (ctx?.prompt?.config === undefined) return original;
  // Stock Promptfoo adds absent test options as undefined own properties.
  const supplied = object(ctx.prompt.config, "prompt.config");
  const p = closed(
    Object.fromEntries(Object.entries(supplied).filter(([, value]) => value !== undefined)),
    ["delegate"],
    "prompt.config",
  );
  if (p.delegate === undefined) return original;
  const d = closed(p.delegate, ["config"], "prompt.config.delegate");
  if (d.config && Object.hasOwn(object(d.config, "prompt.config.delegate.config"), "timeoutMs"))
    throw new Error("prompt.config.delegate.config.timeoutMs is constructor-only");
  return validateDelegateConfig(id, { ...original, ...validateDelegateConfig(id, d.config ?? {}) });
}
