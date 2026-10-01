import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { withLock } from "../packages/workspace-core/src/cache-lock.ts";
import { CheckoutFactory } from "../packages/workspace-core/src/checkout.ts";
import {
  alive,
  allocated,
  atomicJson,
  exists,
  inventory,
  inventoryWithAllocation,
  json,
  MARKER,
  ownedRoot,
  processIdentity,
  protect,
  removeTree,
} from "../packages/workspace-core/src/fs.ts";
import {
  manifestDigest,
  pruneCache,
  validateWorkspace,
  WorkspaceManager,
} from "../packages/workspace-core/src/index.ts";
import { initializeCacheRoot } from "../packages/workspace-core/src/seed-cache.ts";
import type {
  RecoveryRecord,
  ResolvedSource,
  RuntimeChannels,
  WorkspaceHandle,
  WorkspaceSpec,
} from "../packages/workspace-core/src/types.ts";

const temporary: string[] = [];
const managers: WorkspaceManager[] = [];
afterEach(async () => {
  await Promise.allSettled(managers.splice(0).map((m) => m.cleanup()));
  await Promise.all(temporary.splice(0).map((p) => removeTree(p)));
});
async function fixture() {
  const root = await mkdtemp(join(realpathSync(tmpdir()), "allagents-workspace-test-"));
  temporary.push(root);
  const repo = join(root, "repository");
  await mkdir(repo);
  execFileSync("git", ["init", "-q", repo]);
  await writeFile(join(repo, "source.txt"), "immutable input\n");
  await writeFile(join(repo, "executable.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  execFileSync("git", ["-C", repo, "config", "core.symlinks", "true"]);
  await symlink("source.txt", join(repo, "link"));
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "update-index", "--chmod=+x", "executable.sh"]);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "initial",
  ]);
  const channels: RuntimeChannels = {
    ALLAGENTS_CACHE_ROOT: join(root, "cache"),
    ALLAGENTS_WORKSPACE_ROOT: join(root, "runtime"),
  };
  const spec: WorkspaceSpec = {
    sources: [
      { type: "git", repository: pathToFileURL(repo).href, ref: "HEAD", destination: "project" },
    ],
  };
  return { root, repo, channels, spec };
}
function manager(spec: WorkspaceSpec, channels: RuntimeChannels) {
  const value = new WorkspaceManager(spec, channels);
  managers.push(value);
  return value;
}
async function allowFixtureFileMutation(path: string): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(path, 0o644);
    return;
  }
  const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const account = execFileSync(join(system32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
  });
  const sid = /,"(S-\d+(?:-\d+)+)"\s*$/.exec(account)?.[1];
  if (!sid) throw new Error("Cannot determine fixture ACL owner");
  execFileSync(join(system32, "icacls.exe"), [path, "/grant:r", `*${sid}:F`, "/L", "/Q"]);
}
test("large protection walks retain file modes and never follow source symlinks", async () => {
  const root = await mkdtemp(join(realpathSync(tmpdir()), "allagents-protect-test-"));
  temporary.push(root);
  const tree = join(root, "tree");
  const nested = join(tree, "nested");
  await mkdir(nested, { recursive: true });
  await Promise.all(
    Array.from({ length: 65 }, (_, index) =>
      writeFile(join(nested, `file-${index}`), "content", {
        mode: index === 64 ? 0o755 : 0o644,
      }),
    ),
  );
  await chmod(join(nested, "file-0"), 0o600);
  await chmod(join(nested, "file-64"), 0o700);
  await chmod(nested, 0o700);
  const outside = join(root, "outside");
  await writeFile(outside, "untouched", { mode: 0o600 });
  await symlink(outside, join(nested, "external"));

  await protect(tree, false);
  if (process.platform === "win32") {
    // NTFS ACLs, not POSIX mode bits, restrict existing and newly created files.
    await expect(writeFile(join(nested, "file-0"), "changed")).rejects.toThrow();
    await expect(writeFile(join(nested, "new-file"), "not allowed")).rejects.toThrow();
    await writeFile(outside, "untouched");
  } else {
    expect((await lstat(join(nested, "file-0"))).mode & 0o777).toBe(0o400);
    expect((await lstat(join(nested, "file-64"))).mode & 0o777).toBe(0o500);
    expect((await lstat(nested)).mode & 0o777).toBe(0o500);
    expect((await lstat(outside)).mode & 0o777).toBe(0o600);
  }

  await protect(tree, true);
  if (process.platform === "win32") {
    await writeFile(join(nested, "new-file"), "allowed");
    expect(await readFile(join(nested, "new-file"), "utf8")).toBe("allowed");
    await writeFile(join(nested, "file-0"), "changed");
    expect(await readFile(join(nested, "file-0"), "utf8")).toBe("changed");
    expect(await readFile(outside, "utf8")).toBe("untouched");
  } else {
    expect((await lstat(join(nested, "file-0"))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(nested, "file-64"))).mode & 0o777).toBe(0o700);
    expect((await lstat(nested)).mode & 0o777).toBe(0o700);
    expect((await lstat(outside)).mode & 0o777).toBe(0o600);
  }
});
test("bounded inventory retains depth-first order and allocated blocks match inode totals", async () => {
  const root = await mkdtemp(join(realpathSync(tmpdir()), "allagents-inventory-test-"));
  temporary.push(root);
  await mkdir(join(root, "a"));
  await writeFile(join(root, "a", "b"), "nested");
  await writeFile(join(root, "a."), "sibling");
  await symlink("a/b", join(root, "link"));
  const entries = await inventory(root);
  expect(entries.map((entry) => entry.path)).toEqual(["a", "a/b", "a.", "link"]);
  expect(entries.find((entry) => entry.path === "a/b")?.digest).toBeDefined();
  const paths = [root, join(root, "a"), join(root, "a", "b"), join(root, "a."), join(root, "link")];
  const expected = (await Promise.all(paths.map((path) => lstat(path)))).reduce(
    (sum, stat) => sum + stat.blocks * 512,
    0,
  );
  expect(await allocated(root)).toBe(expected);
  const combined = await inventoryWithAllocation(root);
  expect(combined.entries).toEqual(entries);
  expect(combined.allocatedBytes).toBe(expected);
});
test("writable Git views retain immutable objects while allowing new Git objects", async () => {
  const root = await mkdtemp(join(realpathSync(tmpdir()), "allagents-git-object-modes-"));
  temporary.push(root);
  const tree = join(root, "tree");
  const objects = join(tree, ".git", "objects", "ab");
  await mkdir(objects, { recursive: true });
  await writeFile(join(objects, "existing"), "immutable object");
  await writeFile(join(tree, ".git", "index"), "index");
  await writeFile(join(tree, "source.txt"), "source");
  await chmod(join(objects, "existing"), 0o600);
  await chmod(join(tree, ".git", "index"), 0o644);
  await chmod(join(tree, "source.txt"), 0o644);

  await protect(tree, false);
  await protect(tree, true, true);
  if (process.platform === "win32") {
    await expect(writeFile(join(objects, "existing"), "mutation")).rejects.toThrow();
    await writeFile(join(tree, ".git", "index"), "mutable index");
    await writeFile(join(tree, "source.txt"), "mutable source");
  } else {
    expect((await lstat(join(objects, "existing"))).mode & 0o777).toBe(0o400);
    expect((await lstat(objects)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(tree, ".git", "index"))).mode & 0o777).toBe(0o644);
    expect((await lstat(join(tree, "source.txt"))).mode & 0o777).toBe(0o644);
  }
  await writeFile(join(objects, "new"), "new object");
  expect(await readFile(join(objects, "new"), "utf8")).toBe("new object");
});
test("local Git seed restores pinned executable modes under a restrictive umask", async () => {
  const f = await fixture();
  const pinned = execFileSync("git", ["-C", f.repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  await writeFile(join(f.repo, "later.txt"), "unrelated later content\n");
  execFileSync("git", ["-C", f.repo, "add", "later.txt"]);
  execFileSync("git", [
    "-C",
    f.repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "later",
  ]);
  const later = execFileSync("git", ["-C", f.repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const source = f.spec.sources[0];
  if (source.type !== "git") throw new Error("Fixture must use Git");
  source.ref = pinned;
  const owner = manager(f.spec, f.channels);
  const previousUmask = process.umask(0o077);
  let view: WorkspaceHandle;
  try {
    view = await owner.prepare();
  } finally {
    process.umask(previousUmask);
  }
  const seed = join(view.seedPath, "project");
  if (process.platform === "win32")
    expect(
      execFileSync("git", ["-C", seed, "ls-files", "--stage", "--", "executable.sh"], {
        encoding: "utf8",
      }),
    ).toMatch(/^100755 /);
  else expect((await lstat(join(seed, "executable.sh"))).mode & 0o111).toBe(0o111);
  expect(
    execFileSync("git", ["-C", join(view.path, "project"), "status", "--porcelain"], {
      encoding: "utf8",
    }),
  ).toBe("");
  expect(await exists(join(seed, ".git", "objects", "info", "alternates"))).toBe(false);
  expect(() =>
    execFileSync("git", ["-C", seed, "cat-file", "-e", `${later}^{commit}`], {
      stdio: "ignore",
    }),
  ).toThrow();
  await removeTree(f.repo);
  expect(execFileSync("git", ["-C", seed, "show", "HEAD:source.txt"], { encoding: "utf8" })).toBe(
    "immutable input\n",
  );
  execFileSync("git", ["-C", seed, "fsck", "--connectivity-only", "--no-reflogs"], {
    stdio: "ignore",
  });
  await owner.cleanup();
}, 15_000);
describe("workspace configuration", () => {
  test("canceling a native lock waiter preserves its reason and the current holder", async () => {
    const root = await mkdtemp(join(realpathSync(tmpdir()), "allagents-lock-cancel-"));
    temporary.push(root);
    const lock = join(root, "contended");
    let ready!: () => void;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withLock(lock, async () => {
      ready();
      await gate;
    });
    await held;
    try {
      const abort = new AbortController();
      const reason = new Error("Canceled waiting acquisition");
      const waiter = withLock(
        lock,
        async () => {
          throw new Error("Canceled waiter acquired lock");
        },
        abort.signal,
      );
      const outcome = waiter.then(
        () => undefined,
        (error: unknown) => error,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      abort.abort(reason);
      expect(await outcome).toBe(reason);
      await expect(withLock(lock, async () => true, undefined, 20)).rejects.toThrow("timed out");
    } finally {
      release();
      await holder;
    }
    expect(await withLock(lock, async () => "released")).toBe("released");
  }, 30_000);
  test("cleanup before the first row finishes initialization without removing shared roots", async () => {
    const f = await fixture();
    await manager(f.spec, f.channels).cleanup();
    const later = manager(f.spec, f.channels);
    const handle = await later.prepare();
    expect(await readFile(join(handle.path, "project/source.txt"), "utf8")).toBe(
      "immutable input\n",
    );
  }, 30_000);
  test("cold-cache contention honors the authored source timeout through initialization", async () => {
    const f = await fixture();
    const { SeedCache } = await import("../packages/workspace-core/src/seed-cache.ts");
    await initializeCacheRoot(f.channels.ALLAGENTS_CACHE_ROOT!);
    await new SeedCache(f.channels.ALLAGENTS_CACHE_ROOT!).initialize();
    let release!: () => void;
    let ready!: () => void;
    const held = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withLock(
      join(f.channels.ALLAGENTS_CACHE_ROOT!, "locks", "admission"),
      async () => {
        ready();
        await released;
      },
    );
    await held;
    const child = spawn(
      process.execPath,
      [
        join(import.meta.dir, "fixtures/lock-contender.ts"),
        pathToFileURL(join(import.meta.dir, "../packages/workspace-core/src/index.ts")).href,
        JSON.stringify({ ...f, spec: { ...f.spec, limits: { timeoutMs: 1800000 } } }),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
    let output = "";
    let errors = "";
    child.stderr!.on("data", (data) => {
      errors += String(data);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout!.on("data", (data) => {
          output += String(data);
          if (output.includes("contending")) resolve();
        });
        child.once("error", reject);
        child.once("close", () =>
          reject(new Error(`Contender exited before lock wait: stdout=${output} stderr=${errors}`)),
        );
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      release();
      await holder;
      expect({ code: await closed, errors }).toEqual({ code: 0, errors: "" });
      expect(output).toContain("complete");
    } finally {
      release();
      await holder;
      child.kill("SIGKILL");
      await closed;
      clearTimeout(timer);
    }
  }, 45_000);
  test("another process can initialize while an ownership marker awaits publication", async () => {
    const parent = await mkdtemp(join(realpathSync(tmpdir()), "allagents-root-boundary-"));
    temporary.push(parent);
    const module = pathToFileURL(
      join(import.meta.dir, "../packages/workspace-core/src/fs.ts"),
    ).href;
    for (const existing of [false, true]) {
      const root = join(parent, existing ? "existing" : "new");
      if (existing) await mkdir(root);
      const first = spawn(
        process.execPath,
        [join(import.meta.dir, "fixtures/root-publisher.ts"), module, root],
        {
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const closed = new Promise<number | null>((resolve) => first.once("close", resolve));
      const timer = setTimeout(() => first.kill("SIGKILL"), 10_000);
      first.stdin!.on("error", () => {});
      try {
        await new Promise<void>((resolve, reject) => {
          first.stdout!.on("data", (data) => {
            if (String(data).includes("paused")) resolve();
          });
          first.once("error", reject);
          first.once("exit", () => reject(new Error("Root publisher exited before its boundary")));
        });
        execFileSync(
          process.execPath,
          [
            "-e",
            "const {ownedRoot}=await import(process.argv[1]);await ownedRoot(process.argv[2],'runtime-parent');",
            module,
            root,
          ],
          { timeout: 5000 },
        );
      } finally {
        first.stdin!.end("resume");
        expect(await closed).toBe(0);
        clearTimeout(timer);
      }
      expect(await readdir(root)).toEqual([MARKER]);
    }
    expect((await readdir(parent)).sort()).toEqual(["existing", "new"]);
  }, 15_000);
  test("concurrent root publishers expose only complete ownership and preserve the winning kind", async () => {
    const parent = await mkdtemp(join(realpathSync(tmpdir()), "allagents-root-publication-"));
    temporary.push(parent);
    for (const existing of [false, true]) {
      const root = join(parent, existing ? "existing" : "new");
      if (existing) await mkdir(root);
      await Promise.all(Array.from({ length: 16 }, () => ownedRoot(root, "runtime-parent")));
      expect(await readdir(root)).toEqual([MARKER]);
      expect(await json<any>(join(root, MARKER))).toMatchObject({ kind: "runtime-parent" });
      await expect(ownedRoot(root, "cache")).rejects.toThrow("ownership");
    }
    expect((await readdir(parent)).sort()).toEqual(["existing", "new"]);
    const restored = join(parent, "restored");
    await mkdir(join(restored, "published"), { recursive: true });
    await Promise.all(Array.from({ length: 8 }, () => initializeCacheRoot(restored)));
    expect(await json<any>(join(restored, MARKER))).toMatchObject({ kind: "cache" });
  }, 15_000);
  test("rejects ambiguous and escaping paths, overlap, permissions and unknown keys", () => {
    for (const destination of [
      "",
      "/absolute",
      "../escape",
      "a/../b",
      "a//b",
      "a/./b",
      "C:/repo",
      "C:\\repo",
      "\\\\server\\repo",
      "e\u0301",
      "a\u0000b",
    ])
      expect(() =>
        validateWorkspace({
          sources: [
            { type: "git", repository: "https://example.test/repo.git", ref: "main", destination },
          ],
        }),
      ).toThrow();
    expect(() =>
      validateWorkspace({
        sources: [
          { type: "git", repository: "https://example.test/r", ref: "main", destination: "a" },
          { type: "git", repository: "https://example.test/r", ref: "main", destination: "a/b" },
        ],
      }),
    ).toThrow("overlap");
    expect(() =>
      validateWorkspace({
        sources: [
          {
            type: "git",
            repository: "https://secret@example.test/r",
            ref: "main",
            destination: "a",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      validateWorkspace({
        sources: [
          {
            type: "git",
            repository: "https://example.test/r",
            ref: "main",
            destination: "a",
            permissions: "writable",
          },
        ],
      }),
    ).toThrow();
    expect(() => validateWorkspace({ sources: [], permissions: "all" })).toThrow();
    expect(validateWorkspace({ sources: [] }).viewMode).toBe("auto");
    expect(validateWorkspace({ sources: [], viewMode: "copy-only" }).viewMode).toBe("copy-only");
    expect(() => validateWorkspace({ sources: [], viewMode: "reflink-only" })).toThrow("viewMode");
    expect(() => validateWorkspace({ sources: [], viewMode: "copy" })).toThrow("viewMode");
  });
  test("seed identity excludes permissions and mutable requested refs", () => {
    const a: ResolvedSource = {
      type: "git",
      repository: "https://example.test/r",
      ref: "main",
      destination: "a",
      commit: "a".repeat(40),
      permissions: "all",
    };
    expect(manifestDigest([a])).toBe(
      manifestDigest([{ ...a, permissions: "read-only", ref: "other" }]),
    );
    expect(manifestDigest([a])).not.toBe(manifestDigest([{ ...a, commit: "b".repeat(40) }]));
  });
});
describe("workspace lifecycle", () => {
  test("different caches can initialize concurrently under one shared runtime parent", async () => {
    const root = await mkdtemp(join(realpathSync(tmpdir()), "allagents-shared-runtime-"));
    temporary.push(root);
    const owners = Array.from({ length: 6 }, (_, index) =>
      manager(
        { sources: [] },
        {
          ALLAGENTS_CACHE_ROOT: join(root, `cache-${index}`),
          ALLAGENTS_WORKSPACE_ROOT: join(root, "runtime"),
        },
      ),
    );
    const rows = await Promise.all(owners.map((owner) => owner.prepare()));
    expect(new Set(rows.map((row) => row.path)).size).toBe(owners.length);
    await Promise.all(owners.map((owner) => owner.cleanup()));
    expect(await readdir(join(root, "runtime"))).toEqual([MARKER]);
  }, 15_000);
  test("parallel rows isolate file content, metadata, Git index and writable roots while retaining reusable seeds", async () => {
    const f = await fixture();
    const owner = manager(f.spec, f.channels);
    const [a, b] = await Promise.all([owner.prepare(), owner.prepare()]);
    expect(a.path).not.toBe(b.path);
    expect(a.manifestDigest).toBe(b.manifestDigest);
    await writeFile(join(a.path, "project", "source.txt"), "row a");
    await chmod(join(a.path, "project", "executable.sh"), 0o600);
    await writeFile(join(a.path, "project", ".git", "HEAD"), "private git state");
    await writeFile(join(a.path, "root-file"), "row root");
    expect(await readFile(join(b.path, "project", "source.txt"), "utf8")).toBe("immutable input\n");
    expect(await readFile(join(a.seedPath, "project", "source.txt"), "utf8")).toBe(
      "immutable input\n",
    );
    expect(await readFile(join(b.path, "project", ".git", "HEAD"), "utf8")).not.toBe(
      "private git state",
    );
    expect(await readlink(join(b.path, "project", "link"))).toBe("source.txt");
    const leased = await pruneCache(f.channels, true);
    expect(leased.removed).toEqual([]);
    expect(leased.retained).toContain(a.manifestDigest);
    await owner.cleanup();
    expect(await readdir(join(f.channels.ALLAGENTS_CACHE_ROOT!, "published"))).toHaveLength(1);
    const next = manager(f.spec, f.channels);
    const c = await next.prepare();
    expect(c.manifestDigest).toBe(a.manifestDigest);
    expect(await readFile(join(c.path, "project", "source.txt"), "utf8")).toBe("immutable input\n");
    await next.cleanup();
    expect((await pruneCache(f.channels, true)).removed).toContain(c.manifestDigest);
  }, 15_000);
  test("a writable Git view can commit new objects without changing cached objects", async () => {
    const f = await fixture();
    const owner = manager(f.spec, f.channels);
    const view = await owner.prepare();
    const project = join(view.path, "project");
    const original = execFileSync("git", ["-C", project, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    await writeFile(join(project, "source.txt"), "committed in row\n");
    execFileSync("git", ["-C", project, "add", "source.txt"]);
    execFileSync("git", [
      "-C",
      project,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "row commit",
    ]);
    expect(
      execFileSync("git", ["-C", project, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    ).not.toBe(original);
    expect(
      execFileSync("git", ["-C", join(view.seedPath, "project"), "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
    ).toBe(original);
    await owner.cleanup();
  }, 15_000);
  test("protected source is shared inside distinct writable roots and retained while readers live", async () => {
    const f = await fixture();
    f.spec.sources[0].permissions = "read-only";
    const aOwner = manager(f.spec, f.channels);
    const bOwner = manager(f.spec, f.channels);
    const [a, b] = await Promise.all([aOwner.prepare(), bOwner.prepare()]);
    expect(a.path).not.toBe(b.path);
    expect(await readlink(join(a.path, "project"))).toBe(await readlink(join(b.path, "project")));
    expect(await readlink(join(a.path, "project"))).not.toContain(`${sep}published${sep}`);
    await writeFile(join(a.path, "notes.txt"), "allowed");
    await expect(writeFile(join(a.path, "project", "source.txt"), "forbidden")).rejects.toThrow();
    await aOwner.cleanup();
    expect(await readFile(join(b.path, "project", "source.txt"), "utf8")).toBe("immutable input\n");
    expect((await pruneCache(f.channels, true)).retained).toContain(b.manifestDigest);
    await bOwner.cleanup();
    expect((await pruneCache(f.channels, true)).removed).toContain(b.manifestDigest);
  }, 30_000);
  test("copy-only shares one protected physical checkout per source identity, separate from auto", async () => {
    const f = await fixture();
    const spec: WorkspaceSpec = {
      ...f.spec,
      viewMode: "copy-only",
      sources: [{ ...f.spec.sources[0]!, permissions: "read-only" }],
    };
    const owner = manager(spec, f.channels);
    const [a, b] = await Promise.all([owner.prepare(), owner.prepare()]);
    const shared = await readlink(join(a.path, "project"));
    expect(await readlink(join(b.path, "project"))).toBe(shared);
    expect(await readdir(join(f.channels.ALLAGENTS_CACHE_ROOT!, "checkouts"))).toHaveLength(1);
    expect((await lstat(join(shared, "source.txt"))).ino).not.toBe(
      (await lstat(join(a.seedPath, "project", "source.txt"))).ino,
    );
    const automatic = manager({ ...spec, viewMode: "auto" }, f.channels);
    const autoRow = await automatic.prepare();
    expect(await readlink(join(autoRow.path, "project"))).not.toBe(shared);
    expect(await readdir(join(f.channels.ALLAGENTS_CACHE_ROOT!, "checkouts"))).toHaveLength(2);
    await writeFile(join(a.path, "notes.txt"), "private scratch");
    await expect(writeFile(join(a.path, "project", "source.txt"), "forbidden")).rejects.toThrow();
    await owner.cleanup();
    await automatic.cleanup();
  }, 30_000);
  test("protected checkout mutation invalidates future reuse instead of resetting a live checkout", async () => {
    const f = await fixture();
    f.spec.sources[0].permissions = "read-only";
    const owner = manager(f.spec, f.channels);
    const a = await owner.prepare();
    const shared = await readlink(join(a.path, "project"));
    await allowFixtureFileMutation(join(shared, "source.txt"));
    await writeFile(join(shared, "source.txt"), "unexpected");
    await expect(owner.validateProtected(a)).rejects.toThrow("mutated");
    await expect(owner.prepare()).rejects.toThrow();
    expect(await readFile(join(a.path, "project", "source.txt"), "utf8")).toBe("unexpected");
  }, 30_000);
  test("legacy overlay recovery fails closed without removing a workspace or releasing its lease", async () => {
    const f = await fixture();
    const owner = manager({ ...f.spec, viewMode: "copy-only" }, f.channels);
    const row = await owner.prepare();
    const recordPath = join(dirname(dirname(row.path)), "records", `${basename(row.path)}.json`);
    const record = await json<RecoveryRecord>(recordPath);
    const original = record.views[0]!.adapter;
    record.views[0]!.adapter = "overlay" as "copy"; // Deliberately emulate a pre-upgrade record.
    await atomicJson(recordPath, record);
    await expect(owner.release(row)).rejects.toThrow("Legacy OverlayFS");
    expect(await readFile(join(row.path, "project", "source.txt"), "utf8")).toBe(
      "immutable input\n",
    );
    expect(
      await readdir(join(f.channels.ALLAGENTS_CACHE_ROOT!, "leases", row.manifestDigest.slice(7))),
    ).toHaveLength(1);
    record.views[0]!.adapter = original;
    await atomicJson(recordPath, record);
    await owner.cleanup();
  }, 30_000);
  test("unknown mount or invalid recovery state keeps leases and independent workspaces still detach", async () => {
    const f = await fixture();
    const owner = manager(f.spec, f.channels);
    const [a, b] = await Promise.all([owner.prepare(), owner.prepare()]);
    const root = join(a.path, "../..");
    const recordPath = join(root, "records", `${basename(a.path)}.json`);
    const record = await json<RecoveryRecord>(recordPath);
    record.path = join(f.root, "escape");
    await atomicJson(recordPath, record);
    await expect(owner.cleanup()).rejects.toThrow("retained");
    expect(await readFile(join(a.path, "project", "source.txt"), "utf8")).toBe("immutable input\n");
    expect(
      await readdir(join(f.channels.ALLAGENTS_CACHE_ROOT!, "leases", a.manifestDigest.slice(7))),
    ).toHaveLength(1);
    await expect(readFile(join(b.path, "project", "source.txt"))).rejects.toThrow();
    record.path = a.path;
    await atomicJson(recordPath, record);
    await owner.cleanup();
  }, 30_000);
  test("unmarked and symlink roots fail before source acquisition", async () => {
    const f = await fixture();
    await mkdir(f.channels.ALLAGENTS_CACHE_ROOT!);
    await writeFile(join(f.channels.ALLAGENTS_CACHE_ROOT!, "unowned"), "keep");
    await expect(manager(f.spec, f.channels).prepare()).rejects.toThrow("unmarked");
    expect(await readFile(join(f.channels.ALLAGENTS_CACHE_ROOT!, "unowned"), "utf8")).toBe("keep");
  });
  test("forced process death leaves leases until a later process detaches recorded views", async () => {
    const f = await fixture();
    const module = pathToFileURL(join(process.cwd(), "packages/workspace-core/src/index.ts")).href;
    const code = `const {WorkspaceManager}=await import(${JSON.stringify(module)});const manager=new WorkspaceManager(${JSON.stringify(f.spec)},${JSON.stringify(f.channels)});const handle=await manager.prepare();process.stdout.write(JSON.stringify(handle)+"\\n");setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (b) => (stderr += b.toString()));
    const row = await new Promise<{ path: string; manifestDigest: `sha256:${string}` }>(
      (res, rej) => {
        let buffer = "";
        child.stdout.on("data", (b) => {
          buffer += b.toString();
          if (buffer.includes("\n")) res(JSON.parse(buffer.split("\n")[0]));
        });
        child.once("exit", (code) => rej(new Error(`Fixture exited ${code}: ${stderr}`)));
        child.once("error", rej);
      },
    );
    const exited = new Promise<void>((res) => child.once("exit", () => res()));
    child.kill("SIGKILL");
    await exited;
    expect((await pruneCache(f.channels, true)).retained).toContain(row.manifestDigest);
    const next = manager(f.spec, f.channels);
    const recovered = await next.prepare();
    expect(recovered.manifestDigest).toBe(row.manifestDigest);
    await expect(readFile(join(row.path, "project", "source.txt"))).rejects.toThrow();
    await next.cleanup();
    expect((await pruneCache(f.channels, true)).removed).toContain(row.manifestDigest);
  }, 30000);
  test("pre-abort creates no row workspace or seed lease", async () => {
    const f = await fixture();
    const owner = manager(f.spec, f.channels);
    const controller = new AbortController();
    controller.abort();
    expect(() => owner.prepare(controller.signal)).toThrow();
  });
});
describe("cache policy and fallback admission", () => {
  test("age pruning removes only unused seeds, including after all row leases finish", async () => {
    const f = await fixture();
    const { initializeCacheRoot, SeedCache } = await import(
      "../packages/workspace-core/src/seed-cache.ts"
    );
    await initializeCacheRoot(f.channels.ALLAGENTS_CACHE_ROOT!);
    const emptyCache = new SeedCache(f.channels.ALLAGENTS_CACHE_ROOT!);
    await emptyCache.initialize();
    const emptyAllocatedBytes = (await emptyCache.prune()).allocatedBytes;
    const owner = manager(f.spec, f.channels);
    const row = await owner.prepare();
    const metadataPath = join(
      f.channels.ALLAGENTS_CACHE_ROOT!,
      "published",
      row.manifestDigest.slice(7),
      "metadata.json",
    );
    const metadata = await json<Record<string, unknown>>(metadataPath);
    metadata.lastUsed = Date.now() - 31 * 24 * 60 * 60 * 1000;
    await atomicJson(metadataPath, metadata);
    expect((await pruneCache(f.channels)).retained).toContain(row.manifestDigest);
    await owner.cleanup();
    // Cleanup also applies age collection after dependency-ordered lease release.
    expect(await readdir(join(f.channels.ALLAGENTS_CACHE_ROOT!, "published"))).toHaveLength(0);
    expect((await pruneCache(f.channels)).allocatedBytes).toBe(emptyAllocatedBytes);
  }, 30_000);
  test("fresh hosted root accepts only verified immutable published subtree and makes fresh leases", async () => {
    const f = await fixture();
    const owner = manager(f.spec, f.channels);
    const row = await owner.prepare();
    await owner.cleanup();
    const restored = join(f.root, "restored-cache");
    await mkdir(restored);
    await cp(join(f.channels.ALLAGENTS_CACHE_ROOT!, "published"), join(restored, "published"), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
    const next = manager(f.spec, { ...f.channels, ALLAGENTS_CACHE_ROOT: restored });
    const result = await next.prepare();
    expect(result.manifestDigest).toBe(row.manifestDigest);
    expect(await readdir(join(restored, "leases", row.manifestDigest.slice(7)))).toHaveLength(1);
    await next.cleanup();
    expect(
      (await pruneCache({ ...f.channels, ALLAGENTS_CACHE_ROOT: restored }, true)).removed,
    ).toContain(row.manifestDigest);
  }, 30_000);
  test("corrupt restored seed and symlinked control paths are refused before acquisition", async () => {
    const f = await fixture();
    const owner = manager(f.spec, f.channels);
    const row = await owner.prepare();
    await owner.cleanup();
    await allowFixtureFileMutation(join(row.seedPath, "project", "source.txt"));
    await writeFile(join(row.seedPath, "project", "source.txt"), "corrupt");
    await expect(manager(f.spec, f.channels).prepare()).rejects.toThrow("integrity");
    const restored = join(f.root, "bad-cache");
    await mkdir(restored);
    await symlink(f.channels.ALLAGENTS_CACHE_ROOT!, join(restored, "published"));
    await expect(pruneCache({ ...f.channels, ALLAGENTS_CACHE_ROOT: restored })).rejects.toThrow(
      "Symlink",
    );
  }, 30_000);
  test("copy-only selects independent physical writable views without probing", async () => {
    const f = await fixture();
    const runtime = join(f.root, "views");
    const state = join(runtime, "state");
    await mkdir(state, { recursive: true });
    const factory = new CheckoutFactory(
      runtime,
      f.channels.ALLAGENTS_CACHE_ROOT!,
      120000,
      "copy-only",
    );
    const selected = await factory.selected(
      f.repo,
      state,
      async () => {
        throw new Error("Copy-only must not probe");
      },
      "project",
    );
    expect(selected).toBe("copy");
    expect(await readdir(state)).toEqual([]);
    const view = {
      destination: "project",
      adapter: selected,
      seedSource: f.repo,
      path: join(runtime, "project"),
    };
    await factory.create(view);
    expect((await lstat(join(view.path, "source.txt"))).ino).not.toBe(
      (await lstat(join(f.repo, "source.txt"))).ino,
    );
    await writeFile(join(view.path, "source.txt"), "private");
    expect(await readFile(join(f.repo, "source.txt"), "utf8")).toBe("immutable input\n");
    await expect(
      factory.create({ ...view, adapter: "reflink", path: join(runtime, "reflink") }),
    ).rejects.toThrow("Copy-only");
  });
  test("auto selects a reflink when supported and otherwise admits a copy", async () => {
    const f = await fixture();
    const owner = manager(f.spec, f.channels);
    const row = await owner.prepare();
    expect(["reflink", "copy"]).toContain(row.adapters[0]?.adapter);
    await writeFile(join(row.path, "project", "source.txt"), "private");
    expect(await readFile(join(row.seedPath, "project", "source.txt"), "utf8")).toBe(
      "immutable input\n",
    );
  });
  test("full-copy fallback creates independent inodes and rejects sparse huge logical footprint before copy", async () => {
    const f = await fixture();
    const runtime = join(f.root, "copies");
    await mkdir(runtime);
    const factory = new CheckoutFactory(runtime, f.channels.ALLAGENTS_CACHE_ROOT!);
    const a = {
      destination: "a",
      adapter: "copy" as const,
      seedSource: f.repo,
      path: join(runtime, "a"),
    };
    const b = { ...a, destination: "b", path: join(runtime, "b") };
    await Promise.all([factory.create(a), factory.create(b)]);
    await writeFile(join(a.path, "source.txt"), "private");
    expect(await readFile(join(b.path, "source.txt"), "utf8")).toBe("immutable input\n");
    const huge = join(f.root, "huge");
    await mkdir(huge);
    const sparse = join(huge, "sparse");
    await writeFile(sparse, "");
    if (process.platform === "win32") execFileSync("fsutil.exe", ["sparse", "setflag", sparse]);
    const fd = await open(sparse, "r+");
    try {
      await fd.truncate(2 ** 40);
    } finally {
      await fd.close();
    }
    const destination = join(runtime, "rejected");
    await expect(factory.create({ ...a, seedSource: huge, path: destination })).rejects.toThrow(
      "cannot fit",
    );
    await expect(readdir(destination)).rejects.toThrow();
  });
});
describe("cache locks and process identity", () => {
  test("parallel mutation lock operations never overlap", async () => {
    const root = await mkdtemp(join(realpathSync(tmpdir()), "allagents-lock-test-"));
    temporary.push(root);
    let active = 0;
    let maximum = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        withLock(join(root, "mutation"), async () => {
          active++;
          maximum = Math.max(active, maximum);
          await new Promise((r) => setTimeout(r, 10));
          active--;
        }),
      ),
    );
    expect(maximum).toBe(1);
  });
  test("process identity resists PID reuse", async () => {
    const identity = await processIdentity();
    expect(await alive(identity)).toBe(true);
    expect(await alive({ ...identity, start: "wrong-start" })).toBe(false);
  });
});

test("large inventory JSON can use an explicit bounded read without relaxing default control record bounds", async () => {
  const root = await mkdtemp(join(realpathSync(tmpdir()), "allagents-inventory-json-"));
  temporary.push(root);
  const path = join(root, "metadata.json");
  await writeFile(path, JSON.stringify({ inventory: "a".repeat(65 * 1024 * 1024) }));
  await expect(json(path)).rejects.toThrow("oversized");
  expect((await json<{ inventory: string }>(path, 512 * 1024 * 1024)).inventory.length).toBe(
    65 * 1024 * 1024,
  );
}, 30_000);

test("default runtime canonicalizes the platform temporary directory while explicit symlink roots stay rejected", async () => {
  const root = await mkdtemp(join(realpathSync(tmpdir()), "allagents-default-root-"));
  temporary.push(root);
  const target = join(root, "physical");
  const alias = join(root, "platform-alias");
  await mkdir(target);
  await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
  const module = pathToFileURL(join(process.cwd(), "packages/workspace-core/src/index.ts")).href;
  const code = `const {WorkspaceManager}=await import(${JSON.stringify(module)});const manager=new WorkspaceManager({sources:[]},{ALLAGENTS_CACHE_ROOT:${JSON.stringify(join(root, "cache"))}});const handle=await manager.prepare();console.log(handle.path);await manager.cleanup();`;
  const path = execFileSync(process.execPath, ["-e", code], {
    encoding: "utf8",
    env: {
      ...process.env,
      TMPDIR: alias,
      ...(process.platform === "win32" ? { TEMP: alias, TMP: alias } : {}),
    },
  }).trim();
  expect(path.startsWith(`${target}${sep}`)).toBe(true);
  await expect(
    manager(
      { sources: [] },
      {
        ALLAGENTS_CACHE_ROOT: join(root, "explicit-cache"),
        ALLAGENTS_WORKSPACE_ROOT: join(alias, "runtime"),
      },
    ).prepare(),
  ).rejects.toThrow("symlink");
  const originalEntries = await readdir(target);
  await expect(initializeCacheRoot(join(alias, "new-unowned-parent", "cache"))).rejects.toThrow(
    "symlink",
  );
  expect(await readdir(target)).toEqual(originalEntries);
});

test("crash recovery discards completed staging with a large valid ownership metadata document", async () => {
  const f = await fixture();
  const initial = manager({ sources: [] }, f.channels);
  await initial.prepare();
  await initial.cleanup();
  const stage = join(
    f.channels.ALLAGENTS_CACHE_ROOT!,
    "staging",
    "12345678-1234-1234-1234-123456789abc",
  );
  await mkdir(stage);
  await writeFile(
    join(stage, "metadata.json"),
    JSON.stringify({
      schemaVersion: 1,
      package: "@allagents/promptfoo-integration",
      inventory: "a".repeat(65 * 1024 * 1024),
    }),
  );
  const next = manager({ sources: [] }, f.channels);
  await next.prepare();
  await next.cleanup();
  expect(await readdir(join(f.channels.ALLAGENTS_CACHE_ROOT!, "staging"))).toEqual([]);
}, 30_000);

test("seed reuse reserves the atomic inventory replacement before writing and preserves the previous metadata on refusal", async () => {
  const { CACHE_CEILING, SeedCache } = await import("../packages/workspace-core/src/seed-cache.ts");
  const { DEFAULT_LIMITS } = await import("../packages/workspace-core/src/config.ts");
  const f = await fixture();
  const owner = manager(f.spec, f.channels);
  const row = await owner.prepare();
  const metadataPath = join(
    f.channels.ALLAGENTS_CACHE_ROOT!,
    "published",
    row.manifestDigest.slice(7),
    "metadata.json",
  );
  const previous = await readFile(metadataPath, "utf8");
  const metadata = JSON.parse(previous);
  class FullCache extends SeedCache {
    override async size(): Promise<number> {
      return CACHE_CEILING;
    }
  }
  const cache = new FullCache(f.channels.ALLAGENTS_CACHE_ROOT!);
  await expect(cache.prepare(metadata.sources, DEFAULT_LIMITS, f.channels)).rejects.toThrow(
    "capacity reservation",
  );
  expect(await readFile(metadataPath, "utf8")).toBe(previous);
  expect(
    (
      await readdir(
        join(f.channels.ALLAGENTS_CACHE_ROOT!, "published", row.manifestDigest.slice(7)),
      )
    ).sort(),
  ).toEqual(["metadata.json", "tree"]);
});

test("recent verified seed reuse avoids another full capacity walk but refreshes stale recency", async () => {
  const { SeedCache } = await import("../packages/workspace-core/src/seed-cache.ts");
  const { DEFAULT_LIMITS } = await import("../packages/workspace-core/src/config.ts");
  const f = await fixture();
  const owner = manager(f.spec, f.channels);
  const row = await owner.prepare();
  const metadataPath = join(
    f.channels.ALLAGENTS_CACHE_ROOT!,
    "published",
    row.manifestDigest.slice(7),
    "metadata.json",
  );
  const metadata = await json<{ sources: typeof row.sources; lastUsed: number }>(metadataPath);
  class CountingCache extends SeedCache {
    sizeCalls = 0;
    override async size(): Promise<number> {
      this.sizeCalls++;
      return super.size();
    }
  }
  const cache = new CountingCache(f.channels.ALLAGENTS_CACHE_ROOT!);
  await cache.initialize();
  await cache.prepare(metadata.sources, DEFAULT_LIMITS, f.channels);
  const initialWalks = cache.sizeCalls;
  expect(initialWalks).toBeGreaterThan(0);
  const current = await readFile(metadataPath, "utf8");
  await cache.prepare(metadata.sources, DEFAULT_LIMITS, f.channels);
  expect(cache.sizeCalls).toBe(initialWalks);
  expect(await readFile(metadataPath, "utf8")).toBe(current);

  await atomicJson(metadataPath, {
    ...JSON.parse(current),
    lastUsed: Date.now() - 2 * 60 * 60 * 1000,
  });
  await cache.prepare(metadata.sources, DEFAULT_LIMITS, f.channels);
  expect(cache.sizeCalls).toBeGreaterThan(initialWalks);
  expect((await json<{ lastUsed: number }>(metadataPath)).lastUsed).toBeGreaterThan(
    Date.now() - 60_000,
  );
}, 30_000);

test("bounded JSON writes reject before leaving a partial or temporary file", async () => {
  const root = await mkdtemp(join(realpathSync(tmpdir()), "allagents-json-write-"));
  temporary.push(root);
  await expect(atomicJson(join(root, "metadata.json"), { value: "oversized" }, 5)).rejects.toThrow(
    "write bound",
  );
  expect(await readdir(root)).toEqual([]);
});

test("admission retains a shared protected checkout when reused by a different seed manifest", async () => {
  const { SeedCache } = await import("../packages/workspace-core/src/seed-cache.ts");
  const f = await fixture();
  const first = manager(
    { sources: [{ ...f.spec.sources[0]!, permissions: "read-only" }] },
    f.channels,
  );
  await first.prepare();
  await first.cleanup();
  const second = manager(
    { sources: [f.spec.sources[0]!, { ...f.spec.sources[0]!, destination: "extra" }] },
    f.channels,
  );
  const row = await second.prepare();
  const cacheRoot = f.channels.ALLAGENTS_CACHE_ROOT!;
  const [key] = await readdir(join(cacheRoot, "checkouts"));
  const metadataPath = join(cacheRoot, "checkouts", key!, "metadata.json");
  const original = await json<Record<string, unknown>>(metadataPath);
  await atomicJson(metadataPath, { ...original, lastUsed: Date.now() - 31 * 24 * 60 * 60 * 1000 });
  const records = await Promise.all(
    (await readdir(join(dirname(dirname(row.path)), "records"))).map((name) =>
      json<RecoveryRecord>(join(dirname(dirname(row.path)), "records", name)),
    ),
  );
  const record = records.find(
    (value) => value.digest === row.manifestDigest && value.status !== "released",
  )!;
  const metadata = await json<{ sources: ResolvedSource[] }>(
    join(cacheRoot, "published", row.manifestDigest.slice(7), "metadata.json"),
  );
  const cache = new SeedCache(cacheRoot);
  const reused = await cache.protectedSource(
    record,
    metadata.sources.find((s) => s.destination === "project")!,
  );
  expect(reused.key).toBe(key!);
  expect(await readFile(join(reused.path, "source.txt"), "utf8")).toBe("immutable input\n");
  await cache.checkProtected(reused.key);
  await cache.releaseProtected(record, reused.key);
}, 30_000);
