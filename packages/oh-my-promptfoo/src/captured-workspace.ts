import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { hash } from "../../workspace-core/src/fs.js";
import { object } from "./config.js";

const READ_LIMIT = 16 * 1024 * 1024;

export interface WorkspaceContext {
  providerResponse?: { metadata?: unknown };
}
export function workspacePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")
  )
    throw new Error(
      "Workspace paths must be nonempty relative POSIX paths without traversal or .git components",
    );
  return value;
}

/** Changed-file snapshots are authoritative; retained files cover unchanged paths only. */
export class CapturedWorkspace {
  readonly changes: Record<string, unknown>;
  readonly files: Record<string, unknown>;
  readonly deleted: string[];
  readonly root: unknown;
  constructor(context?: WorkspaceContext) {
    const metadata = object(context?.providerResponse?.metadata, "providerResponse.metadata");
    this.changes = object(metadata.fileChanges, "providerResponse.metadata.fileChanges");
    if (
      this.changes.schemaVersion !== 2 ||
      !["complete", "truncated"].includes(String(this.changes.status))
    )
      throw new Error(
        "Workspace assertions require a successful schemaVersion 2 fileChanges capture",
      );
    if (this.changes.truncated !== (this.changes.status === "truncated"))
      throw new Error("Contradictory workspace capture status");
    this.files = object(this.changes.changedFiles, "fileChanges.changedFiles");
    if (
      !Array.isArray(this.changes.deletedFiles) ||
      this.changes.deletedFiles.some((path) => typeof path !== "string")
    )
      throw new Error("fileChanges.deletedFiles must be an array of paths");
    this.deleted = this.changes.deletedFiles as string[];
    this.root = metadata.workspace && object(metadata.workspace, "metadata.workspace").path;
  }
  async read(path: string): Promise<Buffer | undefined> {
    workspacePath(path);
    if (Object.hasOwn(this.files, path)) {
      const file = object(this.files[path], `captured file ${path}`);
      if (this.deleted.includes(path)) throw new Error(`Conflicting capture for ${path}`);
      if (file.kind !== "file" || file.encoding !== "base64" || typeof file.content !== "string")
        throw new Error(`Captured file ${path} is not a regular base64-encoded file`);
      if (Buffer.byteLength(file.content, "base64") > READ_LIMIT)
        throw new Error(`Workspace file ${path} exceeds the 16 MiB read limit`);
      const bytes = Buffer.from(file.content, "base64");
      if (
        bytes.toString("base64") !== file.content ||
        bytes.length !== file.size ||
        file.sha256 !== `sha256:${hash(bytes)}`
      )
        throw new Error(`Captured file ${path} has inconsistent bytes, size or digest`);
      return bytes;
    }
    if (this.deleted.includes(path)) return undefined;
    if (this.changes.status !== "complete")
      throw new Error(`Cannot resolve ${path} from an incomplete workspace capture`);
    if (typeof this.root !== "string" || !isAbsolute(this.root))
      throw new Error(
        `No captured contents or retained workspace for ${path}; missing changed-file entries do not prove absence`,
      );
    // Strip trailing separators and dot components before lstat so root aliases cannot hide a link.
    const rootPath = resolve(this.root);
    const rootInfo = await lstat(rootPath);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
      throw new Error("Workspace root is not an unaliased directory");
    const root = await realpath(this.root);
    // Parent aliases (such as macOS /tmp) are valid only while all spellings retain identity.
    const rootPaths = [rootPath];
    if (this.root !== rootPath) rootPaths.push(this.root);
    if (root !== rootPath && root !== this.root) rootPaths.push(root);
    const ancestors = rootPaths.map((path) => ({
      path,
      ino: rootInfo.ino,
      dev: rootInfo.dev,
    }));
    const checkAncestors = async () => {
      for (const ancestor of ancestors) {
        const current = await lstat(ancestor.path);
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          current.ino !== ancestor.ino ||
          current.dev !== ancestor.dev
        )
          throw new Error(`Workspace parent of ${path} changed while reading`);
      }
    };
    await checkAncestors();
    let target = root;
    const parts = path.split("/");
    for (let index = 0; index < parts.length; index++) {
      target = join(target, parts[index]);
      let info: Stats;
      try {
        info = await lstat(target);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
          await checkAncestors();
          return undefined;
        }
        throw cause;
      }
      if (info.isSymbolicLink()) throw new Error(`Workspace path ${path} contains a symlink`);
      if (index < parts.length - 1) {
        if (!info.isDirectory()) throw new Error(`Workspace parent of ${path} is not a directory`);
        ancestors.push({ path: target, ino: info.ino, dev: info.dev });
      } else if (!info.isFile() || info.nlink !== 1)
        throw new Error(`Workspace path ${path} is not an unaliased regular file`);
    }
    const before = await lstat(target);
    if (before.size > READ_LIMIT)
      throw new Error(`Workspace file ${path} exceeds the 16 MiB read limit`);
    const fd = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await fd.stat();
      if (opened.size > READ_LIMIT)
        throw new Error(`Workspace file ${path} exceeds the 16 MiB read limit`);
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.ino !== before.ino ||
        opened.dev !== before.dev ||
        opened.size !== before.size ||
        opened.mtimeMs !== before.mtimeMs ||
        opened.ctimeMs !== before.ctimeMs
      )
        throw new Error(`Workspace file ${path} changed while opening`);
      const buffer = Buffer.alloc(opened.size + 1);
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
      const after = await fd.stat();
      if (
        after.ctimeMs !== opened.ctimeMs ||
        after.mtimeMs !== opened.mtimeMs ||
        after.size !== opened.size ||
        bytesRead !== opened.size
      )
        throw new Error(`Workspace file ${path} changed while reading`);
      await checkAncestors();
      return buffer.subarray(0, bytesRead);
    } finally {
      await fd.close();
    }
  }
}
