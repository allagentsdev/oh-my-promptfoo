import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  statfs,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_LOCK_TIMEOUT_MS, withLock } from "./cache-lock.js";
import {
  conservativeCopyBytes,
  contained,
  exists,
  isMounted,
  mountedFilesystem,
  protect,
  removeTree,
} from "./fs.js";
import { helperAvailable, helperInvoke } from "./helper.js";
import type { AdapterKind, SourceView } from "./types.js";

const HEADROOM = 256 * 1024 ** 2;
function overlaySource(mount: string, lower: string, upper: string, work: string): string {
  return `allagents-${createHash("sha256").update([mount, lower, upper, work].join("\0")).digest("hex")}`;
}
async function copyTree(source: string, dest: string, reflink: boolean): Promise<void> {
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    await symlink(await readlink(source), dest);
    return;
  }
  if (info.isDirectory()) {
    await mkdir(dest, { recursive: true, mode: 0o700 });
    for (const name of await readdir(source))
      await copyTree(join(source, name), join(dest, name), reflink);
    return;
  }
  if (!info.isFile() || info.nlink !== 1) throw new Error("Unsupported checkout inode");
  await copyFile(
    source,
    dest,
    reflink ? constants.COPYFILE_FICLONE_FORCE : constants.COPYFILE_EXCL,
  );
}
async function mountDirect(
  lower: string,
  mount: string,
  upper: string,
  work: string,
): Promise<void> {
  if ([lower, mount, upper, work].some((p) => /[,\n:]/.test(p)))
    throw new Error("Unsupported overlay path characters");
  await new Promise<void>((res, rej) =>
    execFile(
      "mount",
      [
        "-t",
        overlaySource(mount, lower, upper, work),
        "overlay",
        "-o",
        `lowerdir=${lower},upperdir=${upper},workdir=${work},metacopy=on,nosuid,nodev`,
        mount,
      ],
      { timeout: 15000, maxBuffer: 8192 },
      (e) => (e ? rej(e) : res()),
    ),
  );
}

export { isMounted } from "./fs.js";
export async function releaseView(view: SourceView): Promise<void> {
  let helperReleased = false;
  if (view.adapter === "overlay" && (await isMounted(view.path))) {
    if (!view.statePath) throw new Error("Missing overlay recovery state");
    if (await helperAvailable()) {
      await helperInvoke("release-overlay", [
        view.path,
        view.seedSource,
        join(view.statePath, "upper"),
        join(view.statePath, "work"),
      ]);
      helperReleased = true;
    } else {
      const mounted = await mountedFilesystem(view.path);
      if (
        mounted?.type !== "overlay" ||
        mounted.source !==
          overlaySource(
            view.path,
            view.seedSource,
            join(view.statePath, "upper"),
            join(view.statePath, "work"),
          )
      )
        throw new Error("Refusing unknown mount during workspace teardown");
      await new Promise<void>((res, rej) =>
        execFile("umount", [view.path], { timeout: 15000, maxBuffer: 8192 }, (e) =>
          e ? rej(e) : res(),
        ),
      );
    }
    if (await isMounted(view.path))
      throw new Error("Overlay detach did not remove provider-visible mount");
  }
  if (await isMounted(view.path))
    throw new Error("Refusing unknown mount during workspace teardown");
  if (view.adapter === "overlay" && view.statePath && !helperReleased) {
    // A mount helper can leave kernel-owned work entries even if direct umount succeeds
    // or a mount attempt is interrupted before the mount becomes visible.
    const kernelWork = await lstat(join(view.statePath, "work", "work")).catch(() => undefined);
    if (kernelWork && kernelWork.uid !== process.getuid?.())
      await helperInvoke("release-overlay", [
        view.path,
        view.seedSource,
        join(view.statePath, "upper"),
        join(view.statePath, "work"),
      ]);
  }
  if (view.adapter === "read-only") {
    const info = await lstat(view.path).catch(() => undefined);
    if (info?.isSymbolicLink()) {
      const { unlink } = await import("node:fs/promises");
      await unlink(view.path);
    } else if (info) await removeTree(view.path);
  } else await removeTree(view.path);
  if (view.statePath) await removeTree(view.statePath);
}
export class CheckoutFactory {
  private probe?: Promise<AdapterKind>;
  constructor(
    private runtime: string,
    private cache: string,
    private acquisitionLockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  ) {}
  async selected(
    seedSource: string,
    stateRoot: string,
    beforeProbe: (view: SourceView) => Promise<void>,
    destination: string,
  ): Promise<AdapterKind> {
    this.probe ??= this.doProbe(seedSource, stateRoot, beforeProbe, destination);
    return this.probe;
  }
  private async doProbe(
    seedSource: string,
    stateRoot: string,
    beforeProbe: (view: SourceView) => Promise<void>,
    destination: string,
  ): Promise<AdapterKind> {
    const state = join(stateRoot, `probe-${randomUUID()}`);
    const probeView: SourceView = {
      probe: true,
      destination,
      adapter: "overlay",
      seedSource,
      path: join(state, "mount"),
      statePath: state,
    };
    await beforeProbe(probeView);
    await mkdir(state, { recursive: true, mode: 0o700 });
    const localSource = join(state, "source");
    await mkdir(localSource);
    await writeFile(join(localSource, "isolation"), "unchanged");
    try {
      const find = async (path: string): Promise<string | undefined> => {
        for (const name of await readdir(path)) {
          const child = join(path, name);
          const info = await lstat(child);
          if (info.isDirectory()) {
            const nested = await find(child);
            if (nested) return nested;
          } else if (info.isFile() && info.size <= 65536) return child;
        }
        return undefined;
      };
      const file = await find(seedSource);
      if (!file) throw new Error("Reflink probe requires a regular source file");
      const original = await readFile(file);
      await copyFile(file, join(state, "a"), constants.COPYFILE_FICLONE_FORCE);
      await copyFile(file, join(state, "b"), constants.COPYFILE_FICLONE_FORCE);
      await chmod(join(state, "a"), 0o600);
      await writeFile(join(state, "a"), "private");
      if (
        !(await readFile(file)).equals(original) ||
        !(await readFile(join(state, "b"))).equals(original)
      )
        throw new Error("Reflink isolation probe failed");
      await removeTree(state);
      return "reflink";
    } catch {
      await removeTree(join(state, "a"));
      await removeTree(join(state, "b"));
    }
    if (process.platform === "linux") {
      const stateB = join(stateRoot, `probe-${randomUUID()}`);
      const sibling: SourceView = { ...probeView, path: join(stateB, "mount"), statePath: stateB };
      await beforeProbe(sibling);
      for (const view of [probeView, sibling])
        for (const path of [
          view.path,
          join(view.statePath!, "upper"),
          join(view.statePath!, "work"),
        ])
          await mkdir(path, { recursive: true, mode: 0o700 });
      const mountProbe = async (view: SourceView) => {
        const upper = join(view.statePath!, "upper");
        const work = join(view.statePath!, "work");
        try {
          await mountDirect(seedSource, view.path, upper, work);
        } catch {
          await helperInvoke("mount-overlay", [view.path, seedSource, upper, work]);
        }
        if (!(await isMounted(view.path)))
          throw new Error("Overlay invisible to provider mount namespace");
        // Probe the real mount without copying metadata for unrelated lower files.
        await chmod(view.path, 0o700);
      };
      try {
        await mountProbe(probeView);
        await mountProbe(sibling);
        const find = async (path: string): Promise<string | undefined> => {
          for (const name of await readdir(path)) {
            const candidate = join(path, name);
            const info = await lstat(candidate);
            if (info.isDirectory()) {
              const nested = await find(candidate);
              if (nested) return nested;
            } else if (info.isFile()) return candidate;
          }
          return undefined;
        };
        const originalPath = await find(seedSource);
        if (!originalPath)
          throw new Error("Overlay probe requires an existing regular source file");
        const rel = originalPath.slice(seedSource.length + 1);
        const prefix = async (path: string) => {
          const fd = await open(path, "r");
          try {
            const bytes = Buffer.alloc(128);
            const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
            return bytes.subarray(0, bytesRead);
          } finally {
            await fd.close();
          }
        };
        const original = await prefix(originalPath);
        const originalMode = (await lstat(originalPath)).mode;
        await chmod(join(probeView.path, rel), (originalMode & 0o111 ? 0o555 : 0o444) | 0o200);
        const fd = await open(join(probeView.path, rel), "r+");
        try {
          await fd.write(Buffer.from("private overlay mutation"), 0, 24, 0);
        } finally {
          await fd.close();
        }
        if (
          !(await prefix(originalPath)).equals(original) ||
          !(await prefix(join(sibling.path, rel))).equals(original) ||
          (await lstat(originalPath)).mode !== originalMode ||
          (await lstat(join(sibling.path, rel))).mode !== originalMode
        )
          throw new Error("Overlay existing-file mutation reached seed or sibling");
        const unique = `.allagents-probe-${randomUUID()}`;
        await writeFile(join(probeView.path, unique), "private");
        if ((await exists(join(seedSource, unique))) || (await exists(join(sibling.path, unique))))
          throw new Error("Overlay addition reached seed or sibling");
        await releaseView(sibling);
        await releaseView(probeView);
        return "overlay";
      } catch (_error) {
        // Any failed detach stops adapter selection instead of hiding a retained mount.
        for (const view of [sibling, probeView]) await releaseView(view);
      }
    }
    await removeTree(state);
    return "copy";
  }
  async create(view: SourceView): Promise<void> {
    contained(this.runtime, view.path);
    await mkdir(dirname(view.path), { recursive: true, mode: 0o700 });
    if (view.adapter === "overlay") {
      if (!view.statePath) throw new Error("Overlay teardown state must be recorded first");
      contained(this.runtime, view.statePath);
      const upper = join(view.statePath, "upper");
      const work = join(view.statePath, "work");
      for (const p of [view.path, upper, work]) await mkdir(p, { recursive: true, mode: 0o700 });
      try {
        await mountDirect(view.seedSource, view.path, upper, work);
      } catch {
        await helperInvoke("mount-overlay", [view.path, view.seedSource, upper, work]);
      }
      if (!(await isMounted(view.path))) throw new Error("Overlay view is invisible to provider");
      // metacopy changes permissions without duplicating lower file bytes.
      await protect(view.path, true);
      return;
    }
    const operation = async () => {
      if (view.adapter === "copy") {
        const estimate = await conservativeCopyBytes(view.seedSource);
        const fs = await statfs(this.runtime);
        const free = Number(fs.bavail) * Number(fs.bsize);
        if (estimate * 1.1 + HEADROOM > free)
          throw new Error(
            "Private full-copy checkout cannot fit available disk with headroom; copy-on-write is required for this workload",
          );
      }
      await copyTree(view.seedSource, view.path, view.adapter === "reflink");
      await protect(view.path, true);
    };
    if (view.adapter === "copy")
      await withLock(
        join(this.cache, "locks", "copy-admission"),
        operation,
        undefined,
        this.acquisitionLockTimeoutMs,
      );
    else await operation();
  }
}
export async function prepareProtectedCopy(source: string, path: string): Promise<void> {
  try {
    await copyTree(source, path, true);
  } catch {
    await removeTree(path);
    await copyTree(source, path, false);
  }
  await protect(path, false);
}
