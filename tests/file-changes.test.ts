import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureFileChanges, establishBaseline } from "../packages/workspace-core/src/file-changes";

test("capture records exact after bytes, deletions, modes, symlinks and root additions", async () => {
  const root = await mkdtemp(join(tmpdir(), "capture-"));
  try {
    const seed = join(root, "seed");
    const path = join(root, "view");
    await mkdir(seed);
    await mkdir(path);
    await writeFile(join(seed, "old.txt"), "before\n");
    await writeFile(join(path, "old.txt"), "before\n");
    await writeFile(join(seed, "delete.txt"), "deleted\n");
    await writeFile(join(path, "delete.txt"), "deleted\n");
    const handle = {
      path,
      seedPath: seed,
      manifestDigest: "sha256:abc" as const,
      sources: [],
      adapters: [],
    };
    const baseline = await establishBaseline(handle);
    await writeFile(join(path, "old.txt"), "after\n");
    await rm(join(path, "delete.txt"));
    await writeFile(join(path, "binary.bin"), Buffer.from([0, 255, 128]));
    await writeFile(join(path, "run.sh"), "#!/bin/sh\n");
    await chmod(join(path, "run.sh"), 0o755);
    await symlink("/outside/not-read", join(path, "link"));
    const binaryLinkTarget =
      process.platform === "win32" ? "unreadable-target" : Buffer.from([255]);
    await symlink(binaryLinkTarget, join(path, "binary-link"), "file");
    const result = await captureFileChanges(handle, baseline);
    expect(result.status).toBe("complete");
    if (result.status === "failed") throw new Error(result.failure.message);
    expect(Buffer.from(result.generatedFiles["binary.bin"].content, "base64")).toEqual(
      Buffer.from([0, 255, 128]),
    );
    expect(result.generatedFiles["old.txt"].change).toBe("modified");
    expect(result.deletedFiles).toEqual(["delete.txt"]);
    expect(result.generatedFiles["run.sh"].mode).toBe(
      process.platform === "win32" ? "100644" : "100755",
    );
    expect(result.generatedFiles.link.kind).toBe("symlink");
    expect(result.generatedFiles["binary-link"].kind).toBe("symlink");
    expect(result.generatedFiles["binary-link"].mode).toBe("120000");
    expect(Buffer.from(result.generatedFiles["binary-link"].content, "base64")).toEqual(
      process.platform === "win32"
        ? await readlink(join(path, "binary-link"), { encoding: "buffer" })
        : Buffer.from([255]),
    );
    expect(Buffer.from(result.generatedFiles.link.content, "base64")).toEqual(
      process.platform === "win32"
        ? await readlink(join(path, "link"), { encoding: "buffer" })
        : Buffer.from("/outside/not-read"),
    );
    expect(result.diff?.content).toContain("+after");
    expect(result.diff?.content).toContain("-deleted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture returns explicit truncation for an oversized file", async () => {
  const root = await mkdtemp(join(tmpdir(), "capture-"));
  try {
    const handle = {
      path: root,
      seedPath: root,
      manifestDigest: "sha256:abc" as const,
      sources: [],
      adapters: [],
    };
    const baseline = await establishBaseline(handle);
    await writeFile(join(root, "huge"), Buffer.alloc(256 * 1024 + 1));
    const result = await captureFileChanges(handle, baseline);
    expect(result.status).toBe("truncated");
    if (result.status === "truncated") {
      expect(result.truncation.codes).toContain("FILE_BYTES");
      expect(result.truncation.omittedPaths).toEqual(["huge"]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("baseline ignore rules remain frozen when agent replaces .gitignore", async () => {
  const root = await mkdtemp(join(tmpdir(), "capture-"));
  try {
    await writeFile(join(root, ".gitignore"), "ignored/\n*.tmp\n!kept.tmp\n");
    await mkdir(join(root, "ignored"));
    await writeFile(join(root, "ignored", "before"), "private");
    const handle = {
      path: root,
      seedPath: root,
      manifestDigest: "sha256:abc" as const,
      sources: [],
      adapters: [],
    };
    const baseline = await establishBaseline(handle);
    await writeFile(join(root, ".gitignore"), "");
    await writeFile(join(root, "ignored", "after"), "private");
    await writeFile(join(root, "new.tmp"), "private");
    await writeFile(join(root, "kept.tmp"), "capture");
    const result = await captureFileChanges(handle, baseline);
    expect(result.status).toBe("complete");
    if (result.status === "failed") throw Error(result.failure.message);
    expect(Object.keys(result.generatedFiles).sort()).toEqual([".gitignore", "kept.tmp"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("immutable Git baseline survives agent commits, staging, ignored tracked files and replacement refs", async () => {
  const { execFileSync } = await import("node:child_process");
  const { cp, readFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "capture-git-"));
  try {
    const source = join(root, "source");
    await mkdir(source);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", source, ...args], { encoding: "utf8" });
    git("init", "--initial-branch=main");
    await mkdir(join(source, "ignored-dir"));
    await writeFile(join(source, "ignored-dir", "tracked.txt"), "before");
    await writeFile(join(source, ".gitignore"), "tracked.txt\nignored.txt\nignored-dir/\n");
    await writeFile(join(source, "tracked.txt"), "before\n");
    git("add", "-f", ".gitignore", "tracked.txt", "ignored-dir/tracked.txt");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "baseline",
    );
    const commit = git("rev-parse", "HEAD").trim();
    const seed = join(root, "seed");
    await mkdir(seed);
    await cp(source, join(seed, "project"), { recursive: true });
    const handle = {
      path: root,
      seedPath: seed,
      manifestDigest: "sha256:abc" as const,
      sources: [
        {
          type: "git" as const,
          repository: "file:///fixture",
          ref: commit,
          commit,
          destination: "source",
          permissions: "all" as const,
        },
      ],
      adapters: [],
    };
    // Align the immutable seed's destination without sharing the source.
    await cp(source, join(seed, "source"), { recursive: true });
    const baseline = await establishBaseline(handle);
    await writeFile(join(source, "ignored-dir", "tracked.txt"), "after");
    await writeFile(join(source, "tracked.txt"), "after\n");
    await writeFile(join(source, "ignored.txt"), "secret ignored");
    git("add", "-f", "tracked.txt");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "agent",
    );
    git("replace", commit, git("rev-parse", "HEAD").trim());
    await writeFile(join(source, "staged.txt"), "staged after baseline");
    git("add", "staged.txt");
    const finalIndex = await readFile(join(source, ".git/index"));
    const result = await captureFileChanges(handle, baseline);
    expect(result.status).toBe("complete");
    if (result.status === "failed") throw Error(result.failure.message);
    expect(result.generatedFiles["source/ignored-dir/tracked.txt"].change).toBe("modified");
    expect(result.generatedFiles["source/tracked.txt"].change).toBe("modified");
    expect(result.generatedFiles["source/ignored.txt"]).toBeUndefined();
    expect(await readFile(join(source, ".git/index"))).toEqual(finalIndex);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nested ignore overrides and rules beyond baseline byte budget remain frozen", async () => {
  const root = await mkdtemp(join(tmpdir(), "capture-rules-"));
  try {
    await writeFile(join(root, ".gitignore"), "*.log\n");
    await mkdir(join(root, "z"));
    for (let i = 0; i < 17; i++)
      await writeFile(join(root, `a${String(i).padStart(2, "0")}`), Buffer.alloc(256 * 1024, 65));
    await writeFile(join(root, "z", ".gitignore"), "!keep.log\nignored.txt\n");
    await writeFile(join(root, "z", "keep.log"), "before");
    const handle = {
      path: root,
      seedPath: root,
      manifestDigest: "sha256:abc" as const,
      sources: [],
      adapters: [],
    };
    const baseline = await establishBaseline(handle);
    await writeFile(join(root, "z", "keep.log"), "after");
    await writeFile(join(root, "z", "ignored.txt"), "private");
    await writeFile(join(root, "z", ".gitignore"), "");
    const result = await captureFileChanges(handle, baseline);
    if (result.status === "failed") throw Error(result.failure.message);
    expect(result.generatedFiles["z/keep.log"]).toBeDefined();
    expect(result.generatedFiles["z/ignored.txt"]).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("replacement of a protected link captures row-owned files without following the original", async () => {
  const root = await mkdtemp(join(tmpdir(), "capture-link-"));
  try {
    const path = join(root, "view"),
      protectedPath = join(root, "protected");
    await mkdir(path);
    await mkdir(protectedPath);
    await writeFile(join(protectedPath, "private"), "protected");
    await symlink(protectedPath, join(path, "project"));
    const handle = {
      path,
      seedPath: root,
      manifestDigest: "sha256:abc" as const,
      sources: [
        {
          type: "git" as const,
          repository: "file:///fixture",
          ref: "a".repeat(40),
          commit: "a".repeat(40),
          destination: "project",
          permissions: "read-only" as const,
        },
      ],
      adapters: [],
    };
    const baseline = await establishBaseline(handle);
    await rm(join(path, "project"));
    await mkdir(join(path, "project"));
    await writeFile(join(path, "project", "new"), "after");
    const result = await captureFileChanges(handle, baseline);
    if (result.status === "failed") throw Error(result.failure.message);
    expect(result.generatedFiles["project/new"]).toBeDefined();
    expect(result.generatedFiles["project/private"]).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("aggregate change bytes truncate explicitly without retaining all candidate contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "capture-budget-"));
  try {
    const handle = {
      path: root,
      seedPath: root,
      manifestDigest: "sha256:abc" as const,
      sources: [],
      adapters: [],
    };
    const baseline = await establishBaseline(handle);
    for (let i = 0; i < 20; i++)
      await writeFile(join(root, `file-${i}`), Buffer.alloc(256 * 1024, 65));
    const result = await captureFileChanges(handle, baseline);
    expect(result.status).toBe("truncated");
    if (result.status !== "truncated") throw Error("Expected bounded result");
    expect(result.truncation.codes).toContain("TOTAL_BYTES");
    expect(
      Object.values(result.generatedFiles).reduce(
        (n, f) => n + Buffer.from(f.content, "base64").length,
        0,
      ),
    ).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(Object.keys(result.generatedFiles)).toHaveLength(16);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
