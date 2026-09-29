import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, open, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { establishBaseline } from "../packages/workspace-core/src/file-changes";
import {
  allocated,
  atomicJson,
  inventory,
  PACKAGE,
  protect,
  removeTree,
} from "../packages/workspace-core/src/fs";
import { manifestDigest, pruneCache, WorkspaceManager } from "../packages/workspace-core/src/index";
import type {
  ResolvedSource,
  SeedMetadata,
  WorkspaceHandle,
} from "../packages/workspace-core/src/types";

const root = await mkdtemp(join(realpathSync(tmpdir()), "allagents-scale-"));
const channels = {
  ALLAGENTS_CACHE_ROOT: join(root, "cache"),
  ALLAGENTS_WORKSPACE_ROOT: join(root, "runtime"),
};
const source: ResolvedSource = {
  type: "oci",
  repository: "registry.example.invalid/fixture",
  digest: `sha256:${"a".repeat(64)}`,
  destination: "project",
  permissions: "all",
  materializerVersion: 1,
};
const manager = new WorkspaceManager(
  {
    sources: [
      {
        type: "oci",
        repository: source.repository,
        digest: source.digest,
        destination: source.destination,
        permissions: "all",
      },
    ],
  },
  channels,
);
const count = Number(process.env.ALLAGENTS_SCALE_VIEWS ?? 1000);
const handles: WorkspaceHandle[] = [];
try {
  // A verified restored sparse seed exercises real adapter/cache/runtime paths without network.
  const empty = new WorkspaceManager({ sources: [] }, channels);
  await empty.prepare();
  await empty.cleanup();
  const digest = manifestDigest([source]);
  const entry = join(channels.ALLAGENTS_CACHE_ROOT, "published", digest.slice(7));
  const tree = join(entry, "tree");
  const project = join(tree, "project");
  await mkdir(project, { recursive: true });
  for (let i = 0; i < 1; i++) {
    const file = await open(join(project, `fixture-${i}`), "wx", 0o644);
    await file.truncate(2 * 1024 ** 3);
    await file.close();
  }
  const contents = await inventory(tree);
  await protect(tree, false);
  const metadata: SeedMetadata = {
    schemaVersion: 1,
    package: PACKAGE,
    digest,
    sources: [source],
    inventory: contents,
    allocatedBytes: await allocated(tree),
    createdAt: Date.now(),
    lastUsed: Date.now(),
  };
  await atomicJson(join(entry, "metadata.json"), metadata);
  const start = performance.now();
  for (let i = 0; i < count; i += 16)
    handles.push(
      ...(await Promise.all(
        Array.from({ length: Math.min(16, count - i) }, () => manager.prepare()),
      )),
    );
  const preparedMs = performance.now() - start;
  const adapter = handles[0].adapters[0].adapter;
  if (adapter === "copy") throw Error("Scale gate requires actual copy-on-write, got full copy");
  if (new Set(handles.map((h) => h.path)).size !== count) throw Error("Workspace paths are shared");
  const a = join(handles[0].path, "project", "fixture-0");
  const sibling = join(handles[1].path, "project", "fixture-0");
  const readPrefix = async (path: string) => {
    const fd = await open(path, "r");
    try {
      const buffer = Buffer.alloc(64);
      await fd.read(buffer, 0, 64, 0);
      return buffer;
    } finally {
      await fd.close();
    }
  };
  const before = await readPrefix(sibling);
  await writeFile(a, "private change");
  if (
    !(await readPrefix(sibling)).equals(before) ||
    !(await readPrefix(join(project, "fixture-0"))).equals(before)
  )
    throw Error("Writable view mutated seed or sibling");
  const inodeA = await stat(a),
    inodeB = await stat(sibling);
  if (adapter === "reflink" && inodeA.ino === inodeB.ino) throw Error("Reflink reused inode");
  const baselineStart = performance.now();
  await establishBaseline(handles[0]);
  const baselineMs = performance.now() - baselineStart;
  const seedBytes = await allocated(entry);
  async function observed(path: string): Promise<number> {
    const { lstat, readdir } = await import("node:fs/promises");
    const stat = await lstat(path);
    let bytes = stat.blocks * 512;
    if (stat.isDirectory()) {
      let names: string[];
      try {
        names = await readdir(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EACCES" && path.endsWith("/work/work"))
          return bytes;
        throw error;
      }
      for (const name of names) bytes += await observed(join(path, name));
    }
    return bytes;
  }
  const runtimeBytes = await observed(channels.ALLAGENTS_WORKSPACE_ROOT);
  if (runtimeBytes > 512 * 1024 ** 2)
    throw Error(`CoW runtime allocation exceeded512MiB: ${runtimeBytes}`);
  const cleanupStart = performance.now();
  await manager.cleanup();
  const cleanupMs = performance.now() - cleanupStart;
  const report = {
    schemaVersion: 1,
    date: new Date().toISOString(),
    fixtureLogicalBytes: 2 * 1024 ** 3,
    views: count,
    adapter,
    preparedMs,
    meanViewMs: preparedMs / count,
    baselineMs,
    cleanupMs,
    seedAllocatedBytes: seedBytes,
    runtimeAllocatedBytes: runtimeBytes,
    seedRetainedAfterCleanup: await allocated(entry),
    privateWrite: true,
    distinctPaths: true,
  };
  await mkdir("docs/evidence", { recursive: true });
  await writeFile("docs/evidence/scale.json", `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${JSON.stringify(report, null, 2)}\n`);
  await pruneCache(channels, true);
} finally {
  await manager.cleanup().catch(() => {});
  await removeTree(root);
}
