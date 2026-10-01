import { lstat, mkdir, readdir, readFile, rm, rmdir, statfs } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { alive, atomicJson, PACKAGE, processIdentity } from "../fs.ts";
import type { ProcessIdentity, SourceLimits } from "../types.ts";

const childName = /^allagents-bounded-git-[a-f0-9-]{36}$/;
const markerName = ".allagents-owner.json";

function unescapeMount(path: string): string {
  return path.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
}

async function mounts(): Promise<{ path: string; type: string }[]> {
  return (await readFile("/proc/self/mountinfo", "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const fields = line.split(" ");
      const separator = fields.indexOf("-");
      if (separator < 6 || !fields[4] || !fields[separator + 1])
        throw new Error("Malformed mountinfo for Git staging");
      return { path: unescapeMount(fields[4]), type: fields[separator + 1] };
    });
}

function contains(root: string, path: string): boolean {
  return path === root || path.startsWith(root === sep ? sep : `${root}${sep}`);
}

async function assertNoMountsBelow(root: string): Promise<void> {
  if ((await mounts()).some((mount) => mount.path !== root && contains(root, mount.path)))
    throw new Error("Unexpected mount inside bounded Git staging");
}

/** Validate the physical bound, not just post-clone byte counts, before launching Git. */
export async function verifyGitStagingRoot(root: string, limits: SourceLimits): Promise<void> {
  if (
    process.platform !== "linux" ||
    !isAbsolute(root) ||
    root !== resolve(root) ||
    root === sep ||
    root.includes("\0")
  )
    throw new Error("Git staging requires an absolute normalized Linux tmpfs directory");
  for (let path = root; ; path = dirname(path)) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Git staging path contains a symlink or non-directory");
    if (path === root && (stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700))
      throw new Error("Git staging root must be private and owned by the runner");
    if (path === dirname(path)) break;
  }
  const matching = (await mounts()).filter((mount) => contains(mount.path, root));
  const deepest = Math.max(...matching.map((mount) => mount.path.length));
  const nearest = matching.filter((mount) => mount.path.length === deepest);
  if (nearest.length !== 1 || nearest[0].type !== "tmpfs")
    throw new Error("Git staging root must reside on a uniquely identified tmpfs mount");
  await assertNoMountsBelow(root);
  const fs = await statfs(root, { bigint: true });
  const limit = BigInt(limits.maxDownloadBytes) + BigInt(limits.maxExtractedBytes);
  const totalBytes = fs.blocks * fs.bsize;
  if (
    !Number.isSafeInteger(limits.maxDownloadBytes) ||
    !Number.isSafeInteger(limits.maxExtractedBytes) ||
    totalBytes <= 0n ||
    totalBytes > limit ||
    fs.files <= 0n ||
    fs.files > limit / 4096n ||
    fs.bavail <= 0n ||
    fs.ffree <= 0n
  )
    throw new Error(
      "Git staging tmpfs byte/inode capacity is unbounded, exceeds source limits, or exhausted",
    );
}

async function privateChild(path: string): Promise<boolean> {
  const stat = await lstat(path);
  return (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    stat.uid === process.getuid?.() &&
    (stat.mode & 0o777) === 0o700
  );
}

async function reap(root: string): Promise<void> {
  for (const name of await readdir(root)) {
    if (!childName.test(name)) continue;
    const path = join(root, name);
    try {
      if (!(await privateChild(path))) continue;
      const marker = join(path, markerName);
      const stat = await lstat(marker);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size > 4096 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0
      )
        continue;
      const owner = JSON.parse(await readFile(marker, "utf8")) as {
        schemaVersion: number;
        package: string;
        kind: string;
        path: string;
        identity: ProcessIdentity;
      };
      if (
        owner.schemaVersion !== 1 ||
        owner.package !== PACKAGE ||
        owner.kind !== "bounded-git-acquisition" ||
        owner.path !== path ||
        !owner.identity ||
        (await alive(owner.identity))
      )
        continue;
      if (!(await privateChild(path))) continue;
      await assertNoMountsBelow(root);
      await rm(path, { recursive: true });
    } catch {
      // A malformed, changing, or live directory gives no deletion authority.
    }
  }
}

export async function createGitStagingChild(
  root: string,
  limits: SourceLimits,
  child: string,
): Promise<void> {
  await verifyGitStagingRoot(root, limits);
  await reap(root);
  await verifyGitStagingRoot(root, limits);
  if (dirname(child) !== root || !childName.test(child.slice(root.length + 1)))
    throw new Error("Unsafe bounded Git staging child");
  await mkdir(child, { mode: 0o700 });
  try {
    await atomicJson(join(child, markerName), {
      schemaVersion: 1,
      package: PACKAGE,
      kind: "bounded-git-acquisition",
      path: child,
      identity: await processIdentity(),
    });
    await verifyGitStagingRoot(root, limits);
    return;
  } catch (error) {
    // If the marker was never written, an unmarked child is not deletion authority.
    // Only an empty directory can be safely removed without its owner marker.
    try {
      if (await markerOwned(child)) await removeGitStagingChild(root, child);
      else await rmdir(child);
    } catch {
      /* An unmarked nonempty directory remains for operator inspection. */
    }
    throw error;
  }
}

async function markerOwned(child: string): Promise<boolean> {
  try {
    const stat = await lstat(join(child, markerName));
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > 4096 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    )
      return false;
    const owner = JSON.parse(await readFile(join(child, markerName), "utf8")) as {
      schemaVersion: number;
      package: string;
      kind: string;
      path: string;
      identity: ProcessIdentity;
    };
    return (
      owner.schemaVersion === 1 &&
      owner.package === PACKAGE &&
      owner.kind === "bounded-git-acquisition" &&
      owner.path === child &&
      owner.identity?.pid === process.pid &&
      owner.identity.start === (await processIdentity()).start
    );
  } catch {
    return false;
  }
}

export async function removeGitStagingChild(root: string, child: string): Promise<void> {
  if (
    dirname(child) !== root ||
    !childName.test(child.slice(root.length + 1)) ||
    !(await privateChild(child)) ||
    !(await markerOwned(child))
  )
    throw new Error("Unsafe or unmarked bounded Git staging child");
  await assertNoMountsBelow(root);
  await rm(child, { recursive: true });
}
