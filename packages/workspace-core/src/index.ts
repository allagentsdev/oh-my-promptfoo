import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir, readdir, realpath, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DEFAULT_LOCK_TIMEOUT_MS, withLock } from "./cache-lock.js";
import { CheckoutFactory, releaseView } from "./checkout.js";
import { canonicalJson, DEFAULT_LIMITS, validateWorkspace } from "./config.js";
import {
  alive,
  assertNoSymlinkAncestors,
  assertNoSymlinkPath,
  atomicJson,
  contained,
  exists,
  json,
  MARKER,
  ownedRoot,
  PACKAGE,
  processIdentity,
  removeTree,
} from "./fs.js";
import { PreparedSources, preparedKey } from "./prebuilt.js";
import { publishProgress } from "./progress.js";
import {
  initializeCacheRoot,
  manifestDigest,
  protectedCheckoutKey,
  SeedCache,
} from "./seed-cache.js";
import { resolveSources } from "./sources/index.js";
import type {
  Ownership,
  ProcessIdentity,
  RecoveryRecord,
  ResolvedSource,
  RuntimeChannels,
  SourceView,
  WorkspaceHandle,
  WorkspaceSpec,
} from "./types.js";

export { canonicalJson, DEFAULT_LIMITS, RUNTIME_CHANNELS, validateWorkspace } from "./config.js";
export { helperInvoke } from "./helper.js";
export { CACHE_CEILING, CACHE_MAX_AGE, manifestDigest, SeedCache } from "./seed-cache.js";
export * from "./types.js";
export function roots(channels: RuntimeChannels): { cache: string; runtime: string } {
  const cache = resolve(
    channels.ALLAGENTS_CACHE_ROOT ??
      join(
        process.platform === "darwin"
          ? join(homedir(), "Library", "Caches")
          : (process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache")),
        "allagents",
        "promptfoo-integration",
      ),
  );
  const runtime = resolve(
    channels.ALLAGENTS_WORKSPACE_ROOT ??
      join(realpathSync(tmpdir()), `allagents-promptfoo-${process.getuid?.() ?? "user"}`),
  );
  const overlaps = (a: string, b: string) => {
    const rel = relative(a, b);
    return !rel || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
  };
  if (overlaps(cache, runtime) || overlaps(runtime, cache))
    throw new Error("Cache and workspace roots must be distinct and non-overlapping");
  return { cache, runtime };
}
export class WorkspaceManager {
  readonly spec: WorkspaceSpec;
  private cache!: SeedCache;
  private factory!: CheckoutFactory;
  private root!: string;
  private identity!: ProcessIdentity;
  private readonly handles = new Map<string, RecoveryRecord>();
  private readonly prebuiltStamps = new Map<string, string>();
  private readonly invalidPrebuilt = new Set<string>();
  private readonly active = new Set<Promise<WorkspaceHandle>>();
  private closed = false;
  private readonly shutdown = new AbortController();
  private initialization: Promise<void>;
  private readonly acquisitionLockTimeoutMs: number;
  constructor(
    spec: WorkspaceSpec,
    private channels: RuntimeChannels,
  ) {
    this.spec = validateWorkspace(spec);
    this.acquisitionLockTimeoutMs = Math.max(
      DEFAULT_LOCK_TIMEOUT_MS,
      this.spec.limits?.timeoutMs ?? DEFAULT_LIMITS.timeoutMs,
    );
    const locations = roots(channels);
    this.initialization = this.initialize(locations);
    this.initialization.catch(() => {});
  }
  private async initialize(locations: { cache: string; runtime: string }): Promise<void> {
    await initializeCacheRoot(locations.cache, this.acquisitionLockTimeoutMs);
    await ownedRoot(locations.runtime, "runtime-parent");
    this.cache = new SeedCache(locations.cache, this.acquisitionLockTimeoutMs);
    await this.cache.initialize();
    this.identity = await processIdentity();
    // Managers using different caches can still share a runtime parent.
    const runtimeLock = join(
      dirname(locations.runtime),
      `.${basename(locations.runtime)}.allagents-runtime-initialization`,
    );
    await withLock(
      runtimeLock,
      async () => {
        await this.recoverAbandoned(locations.runtime);
        this.root = join(locations.runtime, randomUUID());
        await mkdir(this.root, { mode: 0o700 });
        await atomicJson(join(this.root, MARKER), {
          schemaVersion: 1,
          package: PACKAGE,
          kind: "runtime-provider",
          identity: this.identity,
        });
        await mkdir(join(this.root, "records"), { mode: 0o700 });
        await mkdir(join(this.root, "workspaces"), { mode: 0o700 });
        await mkdir(join(this.root, "adapter-state"), { mode: 0o700 });
      },
      undefined,
      this.acquisitionLockTimeoutMs,
    );
    this.factory = new CheckoutFactory(
      this.root,
      this.cache.root,
      this.acquisitionLockTimeoutMs,
      this.spec.viewMode,
    );
    try {
      const report = await this.cache.prune();
      if (report.errors.length)
        process.emitWarning(`Workspace cache collection: ${report.errors.slice(0, 3).join("; ")}`);
    } catch (error) {
      process.emitWarning(`Workspace cache collection: ${String(error).slice(0, 2048)}`);
    }
  }
  prepare(signal?: AbortSignal, caseIndex?: number): Promise<WorkspaceHandle> {
    if (this.closed) return Promise.reject(new Error("Workspace manager closed"));
    signal?.throwIfAborted();
    const call = this.prepareInner(signal, caseIndex);
    this.active.add(call);
    call.finally(() => this.active.delete(call)).catch(() => {});
    return call;
  }
  private async prepareInner(signal?: AbortSignal, caseIndex?: number): Promise<WorkspaceHandle> {
    await this.initialization;
    signal?.throwIfAborted();
    if (this.closed) throw new Error("Workspace manager closed");
    const combined = AbortSignal.any([
      this.shutdown.signal,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(this.spec.limits?.timeoutMs ?? DEFAULT_LIMITS.timeoutMs),
    ]);
    const prebuilt =
      this.channels.ALLAGENTS_PREBUILT_ROOT !== undefined
        ? await PreparedSources.open(
            this.channels.ALLAGENTS_PREBUILT_ROOT,
            this.spec,
            this.channels,
            roots(this.channels).cache,
            roots(this.channels).runtime,
          )
        : undefined;
    const preparedSources = new Map<string, ResolvedSource>();
    for (const source of this.spec.sources) {
      if (source.type !== "git") continue;
      const prepared = prebuilt?.resolves(source);
      if (prepared) preparedSources.set(source.destination, prepared);
    }
    const ordinary = this.spec.sources.filter((source) => !preparedSources.has(source.destination));
    const normal = ordinary.length
      ? await resolveSources({ ...this.spec, sources: ordinary }, this.channels, combined)
      : [];
    const resolved = [...normal, ...preparedSources.values()].sort((a, b) =>
      a.destination < b.destination ? -1 : a.destination > b.destination ? 1 : 0,
    );
    const metadata = normal.length
      ? await this.cache.prepare(
          normal,
          { ...DEFAULT_LIMITS, ...this.spec.limits },
          this.channels,
          combined,
          undefined,
          caseIndex,
        )
      : undefined;
    const id = randomUUID();
    const path = join(this.root, "workspaces", id);
    const record: RecoveryRecord = {
      schemaVersion: 1,
      id,
      root: this.root,
      path,
      digest: metadata?.digest ?? manifestDigest(resolved),
      identity: this.identity,
      status: "pending",
      seedLease: false,
      views: [],
    };
    // Teardown intent exists before the first inode tree or lease can be created.
    await this.save(record);
    this.handles.set(path, record);
    try {
      if (metadata) {
        record.seedLease = true;
        await this.save(record);
        // Pruning may run between resolution and pending-record publication.
        await this.cache.prepare(
          normal,
          { ...DEFAULT_LIMITS, ...this.spec.limits },
          this.channels,
          combined,
          record,
          caseIndex,
        );
      }
      await mkdir(path, { mode: 0o700 });
      for (let sourceOffset = 0; sourceOffset < resolved.length; sourceOffset++) {
        const source = resolved[sourceOffset];
        combined.throwIfAborted();
        const dest = join(path, source.destination);
        contained(path, dest);
        await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
        if (source.type === "git" && prebuilt && preparedSources.has(source.destination)) {
          const key = preparedKey(source);
          if (this.invalidPrebuilt.has(key))
            throw new Error("Prepared source checkout was invalidated");
          const view: SourceView = {
            destination: source.destination,
            adapter: "read-only",
            seedSource: prebuilt.path(source),
            path: dest,
            prebuiltRoot: prebuilt.root,
            prebuiltKey: key,
          };
          record.views.push(view);
          await this.save(record);
          try {
            view.prebuiltStamp = await prebuilt.check(source, this.prebuiltStamps.get(key));
            const established = this.prebuiltStamps.get(key);
            if (
              this.invalidPrebuilt.has(key) ||
              (established !== undefined && established !== view.prebuiltStamp)
            )
              throw new Error("Prepared source checkout mutated");
            this.prebuiltStamps.set(key, view.prebuiltStamp);
          } catch {
            this.invalidPrebuilt.add(key);
            throw new Error("Prepared source checkout failed integrity verification");
          }
          await this.save(record);
          await symlink(view.seedSource, dest);
        } else if (source.permissions === "read-only") {
          const key = protectedCheckoutKey(source, this.spec.viewMode);
          const view: SourceView = {
            destination: source.destination,
            adapter: "read-only",
            seedSource: join(this.cache.seedPath(record.digest), source.destination),
            path: dest,
            checkoutKey: key,
          };
          record.views.push(view);
          await this.save(record);
          const prepared = await this.cache.protectedSource(
            record,
            source,
            combined,
            this.spec.viewMode,
            caseIndex,
            sourceOffset + 1,
            resolved.length,
          );
          await symlink(prepared.path, dest);
        } else {
          const seedSource = join(this.cache.seedPath(record.digest), source.destination);
          const adapter = await this.factory.selected(
            seedSource,
            join(this.root, "adapter-state", id),
            async (probe) => {
              record.views.push(probe);
              await this.save(record);
            },
            source.destination,
          );
          const view: SourceView = {
            destination: source.destination,
            adapter,
            seedSource,
            path: dest,
          };
          record.views.push(view);
          await this.save(record);
          await this.factory.create(view, source.type === "git");
        }
      }
      record.status = "active";
      await this.save(record);
      publishProgress("workspace-ready", caseIndex);
      return {
        path,
        manifestDigest: manifestDigest(resolved),
        sources: resolved.map((s) => ({ ...s })),
        seedPath: metadata ? this.cache.seedPath(record.digest) : "",
        adapters: record.views.filter((v) => !v.probe).map((v) => ({ ...v })),
      };
    } catch (error) {
      try {
        await this.teardown(record);
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "Workspace preparation failed; dependent leases retained after failed teardown",
        );
      }
      throw error;
    }
  }
  private async save(record: RecoveryRecord): Promise<void> {
    await atomicJson(join(record.root, "records", `${record.id}.json`), record);
  }
  private async validateRecord(record: RecoveryRecord, root: string): Promise<void> {
    if (
      record.schemaVersion !== 1 ||
      record.root !== root ||
      !/^sha256:[a-f0-9]{64}$/.test(record.digest) ||
      !/^[a-f0-9-]{36}$/.test(record.id) ||
      !["pending", "active", "released"].includes(record.status) ||
      !Array.isArray(record.views)
    )
      throw new Error("Malformed workspace recovery record");
    if (record.path !== join(root, "workspaces", record.id))
      throw new Error("Escaping workspace recovery path");
    contained(root, record.path);
    await assertNoSymlinkPath(dirname(root), root);
    const marker = await json<Ownership>(join(root, MARKER));
    if (
      marker.package !== PACKAGE ||
      marker.kind !== "runtime-provider" ||
      canonicalJson(marker.identity) !== canonicalJson(record.identity)
    )
      throw new Error("Workspace recovery ownership mismatch");
    for (const view of record.views) {
      if ((view.adapter as string) === "overlay")
        throw new Error(
          "Legacy OverlayFS workspace recovery requires manual cleanup; leases retained",
        );
      if (await exists(dirname(view.path))) await assertNoSymlinkPath(root, dirname(view.path));
      if (
        !["reflink", "copy", "read-only"].includes(view.adapter) ||
        (!view.probe && view.path !== join(record.path, view.destination))
      )
        throw new Error("Invalid view recovery state");
      if (view.probe) {
        contained(join(root, "adapter-state", record.id), view.path);
        if (
          view.path !== join(view.statePath ?? "", "view") &&
          // Reflink probes from before mount support was removed used this path.
          !(view.adapter === "reflink" && view.path === join(view.statePath ?? "", "mount"))
        )
          throw new Error("Invalid probe recovery state");
      } else contained(record.path, view.path);
      if (view.prebuiltKey) {
        if (
          view.checkoutKey ||
          view.adapter !== "read-only" ||
          view.probe ||
          !/^[a-f0-9]{64}$/.test(view.prebuiltKey) ||
          !view.prebuiltRoot ||
          !isAbsolute(view.prebuiltRoot) ||
          view.seedSource !== join(view.prebuiltRoot, "sources", view.prebuiltKey, "protected")
        )
          throw new Error("Invalid prepared source recovery state");
        const { cache, runtime } = roots(this.channels);
        for (const other of [cache, runtime]) {
          const a = relative(view.prebuiltRoot, other);
          const b = relative(other, view.prebuiltRoot);
          if (
            [a, b].some(
              (v) => !v || (v !== ".." && !v.startsWith(`..${sep}`) && !v.startsWith(sep)),
            )
          )
            throw new Error("Prepared source recovery overlaps package roots");
        }
      } else if (view.seedSource !== join(this.cache.seedPath(record.digest), view.destination))
        throw new Error("Invalid seed recovery state");
      if (view.statePath) contained(join(root, "adapter-state", record.id), view.statePath);
      if (
        view.adapter === "read-only" &&
        !view.prebuiltKey &&
        !/^[a-f0-9]{64}$/.test(view.checkoutKey ?? "")
      )
        throw new Error("Invalid checkout recovery state");
    }
  }
  private async teardown(record: RecoveryRecord): Promise<void> {
    const current = await json<RecoveryRecord>(join(record.root, "records", `${record.id}.json`));
    await this.validateRecord(current, record.root);
    if (current.status === "released") return;
    // Dependency chain is deliberately sequential. A failed detach retains every lease.
    for (const view of [...current.views].reverse()) await releaseView(view);
    await this.rejectMounts(current.path);
    await removeTree(current.path);
    for (const view of current.views)
      if (view.checkoutKey) await this.cache.releaseProtected(current, view.checkoutKey);
    if (current.seedLease) await this.cache.release(current);
    current.status = "released";
    await this.save(current);
    this.handles.delete(current.path);
  }
  private async rejectMounts(root: string): Promise<void> {
    if (process.platform !== "linux") return;
    const { readFile } = await import("node:fs/promises");
    const mounts = (await readFile("/proc/self/mountinfo", "utf8"))
      .split("\n")
      .map((line) =>
        line
          .split(" ")[4]
          ?.replace(/\\([0-7]{3})/g, (_, oct: string) =>
            String.fromCharCode(Number.parseInt(oct, 8)),
          ),
      )
      .filter(Boolean) as string[];
    if (mounts.some((path) => path === root || path.startsWith(`${root}/`)))
      throw new Error("Unknown mount blocks workspace removal and lease release");
  }
  async validateProtected(handle: WorkspaceHandle, caseIndex?: number): Promise<void> {
    await this.initialization;
    const ordinal =
      caseIndex !== undefined && Number.isSafeInteger(caseIndex) && caseIndex > 0
        ? caseIndex
        : undefined;
    let sourceCount = 0;
    if (ordinal !== undefined)
      for (const view of handle.adapters) if (view.prebuiltKey) sourceCount++;
    let sourceIndex = 0;
    for (const view of handle.adapters) {
      if (view.checkoutKey) await this.cache.checkProtected(view.checkoutKey);
      if (view.prebuiltKey) {
        sourceIndex++;
        const source = handle.sources.find((item) => item.destination === view.destination);
        if (
          !source ||
          source.type !== "git" ||
          preparedKey(source) !== view.prebuiltKey ||
          !view.prebuiltRoot ||
          this.channels.ALLAGENTS_PREBUILT_ROOT !== view.prebuiltRoot ||
          !view.prebuiltStamp ||
          this.invalidPrebuilt.has(view.prebuiltKey)
        )
          throw new Error("Prepared source identity mismatch");
        try {
          const prepared = await PreparedSources.open(
            view.prebuiltRoot,
            this.spec,
            this.channels,
            roots(this.channels).cache,
            roots(this.channels).runtime,
          );
          await prepared.check(
            source,
            view.prebuiltStamp,
            ordinal !== undefined ? { caseIndex: ordinal, sourceIndex, sourceCount } : undefined,
          );
        } catch (error) {
          this.invalidPrebuilt.add(view.prebuiltKey);
          throw error;
        }
      }
    }
  }
  async release(handle: WorkspaceHandle): Promise<void> {
    await this.initialization;
    const record = this.handles.get(handle.path);
    if (record) await this.teardown(record);
  }
  async cleanup(): Promise<void> {
    this.closed = true;
    this.shutdown.abort(new Error("Workspace manager cleanup"));
    // Initialization must finish recovering abandoned resources even when this
    // manager has no rows. Cancellation applies to acquisition waits, not recovery.
    await this.initialization;
    await Promise.allSettled([...this.active]);
    const outcomes = await Promise.allSettled(
      [...this.handles.values()].map((record) => this.teardown(record)),
    );
    const errors = outcomes
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => r.reason);
    if (!errors.length) {
      await this.rejectMounts(this.root);
      await removeTree(this.root);
    }
    try {
      const report = await this.cache.prune();
      if (report.errors.length)
        process.emitWarning(
          `Workspace cache collection after cleanup: ${report.errors.slice(0, 3).join("; ")}`,
        );
    } catch (error) {
      process.emitWarning(
        `Workspace cache collection after cleanup: ${String(error).slice(0, 2048)}`,
      );
    }
    if (errors.length)
      throw new AggregateError(errors, "Workspace cleanup retained failed records and leases");
  }
  private async recoverAbandoned(parent: string): Promise<void> {
    for (const name of await readdir(parent)) {
      if (name === MARKER) continue;
      if (!/^[a-f0-9-]{36}$/.test(name)) throw new Error("Unknown path in package runtime parent");
      const root = join(parent, name);
      if ((await lstat(root)).isSymbolicLink()) throw new Error("Symlink runtime root refused");
      if (process.platform === "win32") await assertNoSymlinkAncestors(root);
      else if ((await realpath(root)) !== root) throw new Error("Symlink runtime root refused");
      const marker = await json<Ownership>(join(root, MARKER));
      if (marker.package !== PACKAGE || marker.kind !== "runtime-provider" || !marker.identity)
        throw new Error("Unmarked runtime provider root");
      if (await alive(marker.identity)) continue;
      const records = join(root, "records");
      if (!(await exists(records))) {
        await this.rejectMounts(root);
        await removeTree(root);
        continue;
      }
      const outcomes = await Promise.allSettled(
        (await readdir(records)).map(async (filename) => {
          if (!/^[a-f0-9-]{36}\.json$/.test(filename)) throw new Error("Unknown recovery record");
          const record = await json<RecoveryRecord>(join(records, filename));
          await this.validateRecord(record, root);
          await this.teardown(record);
        }),
      );
      const errors = outcomes
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => r.reason);
      if (errors.length)
        throw new AggregateError(
          errors,
          "Abandoned workspace recovery refused unsafe or mounted paths",
        );
      await this.rejectMounts(root);
      await removeTree(root);
    }
  }
}
export async function pruneCache(channels: RuntimeChannels = {}, all = false) {
  const { cache } = roots(channels);
  await initializeCacheRoot(cache);
  const store = new SeedCache(cache);
  await store.initialize();
  const report = await store.prune(all);
  if (report.errors.length)
    throw new AggregateError(
      report.errors.map((e) => new Error(e)),
      "Cache prune incomplete",
    );
  return report;
}
