import type * as ChildProcess from "node:child_process";
import { execFileSync, type SpawnOptions, spawn } from "node:child_process";
import {
  chmod,
  cp,
  link,
  mkdir,
  mkdtemp,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { captureFileChanges, establishBaseline } from "../packages/workspace-core/src/file-changes";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

/**
 * Commits `files` plus `bulk` empty tracked files at view/project and seeds only its `.git`,
 * like a materialized writable Git source. Bulk files share one blob so the fixture stays cheap.
 */
async function pinnedGitSource(root: string, files: Record<string, string>, bulk: string[] = []) {
  const work = join(root, "view", "project");
  await mkdir(work, { recursive: true });
  const git = (args: string[], input?: string) =>
    execFileSync("git", ["-C", work, "-c", "core.autocrlf=false", ...args], {
      encoding: "utf8",
      input,
      maxBuffer: 256 * 1024 * 1024,
    });
  git(["init", "--quiet", "--initial-branch=main"]);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(work, path, ".."), { recursive: true });
    await writeFile(join(work, path), content);
  }
  git(["add", "-f", "--", ...Object.keys(files)]);
  if (bulk.length) {
    const blob = git(["hash-object", "-w", "--stdin"], "").trim();
    git(["update-index", "--index-info"], bulk.map((path) => `100644 ${blob}\t${path}\n`).join(""));
    git(["checkout-index", "--all", "--force"]);
  }
  const tree = git(["write-tree"]).trim();
  const commit = git(
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit-tree", tree],
    "baseline\n",
  ).trim();
  const seed = join(root, "seed");
  await cp(join(work, ".git"), join(seed, "project", ".git"), { recursive: true });
  return {
    work,
    handle: {
      path: join(root, "view"),
      seedPath: seed,
      manifestDigest: "sha256:abc" as const,
      sources: [
        {
          type: "git" as const,
          repository: "file:///fixture",
          ref: commit,
          commit,
          destination: "project",
          permissions: "all" as const,
        },
      ],
      adapters: [],
    },
  };
}

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
    expect(result.schemaVersion).toBe(2);
    if (result.status === "failed") throw new Error(result.failure.message);
    expect(Buffer.from(result.changedFiles["binary.bin"].content, "base64")).toEqual(
      Buffer.from([0, 255, 128]),
    );
    expect(result.changedFiles["binary.bin"].change).toBe("added");
    expect(result.changedFiles["old.txt"].change).toBe("modified");
    expect(result.deletedFiles).toEqual(["delete.txt"]);
    expect(result.changedFiles["run.sh"].mode).toBe(
      process.platform === "win32" ? "100644" : "100755",
    );
    expect(result.changedFiles.link.kind).toBe("symlink");
    expect(result.changedFiles["binary-link"].kind).toBe("symlink");
    expect(result.changedFiles["binary-link"].mode).toBe("120000");
    expect(Buffer.from(result.changedFiles["binary-link"].content, "base64")).toEqual(
      process.platform === "win32"
        ? await readlink(join(path, "binary-link"), { encoding: "buffer" })
        : Buffer.from([255]),
    );
    expect(Buffer.from(result.changedFiles.link.content, "base64")).toEqual(
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

test("capture never reads a hardlink to a file outside the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "capture-"));
  try {
    const path = join(root, "view");
    await mkdir(path);
    const secret = join(root, "secret.txt");
    await writeFile(secret, "TOP-SECRET-CREDENTIAL\n");
    const handle = {
      path,
      seedPath: path,
      manifestDigest: "sha256:abc" as const,
      sources: [],
      adapters: [],
    };
    const baseline = await establishBaseline(handle);
    await link(secret, join(path, "stolen.txt"));
    await writeFile(join(path, "ok.txt"), "fine\n");
    const result = await captureFileChanges(handle, baseline);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("TOP-SECRET");
    expect(serialized).not.toContain(Buffer.from("TOP-SECRET-CREDENTIAL\n").toString("base64"));
    expect(result.status).toBe("truncated");
    if (result.status !== "truncated") return;
    expect(result.truncation.codes).toContain("HARDLINK");
    expect(result.truncation.omittedPaths).toEqual(["stolen.txt"]);
    expect(result.changedFiles["ok.txt"].change).toBe("added");
    expect(result.changedFiles["stolen.txt"]).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("baseline reports a hardlinked .gitignore distinctly", async () => {
  const root = await mkdtemp(join(tmpdir(), "capture-"));
  try {
    const path = join(root, "view");
    await mkdir(path);
    await writeFile(join(root, "rules"), "*.tmp\n");
    await link(join(root, "rules"), join(path, ".gitignore"));
    const handle = {
      path,
      seedPath: path,
      manifestDigest: "sha256:abc" as const,
      sources: [],
      adapters: [],
    };
    expect((await establishBaseline(handle)).failure).toBe("Ignore rules file is hardlinked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("baseline reports an oversized .gitignore as exceeding the capture bound", async () => {
  const root = await mkdtemp(join(tmpdir(), "capture-"));
  try {
    await writeFile(join(root, ".gitignore"), Buffer.alloc(256 * 1024 + 1, 10));
    const handle = {
      path: root,
      seedPath: root,
      manifestDigest: "sha256:abc" as const,
      sources: [],
      adapters: [],
    };
    expect((await establishBaseline(handle)).failure).toBe(
      "Ignore rules exceed per-file capture bound",
    );
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
    expect(Object.keys(result.changedFiles).sort()).toEqual([".gitignore", "kept.tmp"]);
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
    expect(result.changedFiles["source/ignored-dir/tracked.txt"].change).toBe("modified");
    expect(result.changedFiles["source/tracked.txt"].change).toBe("modified");
    expect(result.changedFiles["source/ignored.txt"]).toBeUndefined();
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
    expect(result.changedFiles["z/keep.log"]).toBeDefined();
    expect(result.changedFiles["z/ignored.txt"]).toBeUndefined();
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
    expect(result.changedFiles["project/new"]).toBeDefined();
    expect(result.changedFiles["project/private"]).toBeUndefined();
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
      Object.values(result.changedFiles).reduce(
        (n, f) => n + Buffer.from(f.content, "base64").length,
        0,
      ),
    ).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(Object.keys(result.changedFiles)).toHaveLength(16);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("large writable Git source captures completely beyond Git listing and candidate bounds", async () => {
  const root = await mkdtemp(join(tmpdir(), "capture-large-"));
  try {
    // 28,000 tracked ~160-byte paths: `git ls-files -z` exceeds 4 MiB, and the tree exceeds
    // the 10,000-candidate walk bound, while every path stays inside Windows MAX_PATH.
    const bulk: string[] = [];
    for (let d = 0; d < 56; d++)
      for (let f = 0; f < 500; f++) bulk.push(`bulk/${"d".repeat(30)}${d}/${"f".repeat(120)}${f}`);
    const { work, handle } = await pinnedGitSource(
      root,
      {
        ".gitignore": "build/\n",
        "keep/edit.txt": "before\n",
        "keep/delete.txt": "gone\n",
        "zz/last.txt": "last\n",
      },
      bulk,
    );
    const baseline = await establishBaseline(handle);
    expect(baseline.failure).toBeUndefined();
    await writeFile(join(work, "keep", "edit.txt"), "after\n");
    await rm(join(work, "keep", "delete.txt"));
    await writeFile(join(work, "keep", "new.txt"), "new\n");
    await writeFile(join(work, bulk[27_999]), "bulk edit\n");
    await writeFile(join(work, "zz", "last.txt"), "last\r\n");
    // Agent-rewritten ignore rules do not expose an ignored baseline directory.
    await writeFile(join(work, ".gitignore"), "");
    await mkdir(join(work, "build"));
    await writeFile(join(work, "build", "out.o"), "private");
    const result = await captureFileChanges(handle, baseline);
    if (result.status === "failed") throw Error(result.failure.message);
    expect(result.status).toBe("complete");
    expect(Object.keys(result.changedFiles).sort()).toEqual(
      [
        "project/.gitignore",
        `project/${bulk[27_999]}`,
        "project/keep/edit.txt",
        "project/keep/new.txt",
        "project/zz/last.txt",
      ].sort(),
    );
    expect(result.changedFiles["project/keep/edit.txt"].change).toBe("modified");
    expect(result.changedFiles["project/keep/new.txt"].change).toBe("added");
    expect(result.deletedFiles).toEqual(["project/keep/delete.txt"]);
    expect(result.diff?.content).toContain("-before");
    expect(result.diff?.content).toContain("+after");
    expect(result.diff?.content).toContain("-gone");
    expect(result.diff?.content).toContain("+bulk edit");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("Git capture stays byte-exact under .gitattributes and never follows replaced directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "capture-attr-"));
  const outside = await mkdtemp(join(tmpdir(), "capture-outside-"));
  try {
    await writeFile(join(outside, "secret.txt"), "outside");
    const { work, handle } = await pinnedGitSource(root, {
      ".gitattributes": "* text eol=crlf\n",
      "eol.txt": "line\n",
      "dir/secret.txt": "inside\n",
      typed: "file\n",
    });
    const baseline = await establishBaseline(handle);
    expect(baseline.failure).toBeUndefined();
    await writeFile(join(work, "eol.txt"), "line\r\n");
    await rm(join(work, "dir"), { recursive: true });
    await symlink(outside, join(work, "dir"), "dir");
    // Git does not list untracked files under a directory that replaced a tracked file.
    await rm(join(work, "typed"));
    await mkdir(join(work, "typed"));
    await writeFile(join(work, "typed", "inner.txt"), "inner\n");
    const result = await captureFileChanges(handle, baseline);
    if (result.status === "failed") throw Error(result.failure.message);
    expect(Object.keys(result.changedFiles).sort()).toEqual([
      "project/dir",
      "project/eol.txt",
      "project/typed/inner.txt",
    ]);
    expect(Buffer.from(result.changedFiles["project/eol.txt"].content, "base64").toString()).toBe(
      "line\r\n",
    );
    expect(result.changedFiles["project/dir"].kind).toBe("symlink");
    expect(result.deletedFiles).toEqual(["project/dir/secret.txt", "project/typed"]);
    expect(JSON.stringify(result)).not.toContain(Buffer.from("outside").toString("base64"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("Git baseline failure names the Git command and its cause", async () => {
  const root = await mkdtemp(join(tmpdir(), "capture-fail-"));
  try {
    const { handle } = await pinnedGitSource(root, { "a.txt": "a\n" });
    const missing = "b".repeat(40);
    const broken = {
      ...handle,
      sources: [{ ...handle.sources[0], ref: missing, commit: missing }],
    };
    const result = await captureFileChanges(broken, await establishBaseline(broken));
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw Error("Expected failure");
    expect(result.failure.message).toMatch(
      new RegExp(`^Private Git baseline failed: git read-tree ${missing} exited with code 128: .+`),
    );
    expect(result.failure.message).not.toContain(handle.seedPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every Git command runs within one baseline or capture time bound", async () => {
  const actual = await vi.importActual<typeof ChildProcess>("node:child_process");
  const root = await mkdtemp(join(tmpdir(), "capture-deadline-"));
  const realNow = Date.now;
  let skew = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
  const commands: string[] = [];
  // `read-tree` appears to consume `consumed` ms of the operation's 90 s, and `update-index`
  // is replaced by a child that never exits on its own, so only the production timer ends it.
  const slowRefresh = (consumed: number) =>
    vi.mocked(spawn).mockImplementation(((
      command: string,
      args: readonly string[],
      options: SpawnOptions,
    ) => {
      commands.push(args.find((arg) => arg === "read-tree" || arg === "update-index") ?? "");
      if (args.includes("read-tree")) skew += consumed;
      if (!args.includes("update-index")) return actual.spawn(command, args, options);
      return actual.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
    }) as typeof spawn);
  try {
    const { handle } = await pinnedGitSource(root, { "a.txt": "a\n" });
    // The baseline's next command gets the remaining second, not a fresh 90 s.
    slowRefresh(89_000);
    const started = realNow();
    const failed = await establishBaseline(handle);
    expect(realNow() - started).toBeLessThan(30_000);
    expect(failed.failure).toBe(
      "Private Git baseline failed: git update-index -q --refresh timed out at the 90-second capture bound",
    );
    // Once the capture's bound is spent, the next Git command never starts.
    vi.mocked(spawn).mockImplementation(actual.spawn);
    skew = 0;
    const baseline = await establishBaseline(handle);
    expect(baseline.failure).toBeUndefined();
    commands.length = 0;
    slowRefresh(90_001);
    const result = await captureFileChanges(handle, baseline);
    expect(commands).toEqual(["read-tree"]);
    if (result.status !== "failed") throw Error("Expected an expired capture to fail");
    expect(result.failure).toEqual({
      code: "CAPTURE_FAILED",
      message:
        "Private Git baseline failed: git update-index -q --refresh was not started: the 90-second capture bound expired",
    });
  } finally {
    vi.mocked(spawn).mockImplementation(actual.spawn);
    clock.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
