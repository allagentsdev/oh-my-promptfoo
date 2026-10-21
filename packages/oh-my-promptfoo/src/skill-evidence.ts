import { lstatSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { JsonObject } from "./config.js";

export interface SkillCall {
  name: string;
  path: string;
  source: "read-tool" | "sdk-skill-loader";
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
