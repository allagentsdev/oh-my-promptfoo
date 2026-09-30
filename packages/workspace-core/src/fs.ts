import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Ownership, ProcessIdentity, TreeEntry } from "./types.js";
export const PACKAGE = "@allagents/promptfoo-integration" as const;
export const MARKER = ".allagents-owner.json";
export function contained(root: string, path: string): string {
  const result = resolve(path);
  const rel = relative(resolve(root), result);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep))
    throw new Error("Path must be strictly contained in package root");
  return result;
}
export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
export async function atomicJson(
  path: string,
  value: unknown,
  maxBytes = Number.MAX_SAFE_INTEGER,
): Promise<void> {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > maxBytes) throw new Error("Package JSON exceeds write bound");
  const temp = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (process.platform === "win32") await assertNoSymlinkAncestors(dirname(path));
  else if ((await realpath(dirname(path))) !== resolve(dirname(path)))
    throw new Error("Symlinked package write parent");
  try {
    await writeFile(temp, encoded, { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
export async function json<T>(path: string, maxBytes = 64 * 1024 ** 2): Promise<T> {
  const { open } = await import("node:fs/promises");
  const { constants } = await import("node:fs");
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await fd.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes)
      throw new Error("Unsafe or oversized package JSON file");
    return JSON.parse(await fd.readFile("utf8")) as T;
  } finally {
    await fd.close();
  }
}
let ownWindowsStart: Promise<string> | undefined;
/** Windows process creation time is a kernel timestamp, not a PID or wall-clock estimate. */
async function windowsProcessStart(pid: number): Promise<string> {
  const { execFile } = await import("node:child_process");
  const script = `[Console]::Out.Write([Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks.ToString())`;
  return new Promise((res, rej) => {
    const child = execFile(
      join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" }, windowsHide: true },
      (error, output) => (error ? rej(error) : res(output.trim())),
    );
    child.stdin?.end();
  });
}

export async function processIdentity(): Promise<ProcessIdentity> {
  let start = "";
  let boot = "";
  if (process.platform === "linux") {
    start =
      (await readFile(`/proc/${process.pid}/stat`, "utf8")).split(") ").at(-1)?.split(" ")[19] ??
      "";
    boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  } else if (process.platform === "win32") {
    if (!ownWindowsStart) ownWindowsStart = windowsProcessStart(process.pid);
    start = await ownWindowsStart;
  } else {
    const { execFile } = await import("node:child_process");
    start = await new Promise<string>((res, rej) =>
      execFile(
        process.platform === "darwin" ? "/bin/ps" : "ps",
        ["-p", String(process.pid), "-o", "lstart="],
        { env: { ...process.env, TZ: "UTC", LC_ALL: "C" } },
        (e, out) => (e ? rej(e) : res(out.trim())),
      ),
    );
  }
  if (!start) throw new Error("Cannot establish PID-reuse-resistant process identity");
  return { pid: process.pid, start, hostname: hostname(), boot };
}
export async function alive(identity: ProcessIdentity): Promise<boolean> {
  if (
    !identity ||
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 0 ||
    typeof identity.start !== "string" ||
    !identity.start ||
    typeof identity.hostname !== "string" ||
    !identity.hostname ||
    typeof identity.boot !== "string"
  )
    throw new Error("Malformed package process identity");
  if (identity.hostname !== hostname()) return true;
  if (process.platform === "linux") {
    const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    if (identity.boot !== boot) return false;
    try {
      const stat = (await readFile(`/proc/${identity.pid}/stat`, "utf8"))
        .split(") ")
        .at(-1)
        ?.split(" ");
      return stat?.[19] === identity.start && stat?.[0] !== "Z";
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw e;
    }
  }
  if (process.platform === "win32") {
    if (identity.pid === process.pid) {
      if (!ownWindowsStart) ownWindowsStart = windowsProcessStart(process.pid);
      return identity.start === (await ownWindowsStart);
    }
    try {
      process.kill(identity.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw error;
    }
    try {
      return (await windowsProcessStart(identity.pid)) === identity.start;
    } catch (error) {
      // An access-denied or unavailable identity is never authority to delete
      // another process's private scratch. Only a confirmed missing PID is.
      try {
        process.kill(identity.pid, 0);
      } catch (status) {
        if ((status as NodeJS.ErrnoException).code === "ESRCH") return false;
      }
      throw error;
    }
  }
  const { execFile } = await import("node:child_process");
  return new Promise((res) =>
    execFile(
      process.platform === "darwin" ? "/bin/ps" : "ps",
      ["-p", String(identity.pid), "-o", "lstart="],
      { env: { ...process.env, TZ: "UTC", LC_ALL: "C" } },
      (e, out) => res(!e && out.trim() === identity.start),
    ),
  );
}
export async function assertNoSymlinkAncestors(path: string): Promise<void> {
  let probe = resolve(path);
  for (;;) {
    if (await exists(probe)) {
      const s = await lstat(probe);
      if (s.isSymbolicLink()) throw new Error("Package root ancestor is a symlink");
    }
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
}
export async function ownedRoot(path: string, kind: string): Promise<void> {
  const absolute = resolve(path);
  await assertNoSymlinkAncestors(absolute);
  if (await exists(absolute)) {
    // Another publisher may replace an empty root between the existence check and read.
    const entries = await readdir(absolute).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    if (entries.length && !(await exists(join(absolute, MARKER))))
      throw new Error("Refusing unmarked package root");
  }
  if (!(await exists(join(absolute, MARKER)))) {
    const parent = dirname(absolute);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    if (process.platform === "win32") await assertNoSymlinkAncestors(parent);
    else if ((await realpath(parent)) !== parent)
      throw new Error("Package root parent is a symlink");
    const staging = await mkdtemp(join(parent, `.${basename(absolute)}.allagents-bootstrap-`));
    try {
      await atomicJson(join(staging, MARKER), { schemaVersion: 1, package: PACKAGE, kind });
      // Publish the completed directory atomically, including over an empty root.
      // A concurrent publisher's marked, nonempty root cannot be replaced.
      // Windows cannot rename onto an existing empty directory; remove only
      // an empty root, then race competing publishers with the atomic rename.
      if (process.platform === "win32" && (await exists(absolute))) {
        await rmdir(absolute).catch((error: NodeJS.ErrnoException) => {
          if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code ?? "")) throw error;
        });
      }
      try {
        await rename(staging, absolute);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          !["EEXIST", "ENOTEMPTY"].includes(code ?? "") &&
          !(process.platform === "win32" && code === "EPERM")
        )
          throw error;
        // On Windows an already published directory causes EPERM, not EEXIST.
        // Only a complete, owned marker establishes that a publisher won.
        const winner = await json<Ownership>(join(absolute, MARKER)).catch(() => undefined);
        if (winner?.package !== PACKAGE || winner.schemaVersion !== 1) throw error;
        await assertNoSymlinkAncestors(absolute);
      }
    } finally {
      if (await exists(staging)) await removeTree(staging);
    }
  }
  const marker = await json<Ownership>(join(absolute, MARKER));
  if (marker.package !== PACKAGE || marker.schemaVersion !== 1 || marker.kind !== kind)
    throw new Error("Invalid package root ownership");
  if (process.platform !== "win32" && (await realpath(absolute)) !== absolute)
    throw new Error("Package root realpath mismatch");
}
export async function inventoryWithAllocation(
  root: string,
  maxEntries = 1000000,
): Promise<{ entries: TreeEntry[]; allocatedBytes: number }> {
  const nodes: {
    path: string;
    rel: string;
    sortKey: string;
    kind: "directory" | "file" | "symlink";
    size: number;
    mode: number;
  }[] = [];
  const queue = [root];
  let allocatedBytes = 0;
  for (let cursor = 0; cursor < queue.length; ) {
    const end = Math.min(cursor + 64, queue.length);
    const batch = queue.slice(cursor, end);
    cursor = end;
    const found = await Promise.all(
      batch.map(async (path) => {
        const stat = await lstat(path);
        const rel = relative(root, path).split(sep).join("/");
        if (stat.isSymbolicLink())
          return { path, rel, stat, kind: "symlink" as const, children: [] as string[] };
        if (stat.isDirectory())
          return {
            path,
            rel,
            stat,
            kind: "directory" as const,
            children: (await readdir(path)).map((name) => join(path, name)),
          };
        if (stat.isFile()) {
          if (stat.nlink !== 1) throw new Error("Hardlinked seed content is forbidden");
          return { path, rel, stat, kind: "file" as const, children: [] as string[] };
        }
        throw new Error("Special file in workspace source");
      }),
    );
    for (const item of found) {
      allocatedBytes += item.stat.blocks * 512;
      if (item.rel)
        nodes.push({
          path: item.path,
          rel: item.rel,
          sortKey: item.rel.replaceAll("/", "\0"),
          kind: item.kind,
          size: item.stat.size,
          mode: item.stat.mode & 0o777,
        });
      if (nodes.length > maxEntries) throw new Error("Tree inventory limit exceeded");
      for (const child of item.children) queue.push(child);
    }
  }
  // Replacing separators with NUL preserves the old depth-first, per-directory
  // lexical order while allowing the stat walk to run concurrently.
  nodes.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
  const result: (TreeEntry | undefined)[] = [];
  const pending: {
    path: string;
    index: number;
    kind: "file" | "symlink";
    size: number;
    mode: number;
  }[] = [];
  for (const item of nodes) {
    if (item.kind === "directory")
      result.push({ path: item.rel, kind: "directory", mode: item.mode, size: 0 });
    else {
      pending.push({
        path: item.path,
        index: result.length,
        kind: item.kind,
        size: item.size,
        mode: item.mode,
      });
      result.push(undefined);
    }
  }
  const { createReadStream } = await import("node:fs");
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(
    Array.from({ length: Math.min(32, pending.length) }, async () => {
      while (!failed && cursor < pending.length) {
        const item = pending[cursor++];
        const path = relative(root, item.path).split(sep).join("/");
        try {
          if (item.kind === "symlink") {
            const target = await readlink(item.path);
            const effective = resolve(dirname(item.path), target);
            if (effective !== root) contained(root, effective);
            result[item.index] = {
              path,
              kind: "symlink",
              mode: item.mode,
              size: Buffer.byteLength(target),
              target,
            };
          } else {
            const hash = createHash("sha256");
            for await (const chunk of createReadStream(item.path)) hash.update(chunk);
            result[item.index] = {
              path,
              kind: "file",
              mode: item.mode,
              size: item.size,
              digest: hash.digest("hex"),
            };
          }
        } catch (error) {
          failed = true;
          failure = error;
        }
      }
    }),
  );
  if (failed) throw failure;
  if (result.some((entry) => !entry)) throw new Error("Incomplete tree inventory");
  return { entries: result as TreeEntry[], allocatedBytes };
}
export async function inventory(root: string, maxEntries = 1000000): Promise<TreeEntry[]> {
  return (await inventoryWithAllocation(root, maxEntries)).entries;
}
export async function allocated(root: string): Promise<number> {
  if (!(await exists(root))) return 0;
  let bytes = 0;
  const pending = [root];
  for (let cursor = 0; cursor < pending.length; ) {
    const end = Math.min(cursor + 64, pending.length);
    const batch = pending.slice(cursor, end);
    cursor = end;
    const entries = await Promise.all(
      batch.map(async (path) => {
        const stat = await lstat(path);
        return {
          bytes: stat.blocks * 512,
          children: stat.isDirectory() ? (await readdir(path)).map((name) => join(path, name)) : [],
        };
      }),
    );
    for (const entry of entries) {
      bytes += entry.bytes;
      for (const child of entry.children) pending.push(child);
    }
  }
  return bytes;
}
let windowsIdentity: Promise<string> | undefined;
/** NTFS read-only directory attributes do not prevent creating children. */
async function windowsTreeAccess(root: string, writable: boolean): Promise<void> {
  const { execFile } = await import("node:child_process");
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const system = join(systemRoot, "System32");
  const run = (command: string, args: string[]): Promise<string> =>
    new Promise((resolve, reject) =>
      execFile(
        join(system, command),
        args,
        { env: { SystemRoot: systemRoot }, windowsHide: true },
        (error, output) => (error ? reject(error) : resolve(output)),
      ),
    );
  if (!windowsIdentity)
    windowsIdentity = run("whoami.exe", ["/user", "/fo", "csv", "/nh"]).then((identity) => {
      const sid = /,"(S-\d+(?:-\d+)+)"\s*$/.exec(identity)?.[1];
      if (!sid) throw new Error("Cannot establish Windows workspace ACL identity");
      return sid;
    });
  const sid = await windowsIdentity;
  // Explicit inheritable owner ACE per inode; no chmod/write-open on Git objects.
  const grant = `*${sid}:(OI)(CI)${writable ? "F" : "RX"}`;
  await run("icacls.exe", [root, "/grant:r", grant, "/T", "/L", "/Q"]);
  await run("icacls.exe", [root, "/inheritance:r", "/T", "/L", "/Q"]);
}

/** Existing objects stay read-only, while object directories accept new Git objects. */
async function windowsGitObjectAccess(root: string): Promise<void> {
  const objects = join(root, ".git", "objects");
  if (!(await exists(objects))) return;
  const { execFile } = await import("node:child_process");
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const identity = await windowsIdentity!;
  const files: string[] = [];
  const directories = [objects];
  for (let index = 0; index < directories.length; index++) {
    const directory = directories[index];
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Unsafe Git object directory");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Unsafe Git object link");
      if (entry.isDirectory()) directories.push(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error("Unsafe Git object inode");
    }
  }
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(files.length, 16) }, async () => {
      while (cursor < files.length) {
        const path = files[cursor++];
        for (const args of [
          [path, "/grant:r", `*${identity}:RX`, "/L", "/Q"],
          [path, "/inheritance:r", "/L", "/Q"],
        ])
          await new Promise<void>((resolve, reject) =>
            execFile(
              join(systemRoot, "System32", "icacls.exe"),
              args,
              { env: { SystemRoot: systemRoot }, windowsHide: true },
              (error) => (error ? reject(error) : resolve()),
            ),
          );
      }
    }),
  );
}

export async function protect(
  root: string,
  writable: boolean,
  preserveGitObjects = false,
): Promise<void> {
  if (process.platform === "win32") {
    if ((await lstat(root)).isSymbolicLink()) throw new Error("Cannot protect symlink root");
    await windowsTreeAccess(root, writable);
    if (writable && preserveGitObjects) await windowsGitObjectAccess(root);
    return;
  }
  // Protecting a large checkout is dominated by filesystem round trips. Walk
  // independent entries concurrently while bounding the number of in-flight
  // operations; every descendant is still visited and symlinks are not followed.
  const pending = [root];
  const gitObjects = join(root, ".git", "objects");
  for (let cursor = 0; cursor < pending.length; ) {
    const end = Math.min(cursor + 32, pending.length);
    const batch = pending.slice(cursor, end);
    cursor = end;
    const children = await Promise.allSettled(
      batch.map(async (path) => {
        const stat = await lstat(path);
        if (stat.isSymbolicLink()) return [];
        if (stat.isDirectory()) {
          await chmod(path, writable ? 0o700 : 0o555);
          return (await readdir(path)).map((name) => join(path, name));
        }
        // Git never edits an existing loose object or pack file. Its object
        // directories remain writable for newly created objects, while keeping
        // existing object bytes read-only avoids OverlayFS metadata copy-ups.
        if (writable && preserveGitObjects && path.startsWith(`${gitObjects}${sep}`)) return [];
        await chmod(path, (stat.mode & 0o111 ? 0o555 : 0o444) | (writable ? 0o200 : 0));
        return [];
      }),
    );
    const failures = children.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) throw new AggregateError(failures, "Workspace protection failed");
    for (const result of children)
      if (result.status === "fulfilled") for (const child of result.value) pending.push(child);
  }
}
async function removeWindowsEntry(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    try {
      await unlink(path);
    } catch (error) {
      if (!["EPERM", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      // Directory junctions need RemoveDirectory, never traversal into their target.
      await rmdir(path);
    }
    return;
  }
  if (info.isDirectory()) {
    for (const name of await readdir(path)) await removeWindowsEntry(join(path, name));
    await rmdir(path);
    return;
  }
  if (info.isFile()) {
    await unlink(path);
    return;
  }
  throw new Error("Refusing special inode during Windows workspace removal");
}
export async function removeTree(path: string): Promise<void> {
  if (!(await exists(path))) return;
  if (process.platform === "win32") {
    if (!(await lstat(path)).isSymbolicLink()) await windowsTreeAccess(path, true);
    await removeWindowsEntry(path);
    return;
  }
  if (process.platform === "linux") {
    const mounts = (await readFile("/proc/self/mountinfo", "utf8"))
      .split("\n")
      .map((line) =>
        line
          .split(" ")[4]
          ?.replace(/\\([0-7]{3})/g, (_, oct: string) =>
            String.fromCharCode(Number.parseInt(oct, 8)),
          ),
      );
    const absolute = resolve(path);
    if (mounts.some((m) => m === absolute || m?.startsWith(`${absolute}/`)))
      throw new Error("Refusing tree deletion across retained or unknown mount");
  }
  const makeDirectoriesWritable = async (directory: string): Promise<void> => {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    if ((info.mode & 0o777) !== 0o700) await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true }))
      if (entry.isDirectory()) await makeDirectoriesWritable(join(directory, entry.name));
  };
  // Unlink needs writable parent directories, even when regular files are read-only.
  await makeDirectoriesWritable(path);
  await rm(path, { recursive: true, force: true });
}
export function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function assertNoSymlinkPath(root: string, path: string): Promise<void> {
  const rel = relative(resolve(root), resolve(path));
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep))
    throw new Error("Escaping cache path");
  let current = resolve(root);
  for (const piece of ["", ...rel.split(sep).filter(Boolean)]) {
    if (piece) current = join(current, piece);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("Symlinked package control path");
  }
}
export async function conservativeCopyBytes(root: string): Promise<number> {
  const info = await lstat(root);
  let result = 4096;
  if (info.isDirectory()) {
    for (const name of await readdir(root)) result += await conservativeCopyBytes(join(root, name));
  } else if (info.isFile()) result += Math.ceil(info.size / 4096) * 4096;
  return result;
}
export async function treeStamp(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(path: string): Promise<void> {
    const info = await lstat(path);
    hash.update(
      JSON.stringify([
        relative(root, path),
        info.ino,
        info.mode,
        info.size,
        info.mtimeMs,
        info.ctimeMs,
      ]),
    );
    if (info.isDirectory())
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    else if (info.isSymbolicLink()) hash.update(await readlink(path));
  }
  await visit(root);
  return hash.digest("hex");
}

export async function mountedFilesystem(
  path: string,
): Promise<{ type: string; source: string } | undefined> {
  if (process.platform !== "linux") return undefined;
  const info = await readFile("/proc/self/mountinfo", "utf8");
  let mounted: { type: string; source: string } | undefined;
  for (const line of info.split("\n")) {
    const fields = line.split(" ");
    const point = fields[4]?.replace(/\\([0-7]{3})/g, (_, oct: string) =>
      String.fromCharCode(Number.parseInt(oct, 8)),
    );
    if (point !== path) continue;
    const separator = fields.indexOf("-");
    const type = fields[separator + 1];
    const source = fields[separator + 2];
    if (separator < 0 || !type || !source || mounted)
      throw new Error("Ambiguous mounted filesystem");
    mounted = { type, source };
  }
  return mounted;
}
export async function isMounted(path: string): Promise<boolean> {
  return (await mountedFilesystem(path)) !== undefined;
}
