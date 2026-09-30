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
  if ((await realpath(dirname(path))) !== resolve(dirname(path)))
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
export async function processIdentity(): Promise<ProcessIdentity> {
  let start = "";
  let boot = "";
  if (process.platform === "linux") {
    start =
      (await readFile(`/proc/${process.pid}/stat`, "utf8")).split(") ").at(-1)?.split(" ")[19] ??
      "";
    boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
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
    const entries = await readdir(absolute);
    if (entries.length && !(await exists(join(absolute, MARKER))))
      throw new Error("Refusing unmarked package root");
  }
  if (!(await exists(join(absolute, MARKER)))) {
    const parent = dirname(absolute);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    if ((await realpath(parent)) !== parent) throw new Error("Package root parent is a symlink");
    const staging = await mkdtemp(join(parent, `.${basename(absolute)}.allagents-bootstrap-`));
    try {
      await atomicJson(join(staging, MARKER), { schemaVersion: 1, package: PACKAGE, kind });
      // Publish the completed directory atomically, including over an empty root.
      // A concurrent publisher's marked, nonempty root cannot be replaced.
      try {
        await rename(staging, absolute);
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
      }
    } finally {
      if (await exists(staging)) await removeTree(staging);
    }
  }
  const marker = await json<Ownership>(join(absolute, MARKER));
  if (marker.package !== PACKAGE || marker.schemaVersion !== 1 || marker.kind !== kind)
    throw new Error("Invalid package root ownership");
  if ((await realpath(absolute)) !== absolute) throw new Error("Package root realpath mismatch");
}
export async function inventory(root: string, maxEntries = 1000000): Promise<TreeEntry[]> {
  const result: TreeEntry[] = [];
  async function visit(path: string): Promise<void> {
    const stat = await lstat(path);
    const rel = relative(root, path).split(sep).join("/");
    if (result.length >= maxEntries) throw new Error("Tree inventory limit exceeded");
    if (stat.isSymbolicLink()) {
      const target = await readlink(path);
      const effective = resolve(dirname(path), target);
      if (effective !== root) contained(root, effective);
      result.push({
        path: rel,
        kind: "symlink",
        mode: stat.mode & 0o777,
        size: Buffer.byteLength(target),
        target,
      });
    } else if (stat.isDirectory()) {
      if (rel) result.push({ path: rel, kind: "directory", mode: stat.mode & 0o777, size: 0 });
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    } else if (stat.isFile()) {
      if (stat.nlink !== 1) throw new Error("Hardlinked seed content is forbidden");
      const hash = createHash("sha256");
      const { createReadStream } = await import("node:fs");
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      result.push({
        path: rel,
        kind: "file",
        mode: stat.mode & 0o777,
        size: stat.size,
        digest: hash.digest("hex"),
      });
    } else throw new Error("Special file in workspace source");
  }
  await visit(root);
  return result;
}
export async function allocated(root: string): Promise<number> {
  if (!(await exists(root))) return 0;
  const stat = await lstat(root);
  let bytes = stat.blocks * 512;
  if (stat.isDirectory())
    for (const name of await readdir(root)) bytes += await allocated(join(root, name));
  return bytes;
}
export async function protect(
  root: string,
  writable: boolean,
  preserveGitObjects = false,
): Promise<void> {
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
export async function removeTree(path: string): Promise<void> {
  if (!(await exists(path))) return;
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
