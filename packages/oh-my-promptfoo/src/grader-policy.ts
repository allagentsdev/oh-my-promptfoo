import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type DelegateId, type JsonObject, validateDelegateConfig } from "./config.js";

export const READ_TOOLS = ["Read", "Glob", "Grep"];
const DENIED_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "TaskOutput",
  "TaskStop",
  "Skill",
  "ToolSearch",
  "EnterWorktree",
];

/** Validate before starting a session, rather than silently ignoring unsafe intent. */
export function graderConfig(id: DelegateId, input: JsonObject): JsonObject {
  const config = validateDelegateConfig(id, input);
  const reject = (field: string): never => {
    throw new Error(
      `Agent assertion grader.config.${field} cannot weaken the read-only grader policy`,
    );
  };
  if (id === "copilot-sdk") {
    const permissions = (config.permissions ?? {}) as JsonObject;
    for (const [key, safe] of Object.entries({
      filesystem: "read",
      shell: "deny",
      network: "deny",
    }))
      if (permissions[key] !== undefined && permissions[key] !== safe) reject(`permissions.${key}`);
    return { ...config, permissions: { filesystem: "read", shell: "deny", network: "deny" } };
  }
  if (id === "openai:codex-sdk") {
    for (const [key, safe] of Object.entries({
      sandbox_mode: "read-only",
      approval_policy: "never",
      network_access_enabled: false,
      web_search_enabled: false,
      web_search_mode: "disabled",
      deep_tracing: false,
    }))
      if (config[key] !== undefined && config[key] !== safe) reject(key);
    return {
      ...config,
      sandbox_mode: "read-only",
      approval_policy: "never",
      network_access_enabled: false,
      web_search_enabled: false,
      web_search_mode: "disabled",
    };
  }
  if (config.allow_all_tools === true) reject("allow_all_tools");
  if (config.allow_dangerously_skip_permissions === true)
    reject("allow_dangerously_skip_permissions");
  if (
    config.permission_mode !== undefined &&
    !["default", "plan", "dontAsk"].includes(config.permission_mode as string)
  )
    reject("permission_mode");
  for (const key of ["tools", "custom_allowed_tools", "append_allowed_tools"]) {
    const tools = config[key];
    if (
      tools !== undefined &&
      (!Array.isArray(tools) || tools.some((tool) => !READ_TOOLS.includes(tool)))
    )
      reject(key);
  }
  for (const key of ["custom_system_prompt", "append_system_prompt"])
    if (config[key] !== undefined) reject(key);
  const { append_allowed_tools: _append, ...rest } = config;
  return {
    ...rest,
    permission_mode: "dontAsk",
    tools: [...READ_TOOLS],
    custom_allowed_tools: [...READ_TOOLS],
    allow_all_tools: false,
    allow_dangerously_skip_permissions: false,
    disallowed_tools: [
      ...new Set([...DENIED_TOOLS, ...((config.disallowed_tools ?? []) as string[])]),
    ],
  };
}

export function workspaceReaderPath(): string {
  const here = typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));
  const built = join(here, "workspace-reader.js");
  if (existsSync(built)) return built;
  const source = join(here, "workspace-reader.ts");
  if (process.versions.bun && existsSync(source)) return source;
  throw new Error("Workspace reader is missing; build or reinstall oh-my-promptfoo");
}
