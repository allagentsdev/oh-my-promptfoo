import { createHash } from "node:crypto";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
import type { JsonObject } from "./config.js";

export interface SkillCall {
  name: string;
  path: string;
  source: "read-tool" | "shell-read" | "sdk-skill-loader";
}

export interface ShellSkillRead {
  skill: SkillCall;
  cwd: string;
  bodyHash: string;
}

function fields(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// This is a literal-command recognizer, not a shell parser. Reject expansion,
// redirection, pipelines, comments, escapes and quote concatenation, even where
// some of those characters would be literal inside a particular shell's quotes.
function literalWords(command: string, powershell: boolean): string[] | undefined {
  if (/[\r\n\0$`;&|<>()[\]{}*?#!,]/.test(command) || (!powershell && command.includes("\\")))
    return;
  const words: string[] = [];
  let rest = command.trim();
  while (rest) {
    const match = /^(?:"([^"]*)"|'([^']*)'|([^\s'"]+))(?=[ \t]|$)/.exec(rest);
    if (!match) return;
    words.push(match[1] ?? match[2] ?? match[3]!);
    if (words.length > 8) return;
    rest = rest.slice(match[0].length).replace(/^[ \t]+/, "");
  }
  return words;
}

function literalPath(path: string, powershell: boolean): string | undefined {
  const native = powershell ? path.replace(/\\/g, sep) : path;
  // Resolving '..' first would hide traversal through a symlink from lstat.
  if (
    !native ||
    native.startsWith("-") ||
    native.startsWith("~") ||
    native.split(/[\\/]/).includes("..")
  )
    return;
  // Disallow PowerShell providers, drives on other platforms, and NTFS streams.
  if (native.replace(process.platform === "win32" ? /^[A-Za-z]:/ : /^$/, "").includes(":")) return;
  return native;
}

function containedShellDirectory(cwd: string, workingDir: string): boolean {
  let cursor = cwd;
  const root = resolve(workingDir);
  while (cursor !== root) {
    if (!lstatSync(cursor).isDirectory()) return false;
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
  return true;
}

/** Capture bounded local evidence at tool start; nothing is credited until completion. */
export function observedShellSkillRead(
  toolName: string,
  args: unknown,
  workingDir: string,
): ShellSkillRead | undefined {
  if (toolName !== "bash" && toolName !== "powershell") return;
  const input = fields(args);
  if (!input || typeof input.command !== "string" || input.command.length > 8192) return;
  const powershell = toolName === "powershell";
  // Admit the exact consumer pattern, but verify the full read output at completion:
  // '; ls' can succeed even if the preceding cat failed.
  const parts = powershell ? [input.command] : input.command.split(";");
  if (parts.length > 2) return;
  const words = literalWords(parts[0]!, powershell);
  if (!words) return;
  let path: string | undefined;
  if (!powershell) {
    if (words[0] !== "cat") return;
    if (words[1] === "--") words.splice(1, 1);
    if (words.length !== 2) return;
    path = words[1];
  } else {
    if (!/^get-content[ \t]/i.test(parts[0]!.trim())) return;
    if (words.shift()?.toLowerCase() !== "get-content") return;
    let raw = false;
    let pathOption = false;
    for (const word of words) {
      const option = word.toLowerCase();
      if (option === "-raw" && !raw) raw = true;
      else if ((option === "-path" || option === "-literalpath") && !pathOption && !path)
        pathOption = true;
      else if (!word.startsWith("-") && !path) path = word;
      else return;
    }
  }
  const nativePath = path && literalPath(path, powershell);
  if (!nativePath) return;
  // Never infer a persistent shell's current directory. Only the configured
  // working directory or an explicit, contained cwd is understood.
  if (
    input.workdir !== undefined ||
    input.workingDirectory !== undefined ||
    input.working_dir !== undefined
  )
    return;
  const requestedCwd = input.cwd === undefined ? "." : input.cwd;
  if (typeof requestedCwd !== "string") return;
  const nativeCwd = literalPath(requestedCwd, powershell);
  if (!nativeCwd) return;
  const cwd = resolve(workingDir, nativeCwd);
  const candidate = resolve(cwd, nativePath);
  const skill = observedSkillRead("read", { path: candidate }, workingDir);
  if (!skill) return;
  try {
    // Check cwd independently, including when the file argument is absolute.
    if (!containedShellDirectory(cwd, workingDir)) return;
    if (parts.length === 2) {
      const listing = literalWords(parts[1]!, false);
      const directory = listing?.[1] && literalPath(listing[1], false);
      if (
        listing?.length !== 2 ||
        listing[0] !== "ls" ||
        !directory ||
        resolve(cwd, directory) !== dirname(candidate)
      )
        return;
    }
    if (statSync(candidate).size > 1024 * 1024) return;
    const body = readFileSync(candidate, "utf8").replace(/\r\n/g, "\n");
    if (!body.trim()) return;
    return {
      skill: { ...skill, source: "shell-read" },
      cwd,
      bodyHash: createHash("sha256").update(body).digest("hex"),
    };
  } catch {
    return;
  }
}

/** Only model-facing output containing the complete unchanged file proves a read. */
export function completedShellSkillRead(
  read: ShellSkillRead,
  completion: unknown,
  workingDir: string,
): SkillCall | undefined {
  const data = fields(completion);
  const result = fields(data?.result);
  if (data?.success !== true || data.error || typeof result?.content !== "string") return;
  const execution = fields(data.shellExecution);
  if (data.shellExecution !== undefined && execution?.exitCode !== 0) return;
  if (result.contents !== undefined && !Array.isArray(result.contents)) return;
  let exited = execution?.exitCode === 0;
  let terminal = false;
  for (const value of (result.contents as unknown[] | undefined) ?? []) {
    const block = fields(value);
    if (block?.type !== "shell_exit" && block?.type !== "terminal") continue;
    terminal = true;
    if (block.exitCode !== undefined && block.exitCode !== 0) return;
    if (block.type === "shell_exit" && block.exitCode !== 0) return;
    exited ||= block.exitCode === 0;
    if (block.cwd !== undefined) {
      const cwd = typeof block.cwd === "string" && literalPath(block.cwd, true);
      if (!cwd || resolve(read.cwd, cwd) !== read.cwd) return;
    }
  }
  if (terminal && !exited) return;
  const local = observedSkillRead("read", { path: read.skill.path }, workingDir);
  if (!local) return;
  try {
    if (!containedShellDirectory(read.cwd, workingDir)) return;
    if (statSync(local.path).size > 1024 * 1024) return;
    const body = readFileSync(local.path, "utf8").replace(/\r\n/g, "\n");
    if (createHash("sha256").update(body).digest("hex") !== read.bodyHash) return;
    if (!result.content.replace(/\r\n/g, "\n").includes(body)) return;
    return read.skill;
  } catch {
    return;
  }
}
const skillParentDirectories: readonly string[] = [".agents", ".claude", ".github"];

export function workspaceSkillDirectories(workingDir: string): string[] {
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

export function observedSkillRead(
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
