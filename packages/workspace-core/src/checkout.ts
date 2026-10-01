import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  statfs,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { DEFAULT_LOCK_TIMEOUT_MS, withLock } from "./cache-lock.js";
import { conservativeCopyBytes, contained, isMounted, protect, removeTree } from "./fs.js";
import { publishProgress } from "./progress.js";
import type { AdapterKind, SourceView, ViewMode } from "./types.js";

const HEADROOM = 256 * 1024 ** 2;
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

export { isMounted } from "./fs.js";
export async function releaseView(view: SourceView): Promise<void> {
  // Old mount-backed records cannot be safely detached by this version. Keep the
  // record and its leases for an administrator to resolve instead of deleting a mount.
  if ((view.adapter as string) === "overlay")
    throw new Error("Legacy OverlayFS workspace recovery requires manual cleanup; leases retained");
  if (await isMounted(view.path))
    throw new Error("Refusing unknown mount during workspace teardown");
  if (view.adapter === "read-only") {
    const info = await lstat(view.path).catch(() => undefined);
    if (info?.isSymbolicLink()) await unlink(view.path);
    else if (info) await removeTree(view.path);
  } else await removeTree(view.path);
  if (view.statePath) await removeTree(view.statePath);
}
export class CheckoutFactory {
  private probe?: Promise<AdapterKind>;
  constructor(
    private runtime: string,
    private cache: string,
    private acquisitionLockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    private viewMode: ViewMode = "auto",
  ) {}
  async selected(
    seedSource: string,
    stateRoot: string,
    beforeProbe: (view: SourceView) => Promise<void>,
    destination: string,
  ): Promise<AdapterKind> {
    if (this.viewMode === "copy-only") return "copy";
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
      adapter: "reflink",
      seedSource,
      path: join(state, "view"),
      statePath: state,
    };
    await beforeProbe(probeView);
    await mkdir(state, { recursive: true, mode: 0o700 });
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
      return "reflink";
    } catch {
      return "copy";
    } finally {
      await removeTree(state);
    }
  }
  async create(view: SourceView, gitSource = false): Promise<void> {
    if ((view.adapter as string) === "overlay")
      throw new Error("OverlayFS views are no longer supported");
    if (view.adapter !== "copy" && view.adapter !== "reflink")
      throw new Error("Unsupported writable view adapter");
    if (this.viewMode === "copy-only" && view.adapter !== "copy")
      throw new Error("Copy-only workspace refuses reflink views");
    contained(this.runtime, view.path);
    await mkdir(dirname(view.path), { recursive: true, mode: 0o700 });
    const operation = async () => {
      if (view.adapter === "copy") {
        const estimate = await conservativeCopyBytes(view.seedSource);
        const fs = await statfs(this.runtime);
        const free = Number(fs.bavail) * Number(fs.bsize);
        if (estimate * 1.1 + HEADROOM > free)
          throw new Error("Private full-copy checkout cannot fit available disk with headroom");
      }
      await copyTree(view.seedSource, view.path, view.adapter === "reflink");
      await protect(view.path, true, gitSource);
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
async function copyPhysicalProtected(
  source: string,
  path: string,
  caseIndex?: number,
  sourceIndex?: number,
  sourceCount?: number,
): Promise<void> {
  publishProgress("protected-copy-start", caseIndex, sourceIndex, sourceCount);
  await copyTree(source, path, false);
  publishProgress("protected-copy-finished", caseIndex, sourceIndex, sourceCount, "ok");
}

export async function prepareProtectedCopy(
  source: string,
  path: string,
  viewMode: ViewMode = "auto",
  caseIndex?: number,
  sourceIndex?: number,
  sourceCount?: number,
): Promise<void> {
  if (viewMode === "copy-only")
    await copyPhysicalProtected(source, path, caseIndex, sourceIndex, sourceCount);
  else {
    try {
      await copyTree(source, path, true);
    } catch {
      await removeTree(path);
      await copyPhysicalProtected(source, path, caseIndex, sourceIndex, sourceCount);
    }
  }
  await protect(path, false);
}
