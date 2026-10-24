import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

// Codex normally reads text through its shell. Graders disable that tool and get
// this deliberately smaller MCP surface instead. No command or writable handle
// is accepted; protected source links remain readable just like native Read tools.
const root = process.argv[2];
if (!root || !isAbsolute(root) || !(await stat(root)).isDirectory())
  throw new Error("Workspace reader requires an absolute live workspace directory");
const physicalRoot = await realpath(root);
const sourceRoots = JSON.parse(process.argv[3] ?? "{}") as Record<string, string>;
if (!sourceRoots || typeof sourceRoots !== "object" || Array.isArray(sourceRoots))
  throw new Error("Workspace reader source roots must be an object");
// Windows tmpdir() can spell a declared target with 8.3 short names (RUNNER~1)
// while realpath returns long names, so compare canonical forms of both sides.
// The link itself must still be a symlink and the target a real directory.
const declared: { source: string; target: string; physical: string }[] = [];
for (const [source, target] of Object.entries(sourceRoots)) {
  if (
    !source ||
    source.split("/").some((part) => !part || part === "." || part === "..") ||
    isAbsolute(source) ||
    source.includes("\\") ||
    typeof target !== "string" ||
    !isAbsolute(target) ||
    !(await lstat(resolve(root, source))).isSymbolicLink() ||
    !(await stat(target)).isDirectory()
  )
    throw new Error("Workspace reader source root is not a declared protected directory link");
  const physical = await realpath(target);
  if ((await realpath(resolve(root, source))) !== physical)
    throw new Error("Workspace reader source root is not a declared protected directory link");
  declared.push({ source, target, physical });
}
const MAX_BYTES = 256 * 1024;
const MAX_ENTRIES = 2000;
const tools = [
  {
    name: "read_file",
    description: "Read UTF-8 workspace file contents, with bounded byte pagination.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        length: { type: "integer", minimum: 1, maximum: MAX_BYTES },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "list_directory",
    description: "List workspace directory entries, with bounded pagination.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: MAX_ENTRIES },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
/** Resolves a request; `allowed` is the canonical root its real path must stay within. */
async function contained(
  path: unknown,
): Promise<{ target: string; physical: string; allowed: string }> {
  if (typeof path !== "string" || !path || path.includes("\0"))
    throw new Error("path must name a workspace or declared protected source entry");
  const target = resolve(root, path);
  const declaredTarget = declared.some(
    ({ target: allowed, physical }) => within(allowed, target) || within(physical, target),
  );
  if (
    !within(root, target) &&
    !(isAbsolute(path) && (within(physicalRoot, target) || declaredTarget))
  )
    throw new Error("path must stay inside the workspace or declared protected sources");
  const physical = await realpath(target);
  if (within(physicalRoot, physical)) return { target, physical, allowed: physicalRoot };
  for (const { source, target: allowed, physical: allowedPhysical } of declared)
    if (
      (within(resolve(root, source), target) ||
        (isAbsolute(path) && (within(allowed, target) || within(allowedPhysical, target)))) &&
      within(allowedPhysical, physical)
    )
      return { target, physical, allowed: allowedPhysical };
  throw new Error("path follows a symlink outside the workspace or declared protected sources");
}
// O_NOFOLLOW guards only the last component, so a parent directory swapped for a
// symlink after contained() can redirect the open. Once a handle is open, resolve
// the path again and require that it still lands inside the same root, on the
// handle's own inode. An outside inode can be reachable inside the root only
// through a hard link (refused by the nlink check for files) or a bind mount,
// which unprivileged users cannot create. BigInt stats keep dev/ino exact,
// including NTFS file IDs on Windows.
async function unchanged(target: string, allowed: string, opened: BigIntStats): Promise<void> {
  const physical = await realpath(target);
  const current = await stat(physical, { bigint: true });
  if (!within(allowed, physical) || current.dev !== opened.dev || current.ino !== opened.ino)
    throw new Error("path changed while it was being opened");
}
function integer(value: unknown, fallback: number, maximum: number, minimum = 0): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    throw new Error("Pagination must use bounded nonnegative integers");
  return value as number;
}
async function callTool(name: unknown, args: Record<string, unknown>) {
  const { target, physical: path, allowed } = await contained(args.path);
  const offset = integer(args.offset, 0, Number.MAX_SAFE_INTEGER);
  if (name === "read_file") {
    if (Object.keys(args).some((key) => !["path", "offset", "length"].includes(key)))
      throw new Error("Unsupported read_file argument");
    const length = integer(args.length, MAX_BYTES, MAX_BYTES, 1);
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat({ bigint: true });
      if (!info.isFile()) throw new Error("path must name a regular file");
      // Another link to this inode may sit outside the root, so its bytes are not the workspace's.
      if (info.nlink > 1n) throw new Error("path must not name a file with multiple hard links");
      await unchanged(target, allowed, info);
      const size = Number(info.size);
      const bytes = Buffer.alloc(Math.min(length, Math.max(0, size - offset)));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
      return {
        path: args.path,
        offset,
        nextOffset: offset + bytesRead,
        size,
        truncated: offset + bytesRead < size,
        text: bytes.subarray(0, bytesRead).toString("utf8"),
      };
    } finally {
      await handle.close();
    }
  }
  if (name === "list_directory") {
    if (Object.keys(args).some((key) => !["path", "offset", "limit"].includes(key)))
      throw new Error("Unsupported list_directory argument");
    const limit = integer(args.limit, MAX_ENTRIES, MAX_ENTRIES, 1);
    const entries: { name: string; type: string }[] = [];
    let index = 0;
    let truncated = false;
    // Node cannot list an fd, so POSIX lists the verified handle through its
    // descriptor path. Windows has no such path; there the listing is bracketed
    // by identity checks, which catch a swap that is still in place afterwards.
    const fdDirectory =
      process.platform === "linux"
        ? "/proc/self/fd"
        : process.platform === "darwin"
          ? "/dev/fd"
          : "";
    let handle: FileHandle | undefined;
    let before: BigIntStats;
    try {
      if (fdDirectory) {
        handle = await open(
          path,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
        );
        before = await handle.stat({ bigint: true });
        await unchanged(target, allowed, before);
      } else before = await stat(path, { bigint: true });
      for await (const entry of await opendir(handle ? `${fdDirectory}/${handle.fd}` : path)) {
        if (index++ < offset) continue;
        if (entries.length === limit) {
          truncated = true;
          break;
        }
        entries.push({
          name: entry.name,
          type: entry.isDirectory()
            ? "directory"
            : entry.isFile()
              ? "file"
              : entry.isSymbolicLink()
                ? "symlink"
                : "other",
        });
      }
      if (!handle) await unchanged(target, allowed, before);
    } finally {
      await handle?.close();
    }
    return { path: args.path, offset, nextOffset: offset + entries.length, truncated, entries };
  }
  throw new Error("Unknown workspace inspection tool");
}

let pendingBytes = 0;
process.stdin.on("data", (chunk: Buffer) => {
  let start = 0;
  while (start < chunk.length) {
    const newline = chunk.indexOf(10, start);
    pendingBytes += (newline < 0 ? chunk.length : newline) - start;
    if (pendingBytes > 1024 * 1024) {
      process.exitCode = 1;
      input.close();
      process.stdin.destroy();
      return;
    }
    if (newline < 0) break;
    pendingBytes = 0;
    start = newline + 1;
  }
});
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  let id: unknown = null;
  try {
    if (Buffer.byteLength(line) > 1024 * 1024) throw new Error("MCP request exceeds byte limit");
    const request = JSON.parse(line);
    if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string")
      throw new Error("Invalid JSON-RPC request");
    if (request.id === undefined) continue;
    id = request.id;
    if (typeof id !== "string" && typeof id !== "number") throw new Error("Invalid request id");
    let result: unknown;
    if (request.method === "initialize") {
      result = {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "oh-my-promptfoo-workspace-reader", version: "1" },
      };
    } else if (request.method === "ping") result = {};
    else if (request.method === "tools/list") result = { tools };
    else if (request.method === "tools/call") {
      try {
        const args = request.params?.arguments ?? {};
        if (!args || typeof args !== "object" || Array.isArray(args))
          throw new Error("Invalid tool arguments");
        result = {
          content: [
            { type: "text", text: JSON.stringify(await callTool(request.params?.name, args)) },
          ],
        };
      } catch (error) {
        result = {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        };
      }
    } else throw new Error("Unsupported MCP method");
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: error instanceof Error ? error.message : String(error) },
      })}\n`,
    );
  }
}
