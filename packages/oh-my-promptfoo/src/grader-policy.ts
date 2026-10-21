import { existsSync } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
    permission_mode: "default",
    tools: [...READ_TOOLS],
    // Explicitly empty: bare tool names auto-allow before can_use_tool runs.
    custom_allowed_tools: [],
    allow_all_tools: false,
    allow_dangerously_skip_permissions: false,
    disallowed_tools: [
      ...new Set([...DENIED_TOOLS, ...((config.disallowed_tools ?? []) as string[])]),
    ],
  };
}

export function withinReadRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** The grader may read the live workspace and declared protected source targets only. */
export async function graderReadScope(workingDir: string, sourceRoots: string[]) {
  const roots = await Promise.all(
    [workingDir, ...sourceRoots.map((source) => resolve(workingDir, source))].map((path) =>
      realpath(path),
    ),
  );
  return async (path: unknown): Promise<boolean> => {
    if (typeof path !== "string" || !path || path.includes("\0")) return false;
    try {
      const physical = await realpath(resolve(workingDir, path));
      return roots.some((root) => withinReadRoot(root, physical));
    } catch {
      return false;
    }
  };
}

export async function claudeReadAllowed(
  tool: string,
  input: unknown,
  allowed: (path: unknown) => Promise<boolean>,
): Promise<boolean> {
  if (!READ_TOOLS.includes(tool) || !input || typeof input !== "object" || Array.isArray(input))
    return false;
  const args = input as JsonObject;
  if (tool === "Read") return allowed(args.file_path);
  const searchRoot = args.path === undefined ? "." : args.path;
  if (!(await allowed(searchRoot))) return false;
  if (tool === "Glob") {
    if (
      typeof args.pattern !== "string" ||
      args.pattern.includes("\0") ||
      isAbsolute(args.pattern) ||
      args.pattern.split(/[\\/]/).includes("..")
    )
      return false;
    // Glob may make its literal directory prefix the search root. Checking only
    // input.path would let `outside-link/**` choose an undeclared symlink target.
    const directories = args.pattern.split(/[\\/]/).slice(0, -1);
    const firstMagic = directories.findIndex((part) => /[*?[{}()!]/.test(part));
    const literal = directories.slice(0, firstMagic < 0 ? directories.length : firstMagic);
    if (literal.length && !(await allowed(join(searchRoot as string, ...literal)))) return false;
  }
  return true;
}

/** Codex discovers skills even in untrusted projects; disable them by canonical file path. */
export async function disabledWorkspaceSkills(workingDir: string, sourceRoots: string[]) {
  const allowed = await graderReadScope(workingDir, sourceRoots);
  const disabled: { path: string; enabled: false }[] = [];
  const visited = new Set<string>();
  async function visit(path: string): Promise<void> {
    let physical: string;
    try {
      physical = await realpath(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!(await allowed(physical)))
      throw new Error(
        "Codex workspace skills must stay inside the workspace or declared protected sources",
      );
    if (visited.has(physical)) return;
    visited.add(physical);
    for (const entry of await readdir(physical, { withFileTypes: true })) {
      const candidate = resolve(physical, entry.name);
      if (entry.name === "SKILL.md" && (entry.isFile() || entry.isSymbolicLink())) {
        if (!(await allowed(candidate)))
          throw new Error(
            "Codex workspace skills must stay inside the workspace or declared protected sources",
          );
        disabled.push({ path: await realpath(candidate), enabled: false });
      } else if (entry.isDirectory()) await visit(candidate);
      else if (entry.isSymbolicLink()) {
        try {
          await visit(candidate);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
        }
      }
    }
  }
  for (const parent of [".agents", ".codex"]) await visit(resolve(workingDir, parent, "skills"));
  return disabled;
}

export function workspaceReaderPath(): string {
  const here = typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));
  const built = join(here, "workspace-reader.js");
  if (existsSync(built)) return built;
  const source = join(here, "workspace-reader.ts");
  if (process.versions.bun && existsSync(source)) return source;
  throw new Error("Workspace reader is missing; build or reinstall oh-my-promptfoo");
}
