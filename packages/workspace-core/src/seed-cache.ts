import { randomUUID } from "node:crypto";
import { mkdir, readdir, realpath, rename, statfs } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { acquisitionPhysicalReservation } from "./acquisition-budget.js";
import { DEFAULT_LOCK_TIMEOUT_MS, withLock } from "./cache-lock.js";
import { prepareProtectedCopy } from "./checkout.js";
import { canonicalJson } from "./config.js";
import {
  alive,
  allocated,
  assertNoSymlinkAncestors,
  assertNoSymlinkPath,
  atomicJson,
  conservativeCopyBytes,
  contained,
  exists,
  hash,
  inventory,
  json,
  MARKER,
  ownedRoot,
  PACKAGE,
  processIdentity,
  protect,
  removeTree,
  treeStamp,
} from "./fs.js";
import { materializeSources } from "./sources/index.js";
import type {
  Digest,
  PruneReport,
  RecoveryRecord,
  ResolvedSource,
  RuntimeChannels,
  SeedMetadata,
  SourceLimits,
} from "./types.js";
export const CACHE_CEILING = 50 * 1024 ** 3;
export const CACHE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
export function acquisitionIdentity(source: ResolvedSource): Record<string, unknown> {
  return source.type === "git"
    ? {
        type: source.type,
        repository: source.repository,
        commit: source.commit,
        destination: source.destination,
        materializerVersion: source.materializerVersion ?? 1,
      }
    : {
        type: source.type,
        repository: source.repository,
        digest: source.digest,
        destination: source.destination,
        materializerVersion: source.materializerVersion ?? 1,
      };
}
export function manifestDigest(sources: ResolvedSource[]): Digest {
  const identities = [...sources]
    .sort((a, b) => (a.destination < b.destination ? -1 : a.destination > b.destination ? 1 : 0))
    .map(acquisitionIdentity);
  return `sha256:${hash(canonicalJson({ schemaVersion: 1, sources: identities }))}`;
}
const MAX_INVENTORY_JSON_BYTES = 512 * 1024 ** 2;

export class SeedCache {
  private readonly verified = new Map<Digest, SeedMetadata>();
  constructor(
    readonly root: string,
    private readonly acquisitionLockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  ) {}
  private lockAcquisition<T>(path: string, operation: () => Promise<T>, signal?: AbortSignal) {
    return withLock(path, operation, signal, this.acquisitionLockTimeoutMs);
  }
  async initialize(signal?: AbortSignal): Promise<void> {
    for (const name of [
      "published",
      "leases",
      "checkouts",
      "checkout-leases",
      "locks",
      "staging",
      "trash",
    ]) {
      await mkdir(join(this.root, name), { recursive: true, mode: 0o700 });
      await assertNoSymlinkPath(this.root, join(this.root, name));
    }
    await this.lockAcquisition(
      join(this.root, "locks", "admission"),
      () => this.recoverStaging(),
      signal,
    );
  }

  private async recoverStaging(): Promise<void> {
    for (const name of await readdir(join(this.root, "staging"))) {
      if (!/^[a-f0-9-]{36}$/.test(name)) throw new Error("Unknown cache staging entry");
      const stage = join(this.root, "staging", name);
      await assertNoSymlinkPath(this.root, stage);
      if (!(await exists(join(stage, "staging.json")))) {
        if (await exists(join(stage, "metadata.json"))) {
          const metadata = await json<{ schemaVersion: number; package: string }>(
            join(stage, "metadata.json"),
            MAX_INVENTORY_JSON_BYTES,
          );
          if (metadata.package === PACKAGE && metadata.schemaVersion === 1) {
            await removeTree(stage);
            continue;
          }
        }
        throw new Error("Unmarked incomplete cache staging entry");
      }
      const owner = await json<{
        schemaVersion: number;
        package: string;
        path: string;
        identity: import("./types.js").ProcessIdentity;
      }>(join(stage, "staging.json"));
      if (
        owner.schemaVersion !== 1 ||
        owner.package !== PACKAGE ||
        owner.path !== stage ||
        !owner.identity
      )
        throw new Error("Invalid cache staging ownership");
      if (await alive(owner.identity)) continue;
      if (process.platform === "linux") {
        const { readFile } = await import("node:fs/promises");
        const mounts = (await readFile("/proc/self/mountinfo", "utf8"))
          .split("\n")
          .map((line) => ({
            path: line
              .split(" ")[4]
              ?.replace(/\\([0-7]{3})/g, (_, oct: string) =>
                String.fromCharCode(Number.parseInt(oct, 8)),
              ),
            type: line.split(" - ")[1]?.split(" ")[0],
          }))
          .filter((m) => m.path === stage || m.path?.startsWith(`${stage}/`));
        for (const mount of mounts) {
          if (mount.type !== "tmpfs" || !mount.path) throw new Error("Unknown cache staging mount");
          const records = await readdir(join(stage, "tree"));
          let allowed = false;
          for (const file of records.filter(
            (n) => n === ".allagents-acquisition.json" || /^acquisition-[a-f0-9-]+\.json$/.test(n),
          )) {
            const record = await json<{
              schemaVersion: number;
              package: string;
              path: string;
              identity: import("./types.js").ProcessIdentity;
            }>(join(stage, "tree", file));
            if (
              record.schemaVersion === 1 &&
              record.package === PACKAGE &&
              record.path === mount.path &&
              canonicalJson(record.identity) === canonicalJson(owner.identity)
            )
              allowed = true;
          }
          if (!allowed) throw new Error("Unrecorded cache staging mount; refusing recovery");
          const { helperInvoke } = await import("./helper.js");
          await helperInvoke("release-tmpfs", [mount.path]);
        }
      }
      await removeTree(stage);
    }
  }
  key(digest: string): string {
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid cache digest");
    return digest.slice(7);
  }
  seedPath(digest: Digest): string {
    return join(this.root, "published", this.key(digest), "tree");
  }
  private digestLock(digest: Digest): string {
    return join(this.root, "locks", this.key(digest));
  }
  async verify(digest: Digest): Promise<SeedMetadata> {
    const entry = join(this.root, "published", this.key(digest));
    contained(this.root, entry);
    await assertNoSymlinkPath(this.root, join(entry, "tree"));
    const metadata = await json<SeedMetadata>(
      join(entry, "metadata.json"),
      MAX_INVENTORY_JSON_BYTES,
    );
    if (
      metadata.package !== PACKAGE ||
      metadata.schemaVersion !== 1 ||
      metadata.digest !== digest ||
      manifestDigest(metadata.sources) !== digest
    )
      throw new Error("Seed verification metadata invalid");
    const actual = await inventory(join(entry, "tree"));
    // Protection intentionally changes only write bits; executable bits remain provenance.
    const identity = (entries: SeedMetadata["inventory"]) =>
      entries.map((e) => ({ ...e, mode: e.mode & 0o111 }));
    if (canonicalJson(identity(actual)) !== canonicalJson(identity(metadata.inventory)))
      throw new Error("Cached seed integrity verification failed");
    this.verified.set(digest, metadata);
    return metadata;
  }
  private async verifiedSeed(digest: Digest): Promise<SeedMetadata> {
    const known = this.verified.get(digest);
    if (!known) return this.verify(digest);
    await assertNoSymlinkPath(this.root, this.seedPath(digest));
    const current = await json<SeedMetadata>(
      join(this.root, "published", this.key(digest), "metadata.json"),
      MAX_INVENTORY_JSON_BYTES,
    );
    if (
      current.package !== PACKAGE ||
      current.schemaVersion !== 1 ||
      current.digest !== digest ||
      manifestDigest(current.sources) !== digest ||
      current.createdAt !== known.createdAt
    )
      throw new Error("Seed verification metadata changed");
    return current;
  }
  // Callers hold admission and exclude their own digest from eviction. Atomic
  // replacement temporarily retains both inventories and must reserve the new one.
  private async writeMetadata(
    path: string,
    value: unknown,
    digest: Digest,
    checkoutKey?: string,
  ): Promise<void> {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > MAX_INVENTORY_JSON_BYTES) throw new Error("Inventory metadata exceeds write bound");
    await this.admit(bytes + 1024 ** 2, digest, checkoutKey);
    await atomicJson(path, value, MAX_INVENTORY_JSON_BYTES);
  }
  async prepare(
    sources: ResolvedSource[],
    limits: SourceLimits,
    channels: RuntimeChannels,
    signal?: AbortSignal,
    lease?: RecoveryRecord,
  ): Promise<SeedMetadata> {
    const digest = manifestDigest(sources);
    if (lease && lease.digest !== digest) throw new Error("Lease digest must match prepared seed");
    return withLock(
      join(this.root, "locks", "admission"),
      () =>
        withLock(
          this.digestLock(digest),
          async () => {
            signal?.throwIfAborted();
            if (await exists(join(this.root, "published", this.key(digest)))) {
              const metadata = await this.verifiedSeed(digest);
              metadata.lastUsed = Date.now();
              await this.writeMetadata(
                join(this.root, "published", this.key(digest), "metadata.json"),
                metadata,
                digest,
              );
              if (lease) await this.writeLease(lease);
              return metadata;
            }
            // Bound acquisitions reserve simultaneous temporary and final bytes plus filesystem overhead.
            const reservation =
              acquisitionPhysicalReservation(sources, limits) +
              MAX_INVENTORY_JSON_BYTES +
              1024 ** 2;
            await this.admit(reservation, digest);
            const staging = join(this.root, "staging", randomUUID());
            await mkdir(staging, { mode: 0o700 });
            await atomicJson(join(staging, "staging.json"), {
              schemaVersion: 1,
              package: PACKAGE,
              path: staging,
              identity: await processIdentity(),
            });
            const tree = join(staging, "tree");
            await mkdir(tree);
            try {
              await materializeSources(sources, tree, limits, channels, signal);
              signal?.throwIfAborted();
              const contents = await inventory(tree);
              const actual = await allocated(staging);
              if (actual > reservation)
                throw new Error("Seed exceeds physical staging reservation");
              await protect(tree, false);
              const metadata: SeedMetadata = {
                schemaVersion: 1,
                package: PACKAGE,
                digest,
                sources: sources.map((s) => ({ ...s })),
                inventory: contents,
                allocatedBytes: await allocated(tree),
                createdAt: Date.now(),
                lastUsed: Date.now(),
              };
              await this.writeMetadata(join(staging, "metadata.json"), metadata, digest);
              if ((await allocated(staging)) > reservation)
                throw new Error("Seed metadata exceeds physical staging reservation");
              const { unlink } = await import("node:fs/promises");
              await unlink(join(staging, "staging.json"));
              await rename(staging, join(this.root, "published", this.key(digest)));
              this.verified.set(digest, metadata);
              if (lease) await this.writeLease(lease);
              return metadata;
            } catch (error) {
              // Never delete a still-mounted acquisition tree.
              const { readFile } = await import("node:fs/promises");
              const mounted =
                process.platform === "linux" &&
                (await readFile("/proc/self/mountinfo", "utf8")).split("\n").some((line) => {
                  const path = line
                    .split(" ")[4]
                    ?.replace(/\\([0-7]{3})/g, (_, oct: string) =>
                      String.fromCharCode(Number.parseInt(oct, 8)),
                    );
                  return path === staging || path?.startsWith(`${staging}/`);
                });
              if (mounted)
                throw new AggregateError(
                  [error],
                  "Seed acquisition retained mounted staging for administrator recovery",
                );
              await removeTree(staging);
              throw error;
            }
          },
          signal,
          Math.max(this.acquisitionLockTimeoutMs, limits.timeoutMs),
        ),
      signal,
      Math.max(this.acquisitionLockTimeoutMs, limits.timeoutMs),
    );
  }
  private async writeLease(record: RecoveryRecord): Promise<void> {
    const intent = await json<RecoveryRecord>(join(record.root, "records", `${record.id}.json`));
    if (
      intent.id !== record.id ||
      intent.digest !== record.digest ||
      intent.path !== record.path ||
      intent.root !== record.root ||
      !intent.seedLease ||
      intent.status === "released"
    )
      throw new Error("Seed lease requires matching pending recovery intent");
    await atomicJson(join(this.root, "leases", this.key(record.digest), `${record.id}.json`), {
      schemaVersion: 1,
      package: PACKAGE,
      id: record.id,
      root: record.root,
      path: record.path,
      identity: record.identity,
    });
  }
  async lease(record: RecoveryRecord): Promise<void> {
    await withLock(this.digestLock(record.digest), async () => {
      await this.verifiedSeed(record.digest);
      await this.writeLease(record);
    });
  }
  async release(record: RecoveryRecord): Promise<void> {
    await withLock(this.digestLock(record.digest), async () => {
      const path = join(this.root, "leases", this.key(record.digest), `${record.id}.json`);
      contained(this.root, path);
      if (await exists(path)) {
        const existing = await json<{ root: string; id: string }>(path);
        if (existing.root !== record.root || existing.id !== record.id)
          throw new Error("Lease ownership mismatch");
        const { unlink } = await import("node:fs/promises");
        await unlink(path);
      }
    });
  }
  async protectedSource(
    record: RecoveryRecord,
    source: ResolvedSource,
    signal?: AbortSignal,
  ): Promise<{ key: string; path: string }> {
    const key = hash(canonicalJson(acquisitionIdentity(source)));
    const path = join(this.root, "checkouts", key, "tree");
    return this.lockAcquisition(
      join(this.root, "locks", "admission"),
      () =>
        this.lockAcquisition(
          this.digestLock(record.digest),
          async () => {
            const metadataPath = join(this.root, "checkouts", key, "metadata.json");
            if (await exists(metadataPath)) {
              await assertNoSymlinkPath(this.root, path);
              const metadata = await json<{
                digest: Digest;
                inventory: SeedMetadata["inventory"];
                stamp: string;
                invalid?: boolean;
              }>(metadataPath, MAX_INVENTORY_JSON_BYTES);
              if (metadata.invalid || (await treeStamp(path)) !== metadata.stamp) {
                await this.writeMetadata(
                  metadataPath,
                  { ...metadata, invalid: true },
                  record.digest,
                  key,
                );
                throw new Error(
                  "Protected source checkout was unexpectedly mutated and invalidated",
                );
              }
            } else {
              const seedSource = join(this.seedPath(record.digest), source.destination);
              await this.admit(
                (await conservativeCopyBytes(seedSource)) * 1.1 +
                  MAX_INVENTORY_JSON_BYTES +
                  1024 ** 2,
                record.digest,
                key,
              );
              const stage = join(this.root, "staging", randomUUID());
              await mkdir(stage, { mode: 0o700 });
              await atomicJson(join(stage, "staging.json"), {
                schemaVersion: 1,
                package: PACKAGE,
                path: stage,
                identity: await processIdentity(),
              });
              try {
                await prepareProtectedCopy(seedSource, join(stage, "tree"));
                await this.writeMetadata(
                  join(stage, "metadata.json"),
                  {
                    schemaVersion: 1,
                    package: PACKAGE,
                    digest: record.digest,
                    inventory: await inventory(join(stage, "tree")),
                    stamp: await treeStamp(join(stage, "tree")),
                    createdAt: Date.now(),
                    lastUsed: Date.now(),
                  },
                  record.digest,
                  key,
                );
                const { unlink } = await import("node:fs/promises");
                await unlink(join(stage, "staging.json"));
                await rename(stage, join(this.root, "checkouts", key));
                const published = await json<Record<string, unknown>>(
                  metadataPath,
                  MAX_INVENTORY_JSON_BYTES,
                );
                await this.writeMetadata(
                  metadataPath,
                  { ...published, stamp: await treeStamp(path) },
                  record.digest,
                  key,
                );
              } catch (e) {
                await removeTree(stage);
                throw e;
              }
            }
            const current = await json<Record<string, unknown>>(
              metadataPath,
              MAX_INVENTORY_JSON_BYTES,
            );
            await this.writeMetadata(
              metadataPath,
              { ...current, lastUsed: Date.now() },
              record.digest,
              key,
            );
            await atomicJson(join(this.root, "checkout-leases", key, `${record.id}.json`), {
              schemaVersion: 1,
              package: PACKAGE,
              id: record.id,
              root: record.root,
              digest: record.digest,
            });
            return { key, path };
          },
          signal,
        ),
      signal,
    );
  }
  async checkProtected(key: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid protected checkout key");
    await this.lockAcquisition(join(this.root, "locks", "admission"), async () => {
      const metadataPath = join(this.root, "checkouts", key, "metadata.json");
      await assertNoSymlinkPath(this.root, join(this.root, "checkouts", key, "tree"));
      const metadata = await json<{
        digest: Digest;
        inventory: SeedMetadata["inventory"];
        stamp: string;
        invalid?: boolean;
      }>(metadataPath, MAX_INVENTORY_JSON_BYTES);
      await this.lockAcquisition(this.digestLock(metadata.digest), async () => {
        if (
          metadata.invalid ||
          (await treeStamp(join(this.root, "checkouts", key, "tree"))) !== metadata.stamp
        ) {
          await this.writeMetadata(
            metadataPath,
            { ...metadata, invalid: true },
            metadata.digest,
            key,
          );
          throw new Error("Protected source checkout mutated; reuse invalidated");
        }
      });
    });
  }
  async releaseProtected(record: RecoveryRecord, key: string): Promise<void> {
    await withLock(this.digestLock(record.digest), async () => {
      if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid protected checkout key");
      const path = join(this.root, "checkout-leases", key, `${record.id}.json`);
      if (await exists(path)) {
        const owner = await json<{ root: string }>(path);
        if (owner.root !== record.root)
          throw new Error("Protected checkout lease ownership mismatch");
        const { unlink } = await import("node:fs/promises");
        await unlink(path);
      }
    });
  }
  private async leaseCount(directory: string): Promise<number> {
    if (await exists(directory)) await assertNoSymlinkPath(this.root, directory);
    return (
      await readdir(directory).catch((e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") return [];
        throw e;
      })
    ).length;
  }
  async size(): Promise<number> {
    let result = 0;
    for (const name of ["published", "checkouts", "staging", "trash"])
      result += await allocated(join(this.root, name));
    return result;
  }
  private async admit(reservation: number, exclude?: Digest, checkoutKey?: string): Promise<void> {
    if (reservation > CACHE_CEILING)
      throw new Error("Acquisition reservation exceeds 50 GiB cache ceiling");
    await this.collect(false, reservation, exclude, checkoutKey);
    const current = await this.size();
    const disk = await statfs(this.root);
    if (
      current + reservation > CACHE_CEILING ||
      reservation + 256 * 1024 ** 2 > Number(disk.bavail) * Number(disk.bsize)
    )
      throw new Error("Cache physical capacity reservation cannot fit");
  }
  async prune(all = false): Promise<PruneReport> {
    return withLock(join(this.root, "locks", "admission"), () => this.collect(all));
  }
  private async collect(
    all: boolean,
    reservation = 0,
    exclude?: Digest,
    checkoutKey?: string,
  ): Promise<PruneReport> {
    const report: PruneReport = {
      removed: [],
      retained: [],
      allocatedBytes: 0,
      removedBytes: 0,
      retainedBytes: 0,
      errors: [],
    };
    for (const name of await readdir(join(this.root, "trash"))) {
      try {
        await removeTree(contained(this.root, join(this.root, "trash", name)));
      } catch (e) {
        report.errors.push(String(e));
      }
    }
    // Protected trees are evicted before seeds so no backing blocks are orphaned.
    for (const key of await readdir(join(this.root, "checkouts"))) {
      if (!/^[a-f0-9]{64}$/.test(key)) {
        report.errors.push("Unknown protected checkout entry");
        continue;
      }
      const path = join(this.root, "checkouts", key);
      try {
        await assertNoSymlinkPath(this.root, path);
        const meta = await json<{
          package: string;
          schemaVersion: number;
          digest: Digest;
          lastUsed: number;
          invalid?: boolean;
        }>(join(path, "metadata.json"), MAX_INVENTORY_JSON_BYTES);
        if (meta.package !== PACKAGE || meta.schemaVersion !== 1)
          throw new Error("Unowned protected checkout");
        if (
          key === checkoutKey ||
          meta.digest === exclude ||
          (await this.leaseCount(join(this.root, "checkout-leases", key)))
        ) {
          report.retained.push(`checkout:${key}`);
          continue;
        }
        if (
          all ||
          meta.invalid ||
          Date.now() - meta.lastUsed > CACHE_MAX_AGE ||
          (await this.size()) + reservation > CACHE_CEILING
        ) {
          await withLock(this.digestLock(meta.digest), async () => {
            if (await this.leaseCount(join(this.root, "checkout-leases", key))) return;
            const bytes = await allocated(path);
            const trash = join(this.root, "trash", randomUUID());
            await rename(path, trash);
            await removeTree(trash);
            report.removedBytes! += bytes;
            report.removed.push(`checkout:${key}`);
          });
        }
      } catch (e) {
        report.errors.push(String(e));
      }
    }
    const entries: { digest: Digest; lastUsed: number; path: string }[] = [];
    for (const key of await readdir(join(this.root, "published"))) {
      try {
        const digest = `sha256:${key}` as Digest;
        this.key(digest);
        await assertNoSymlinkPath(this.root, join(this.root, "published", key));
        const meta = await json<SeedMetadata>(
          join(this.root, "published", key, "metadata.json"),
          MAX_INVENTORY_JSON_BYTES,
        );
        if (meta.package !== PACKAGE || meta.schemaVersion !== 1 || meta.digest !== digest)
          throw new Error("Unowned seed entry");
        entries.push({ digest, lastUsed: meta.lastUsed, path: join(this.root, "published", key) });
      } catch (e) {
        report.errors.push(String(e));
      }
    }
    for (const entry of entries.sort((a, b) => a.lastUsed - b.lastUsed)) {
      if (entry.digest === exclude) continue;
      await withLock(this.digestLock(entry.digest), async () => {
        const leased = await this.leaseCount(join(this.root, "leases", this.key(entry.digest)));
        let dependent = false;
        for (const key of await readdir(join(this.root, "checkouts"))) {
          const m = await json<{ digest: Digest }>(
            join(this.root, "checkouts", key, "metadata.json"),
            MAX_INVENTORY_JSON_BYTES,
          );
          if (m.digest === entry.digest) dependent = true;
        }
        if (leased || dependent) {
          report.retained.push(entry.digest);
          return;
        }
        if (
          all ||
          Date.now() - entry.lastUsed > CACHE_MAX_AGE ||
          (await this.size()) + reservation > CACHE_CEILING
        ) {
          await this.verify(entry.digest);
          const bytes = await allocated(entry.path);
          const trash = join(this.root, "trash", randomUUID());
          await rename(entry.path, trash);
          await removeTree(trash);
          report.removedBytes! += bytes;
          report.removed.push(entry.digest);
        }
      }).catch((e) => report.errors.push(String(e)));
    }
    report.allocatedBytes = await this.size();
    report.retainedBytes = report.allocatedBytes;
    return {
      ...report,
      removed: report.removed.slice(0, 1000),
      retained: report.retained.slice(0, 1000),
      errors: report.errors.slice(0, 100),
      removedCount: report.removed.length,
      retainedCount: report.retained.length,
    };
  }
}

/** A fresh hosted runner may restore only verified published seeds, never mutable state. */
export async function initializeCacheRoot(
  root: string,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<void> {
  const absolute = resolve(root);
  await assertNoSymlinkAncestors(absolute);
  // A restored root cannot be replaced as an empty directory. Serialize its
  // verification and marker publication before any cache control files exist.
  await withLock(
    join(dirname(absolute), `.${basename(absolute)}.allagents-bootstrap`),
    () => initializeCacheRootLocked(absolute),
    signal,
    timeoutMs,
  );
}
async function initializeCacheRootLocked(absolute: string): Promise<void> {
  if ((await exists(absolute)) && !(await exists(join(absolute, MARKER)))) {
    if ((await realpath(absolute)) !== absolute) throw new Error("Symlinked cache root ancestor");
    await assertNoSymlinkPath(absolute, absolute);
    const entries = await readdir(absolute);
    if (entries.length === 1 && entries[0] === "published") {
      await assertNoSymlinkPath(absolute, join(absolute, "published"));
      const cache = new SeedCache(absolute);
      for (const key of await readdir(join(absolute, "published"))) {
        if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Unowned restored seed entry");
        await cache.verify(`sha256:${key}`);
      }
      await atomicJson(join(absolute, MARKER), {
        schemaVersion: 1,
        package: PACKAGE,
        kind: "cache",
      });
    }
  }
  await ownedRoot(absolute, "cache");
}
