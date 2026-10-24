import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, opendir, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTwoFilesPatch } from "diff";
import ignore from "ignore";
import { hash as contentHash } from "./fs.js";
import { redact } from "./sources/process.js";
import type { WorkspaceHandle } from "./types";

const LIMITS = {
  time: 90_000,
  candidates: 10_000,
  files: 2_000,
  fileBytes: 256 * 1024,
  totalBytes: 4 * 1024 * 1024,
  diffBytes: 1024 * 1024,
  omitted: 1_000,
  metadataBytes: 8 * 1024 * 1024,
};
interface Entry {
  kind: "file" | "symlink";
  mode: "100644" | "100755" | "120000";
  size: number;
  sha256: `sha256:${string}`;
  bytes?: Buffer;
  omittedCode?: string;
}
// Frozen matchers expose only the capture contract, not the bundled ignore package's types.
interface PathIgnoreRules {
  test(path: string): { ignored: boolean; unignored: boolean };
}
/** Tracked paths of one writable Git destination that differed from its pinned commit at baseline. */
interface GitBaseline {
  dirty: Set<string>;
  complete: boolean;
}
export interface Baseline {
  entries: Map<string, Entry>;
  ignored: { base: string; rules: PathIgnoreRules }[];
  incomplete: boolean;
  git: Map<string, GitBaseline>;
  protectedLinks: Map<string, string>;
  failure?: string;
}
export interface CapturedFile extends Omit<Entry, "bytes" | "omittedCode"> {
  change: "added" | "modified";
  encoding: "base64";
  content: string;
}
interface Result {
  schemaVersion: 2;
  changedFiles: Record<string, CapturedFile>;
  deletedFiles: string[];
  diff?: { format: "unified"; content: string; truncated: boolean };
}
export type FileChanges =
  | (Result & { status: "complete"; truncated: false })
  | (Result & {
      status: "truncated";
      truncated: true;
      truncation: { codes: string[]; omittedPaths: string[] };
    })
  | {
      schemaVersion: 2;
      status: "failed";
      changedFiles: Record<string, never>;
      deletedFiles: [];
      truncated: false;
      failure: { code: string; message: string };
    };
const hash = (bytes: Buffer) => `sha256:${contentHash(bytes)}` as const;
function same(a: Entry, b: Entry) {
  return (
    a.sha256 !== "sha256:uncaptured" &&
    a.sha256 === b.sha256 &&
    a.mode === b.mode &&
    a.kind === b.kind
  );
}
async function readEntry(path: string): Promise<Entry> {
  const before = await lstat(path);
  if (before.isSymbolicLink()) {
    const bytes = await readlink(path, { encoding: "buffer" });
    const after = await lstat(path);
    if (after.ino !== before.ino || after.dev !== before.dev || after.ctimeMs !== before.ctimeMs)
      throw Error("Link changed during capture");
    return { kind: "symlink", mode: "120000", size: bytes.length, sha256: hash(bytes), bytes };
  }
  if (!before.isFile()) throw new Error("Unsupported special file in capture");
  if (before.size > LIMITS.fileBytes)
    return {
      kind: "file",
      mode: before.mode & 0o111 ? "100755" : "100644",
      size: before.size,
      sha256: "sha256:uncaptured",
    };
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await fd.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev)
      throw new Error("File changed while opening");
    // A hardlink may alias an inode outside the workspace; never copy its bytes.
    if (opened.nlink > 1)
      return {
        kind: "file",
        mode: before.mode & 0o111 ? "100755" : "100644",
        size: opened.size,
        sha256: "sha256:uncaptured",
        omittedCode: "HARDLINK",
      };
    const bytes = Buffer.alloc(before.size + 1);
    const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
    const content = bytes.subarray(0, bytesRead);
    const after = await fd.stat();
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      content.length !== before.size
    )
      throw new Error("File changed during capture");
    return {
      kind: "file",
      mode: before.mode & 0o111 ? "100755" : "100644",
      size: content.length,
      sha256: hash(content),
      bytes: content,
    };
  } finally {
    await fd.close();
  }
}
// Writable Git sources are compared with Git against their pinned commit instead of walking every
// tracked file, so a large checkout adds only its changed and untracked paths as candidates.
type GitSource = Extract<WorkspaceHandle["sources"][number], { type: "git" }>;
/** A tracked path's pinned-commit state, for tracked paths that matched the commit at baseline. */
interface GitBefore extends Entry {
  object: string;
}
const EMPTY_TREE = {
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
};
/** Splits streamed Git records; `onRecord` returns false to stop reading. */
function records(separator: number, onRecord: (record: string) => boolean) {
  let pending: Buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0;
    for (let end = pending.indexOf(separator); end >= 0; end = pending.indexOf(separator, start)) {
      const proceed = onRecord(pending.toString("utf8", start, end));
      start = end + 1;
      if (!proceed) return false;
    }
    pending = pending.subarray(start);
    return true;
  };
}
/**
 * Runs Git without a shell within the remaining time of its baseline or capture operation.
 * A failure names the command and its cause and never has an empty detail.
 */
async function runGit(
  prefix: string[],
  args: string[],
  env: NodeJS.ProcessEnv,
  options: {
    deadline: number;
    privatePaths: string[];
    input?: string;
    limit?: number;
    onChunk?: (chunk: Buffer) => boolean;
  },
): Promise<Buffer> {
  const label = `git ${args.join(" ")}`;
  const bound = `the ${LIMITS.time / 1000}-second capture bound`;
  const remaining = options.deadline - Date.now();
  if (remaining <= 0)
    throw Error(`Private Git baseline failed: ${label} was not started: ${bound} expired`);
  const child = spawn("git", [...prefix, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  const limit = options.limit ?? 4 * 1024 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  let stderr = "";
  let cause: string | undefined;
  let stopped = false;
  const stop = (reason?: string) => {
    if (cause || stopped) return;
    if (reason) cause = reason;
    else stopped = true;
    child.kill("SIGKILL");
  };
  child.stdout.on("data", (chunk: Buffer) => {
    if (cause || stopped) return;
    if (options.onChunk) {
      try {
        if (!options.onChunk(chunk)) stop();
      } catch (error) {
        stop(`output was rejected (${error instanceof Error ? error.message : String(error)})`);
      }
      return;
    }
    size += chunk.length;
    if (size > limit) stop(`output exceeded ${limit} bytes`);
    else chunks.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 4096) stderr += chunk.toString();
  });
  child.stdin.on("error", () => {});
  child.stdin.end(options.input);
  const exited = Promise.withResolvers<[number | null, NodeJS.Signals | null]>();
  child.on("error", (error) => exited.reject(Error(`could not start (${error.message})`)));
  child.on("close", (code, signal) => exited.resolve([code, signal]));
  const timer = setTimeout(() => stop(`timed out at ${bound}`), remaining);
  try {
    const [code, signal] = await exited.promise;
    if (stopped) return Buffer.alloc(0);
    cause ??=
      code === 0
        ? undefined
        : code === null
          ? `was terminated by ${signal}`
          : `exited with code ${code}`;
    if (cause) throw Error(cause);
    return Buffer.concat(chunks);
  } catch (error) {
    const detail = stderr.trim().slice(0, 256);
    throw Error(
      redact(
        `Private Git baseline failed: ${label} ${(error as Error).message}${detail ? `: ${detail}` : ""}`,
        {},
        options.privatePaths,
      ),
    );
  } finally {
    clearTimeout(timer);
  }
}
async function walk(
  handle: WorkspaceHandle,
  temp: string,
  deadline: number,
  ignored: Baseline["ignored"],
  freeze: boolean,
  baseline?: Baseline,
) {
  const entries = new Map<string, Entry>();
  const protectedLinks = baseline?.protectedLinks ?? new Map<string, string>();
  const git = new Map<string, GitBaseline>();
  const gitBefore = new Map<string, GitBefore>();
  const unknown = new Set<string>();
  let incomplete = false;
  let count = 0;
  let retainedBytes = 0;
  let ignoreBytes = 0;
  const shared = new Set(
    handle.sources.filter((s) => s.permissions === "read-only").map((s) => s.destination),
  );
  const gitSources = handle.sources.filter(
    (s): s is GitSource => s.type === "git" && s.permissions !== "read-only",
  );
  const gitDestinations = new Set(gitSources.map((s) => s.destination));
  // Ancestors of a Git destination are always traversed, even when ignore rules exclude them.
  const gitParents = new Set<string>();
  for (const destination of gitDestinations) {
    const parts = destination.split("/");
    for (parts.pop(); parts.length; parts.pop()) gitParents.add(parts.join("/"));
  }
  const parent = (key: string) => key.slice(0, Math.max(0, key.lastIndexOf("/")));
  const directories = new Map<string, Promise<boolean>>();
  /** Whether `key` is a directory reached from the workspace root without following any link. */
  function realDirectory(key: string): Promise<boolean> {
    let known = directories.get(key);
    if (!known) {
      known = (async () => {
        if (key && !(await realDirectory(parent(key)))) return false;
        try {
          return (await lstat(join(handle.path, key))).isDirectory();
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" || code === "ENOTDIR") return false;
          throw error;
        }
      })();
      directories.set(key, known);
    }
    return known;
  }
  /** The file or link at `key`, reached without following links; directories have no entry. */
  async function entryAt(key: string): Promise<Entry | undefined> {
    if (!(await realDirectory(parent(key)))) return undefined;
    const path = join(handle.path, key);
    try {
      if ((await lstat(path)).isDirectory()) return undefined;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      throw error;
    }
    return readEntry(path);
  }
  function record(key: string, entry: Entry) {
    if (entry.bytes) {
      const before = baseline?.entries.get(key);
      if (!freeze && before && same(before, entry)) delete entry.bytes;
      else if (retainedBytes + entry.bytes.length > LIMITS.totalBytes) {
        delete entry.bytes;
        entry.omittedCode = "TOTAL_BYTES";
      } else retainedBytes += entry.bytes.length;
    }
    entries.set(key, entry);
  }
  async function freezeRules(dir: string, rel: string) {
    try {
      const ignorePath = join(dir, ".gitignore");
      const info = await lstat(ignorePath);
      if (info.isFile()) {
        const entry = await readEntry(ignorePath);
        if (!entry.bytes)
          throw Error(
            entry.omittedCode === "HARDLINK"
              ? "Ignore rules file is hardlinked"
              : "Ignore rules exceed per-file capture bound",
          );
        ignoreBytes += entry.bytes.length;
        if (ignoreBytes > LIMITS.totalBytes)
          throw Error("Frozen ignore rules exceed capture bound");
        ignored.push({ base: rel, rules: ignore().add(entry.bytes.toString("utf8")) });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  function excluded(key: string, directory: boolean) {
    let result = false;
    for (const rule of ignored) {
      const relative = rule.base
        ? key.startsWith(`${rule.base}/`)
          ? key.slice(rule.base.length + 1)
          : undefined
        : key;
      if (relative === undefined) continue;
      const match = rule.rules.test(relative + (directory ? "/" : ""));
      if (match.ignored) result = true;
      else if (match.unignored) result = false;
    }
    return result;
  }
  async function visit(dir: string, rel: string) {
    if (freeze) await freezeRules(dir, rel);
    const names: string[] = [];
    const directory = await opendir(dir);
    for await (const entry of directory) {
      if (names.length + count >= LIMITS.candidates) {
        incomplete = true;
        break;
      }
      names.push(entry.name);
    }
    for (const name of names.sort()) {
      if (++count > LIMITS.candidates || Date.now() > deadline) {
        incomplete = true;
        return;
      }
      if (name === ".git") continue;
      const key = rel ? `${rel}/${name}` : name;
      if (gitDestinations.has(key)) continue;
      const path = join(dir, name);
      const stat = await lstat(path);
      if (shared.has(key) && stat.isSymbolicLink()) {
        const target = await readlink(path);
        if (freeze) {
          protectedLinks.set(key, target);
          continue;
        }
        if (protectedLinks.get(key) === target) continue;
      }
      if (excluded(key, stat.isDirectory()) && !gitParents.has(key)) continue;
      if (stat.isDirectory()) await visit(path, key);
      else record(key, await readEntry(path));
      if (incomplete) return;
    }
  }
  async function visitGit(source: GitSource, index: number) {
    const key = source.destination;
    const real = await realDirectory(key);
    if (!real) {
      // A replaced destination is captured itself; every tracked path under it is deleted.
      const entry = await entryAt(key);
      if (entry) record(key, entry);
      await mkdir(join(temp, `empty-${index}`));
    }
    const env = {
      PATH: process.env.PATH,
      HOME: temp,
      GIT_INDEX_FILE: join(temp, `index-${index}`),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      // Without attributes, Git compares raw bytes: no .gitattributes can normalize an edit away.
      GIT_ATTR_SOURCE: source.commit.length === 64 ? EMPTY_TREE.sha256 : EMPTY_TREE.sha1,
    };
    const prefix = [
      "--git-dir",
      join(handle.seedPath, key, ".git"),
      "--work-tree",
      real ? join(handle.path, key) : join(temp, `empty-${index}`),
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-c",
      "core.autocrlf=false",
    ];
    const run = (
      args: string[],
      options: Omit<Parameters<typeof runGit>[3], "deadline" | "privatePaths"> = {},
    ) =>
      runGit(prefix, args, env, {
        ...options,
        deadline,
        privatePaths: [handle.seedPath, temp],
      });
    // A private index of the pinned commit, refreshed by content against the worktree.
    await run(["read-tree", source.commit]);
    await run(["update-index", "-q", "--refresh"], { onChunk: () => true });
    const dirty = new Map<string, { mode: string; object: string }>();
    let complete = true;
    let header: string[] | undefined;
    await run(["diff-files", "-z"], {
      onChunk: records(0, (token) => {
        if (!header) {
          header = token.split(" ");
          return true;
        }
        const [mode, , object] = header;
        header = undefined;
        if (++count > LIMITS.candidates || Date.now() > deadline) {
          incomplete = true;
          complete = false;
          return false;
        }
        if (mode !== ":100644" && mode !== ":100755" && mode !== ":120000")
          throw Error("Unsupported Git file mode");
        dirty.set(`${key}/${token}`, { mode: mode.slice(1), object });
        return true;
      }),
    });
    if (freeze) git.set(key, { dirty: new Set(dirty.keys()), complete });
    const prior = baseline?.git.get(key);
    const roots = new Set<string>();
    const pinned: GitBefore[] = [];
    for (const path of [...new Set([...(prior?.dirty ?? []), ...dirty.keys()])].sort()) {
      const change = dirty.get(path);
      if (!freeze && change && !prior?.dirty.has(path)) {
        // Without a complete baseline listing, this path's baseline state is unknown.
        if (!prior?.complete) {
          unknown.add(path);
          continue;
        }
        const before: GitBefore = {
          kind: change.mode === "120000" ? "symlink" : "file",
          mode: change.mode as Entry["mode"],
          size: 0,
          sha256: "sha256:uncaptured",
          object: change.object,
        };
        gitBefore.set(path, before);
        pinned.push(before);
      }
      const entry = await entryAt(path);
      if (entry) record(path, entry);
      // Git does not list untracked contents of a directory that replaced a tracked file.
      else if (await realDirectory(path)) roots.add(path.slice(key.length + 1));
    }
    await run(["ls-files", "--others", "--directory", "-z"], {
      onChunk: records(0, (path) => {
        if (roots.size + count >= LIMITS.candidates) {
          incomplete = true;
          return false;
        }
        roots.add(path.replace(/\/$/, ""));
        return true;
      }),
    });
    if (freeze) {
      // Tracked directories are always traversed, so every .gitignore directly inside one applies.
      const rules = [...roots].filter(
        (path) => path === ".gitignore" || path.endsWith("/.gitignore"),
      );
      await run(["ls-files", "-z", "--", ".gitignore", "*/.gitignore"], {
        onChunk: records(0, (path) => {
          if (path === ".gitignore" || path.endsWith("/.gitignore")) rules.push(path);
          return true;
        }),
      });
      // Sorting bases puts every ancestor's rules before its descendants'.
      for (const base of [...new Set(rules.map(parent))].sort()) {
        const rel = base ? `${key}/${base}` : key;
        if (await realDirectory(rel)) await freezeRules(join(handle.path, rel), rel);
      }
    }
    for (const root of [...roots].sort()) {
      if (++count > LIMITS.candidates || Date.now() > deadline) {
        incomplete = true;
        return;
      }
      const path = `${key}/${root}`;
      if (!(await realDirectory(parent(path)))) continue;
      const stat = await lstat(join(handle.path, path));
      if (excluded(path, stat.isDirectory())) continue;
      if (stat.isDirectory()) await visit(join(handle.path, path), path);
      else record(path, await readEntry(join(handle.path, path)));
      if (incomplete) return;
    }
    if (!pinned.length) return;
    // Pinned bytes of changed tracked files feed the diff within the per-file and total bounds.
    const objects = `${[...new Set(pinned.map((entry) => entry.object))].join("\n")}\n`;
    const sizes = new Map<string, number>();
    await run(["cat-file", "--batch-check"], {
      input: objects,
      onChunk: records(10, (line) => {
        const [object, type, size] = line.split(" ");
        if (type === "blob") sizes.set(object, Number(size));
        return true;
      }),
    });
    const selected = new Set<string>();
    let budget = 0;
    for (const entry of pinned) {
      const size = sizes.get(entry.object);
      if (size === undefined) continue;
      entry.size = size;
      if (selected.has(entry.object) || size > LIMITS.fileBytes) continue;
      if (budget + size > LIMITS.totalBytes) continue;
      selected.add(entry.object);
      budget += size;
    }
    if (!selected.size) return;
    const output = await run(["cat-file", "--batch"], {
      input: `${[...selected].join("\n")}\n`,
      limit: budget + selected.size * 128,
    });
    const bodies = new Map<string, Buffer>();
    for (let offset = 0; offset < output.length; ) {
      const newline = output.indexOf(10, offset);
      const [object, type, size] = output
        .toString("utf8", offset, Math.max(offset, newline))
        .split(" ");
      const end = newline + 1 + Number(size);
      if (newline < 0 || type !== "blob" || output[end] !== 10)
        throw Error("Malformed Git object stream");
      bodies.set(object, output.subarray(newline + 1, end));
      offset = end + 1;
    }
    for (const entry of pinned) {
      const bytes = bodies.get(entry.object);
      if (!bytes) continue;
      entry.bytes = bytes;
      entry.sha256 = hash(bytes);
    }
  }
  await visit(handle.path, "");
  for (const [index, source] of gitSources.entries()) {
    if (incomplete) break;
    await visitGit(source, index);
  }
  return { entries, ignored, incomplete, git, protectedLinks, gitBefore, unknown };
}
export async function establishBaseline(handle: WorkspaceHandle): Promise<Baseline> {
  // One time bound covers the whole baseline, including every Git command it runs.
  const deadline = Date.now() + LIMITS.time;
  let temp: string | undefined;
  try {
    temp = await mkdtemp(join(tmpdir(), "allagents-baseline-"));
    const { entries, ignored, incomplete, git, protectedLinks } = await walk(
      handle,
      temp,
      deadline,
      [],
      true,
    );
    return { entries, ignored, incomplete, git, protectedLinks };
  } catch (error) {
    return {
      entries: new Map(),
      ignored: [],
      incomplete: false,
      git: new Map(),
      failure: (error instanceof Error && error.message) || "Baseline failed",
      protectedLinks: new Map(),
    };
  } finally {
    if (temp) await rm(temp, { recursive: true, force: true });
  }
}
export async function captureFileChanges(
  handle: WorkspaceHandle,
  baseline: Baseline,
): Promise<FileChanges> {
  // One time bound covers the walk, every Git command, and the comparison.
  const deadline = Date.now() + LIMITS.time;
  let temp: string | undefined;
  try {
    if (baseline.failure) throw Error(baseline.failure);
    temp = await mkdtemp(join(tmpdir(), "allagents-capture-"));
    const after = await walk(handle, temp, deadline, baseline.ignored, false, baseline);
    const changedFiles: Record<string, CapturedFile> = {};
    const deletedFiles: string[] = [];
    const omittedPaths: string[] = [];
    const codes = new Set<string>();
    let total = 0;
    let returned = 0;
    let diff = "";
    let diffTruncated = false;
    function omit(code: string, path: string) {
      codes.add(code);
      if (omittedPaths.length < LIMITS.omitted) omittedPaths.push(path);
      else codes.add("OMITTED_PATHS");
    }
    if (after.incomplete || baseline.incomplete) codes.add("CANDIDATES_OR_TIME");
    const paths = new Set([
      ...baseline.entries.keys(),
      ...after.entries.keys(),
      ...after.gitBefore.keys(),
      ...after.unknown,
    ]);
    for (const path of [...paths].sort()) {
      if (Date.now() > deadline) {
        omit("TIME", path);
        break;
      }
      if (after.unknown.has(path)) {
        omit("CANDIDATES_OR_TIME", path);
        continue;
      }
      const before = baseline.entries.get(path) ?? after.gitBefore.get(path);
      const current = after.entries.get(path);
      if (before && current && same(before, current)) continue;
      if (!current && after.incomplete) {
        omit("INCOMPLETE_WALK", path);
        continue;
      }
      if (++returned > LIMITS.files) {
        omit("FILES", path);
        continue;
      }
      if (current) {
        if (!current.bytes) {
          omit(current.omittedCode ?? "FILE_BYTES", path);
          continue;
        }
        if (total + current.bytes.length > LIMITS.totalBytes) {
          omit("TOTAL_BYTES", path);
          continue;
        }
        total += current.bytes.length;
        Object.defineProperty(changedFiles, path, {
          enumerable: true,
          value: {
            kind: current.kind,
            mode: current.mode,
            size: current.size,
            sha256: current.sha256,
            change: before ? "modified" : "added",
            encoding: "base64",
            content: current.bytes.toString("base64"),
          },
        });
      } else deletedFiles.push(path);
      if (
        (!before || before.bytes) &&
        (!current || current.bytes) &&
        !before?.bytes?.includes(0) &&
        !current?.bytes?.includes(0)
      ) {
        const patch = createTwoFilesPatch(
          `a/${path}`,
          `b/${path}`,
          before?.bytes?.toString("utf8") ?? "",
          current?.bytes?.toString("utf8") ?? "",
          undefined,
          undefined,
          {
            maxEditLength: 10000,
            ...{ timeout: Math.max(1, Math.min(1000, deadline - Date.now())) },
          },
        );
        if (patch === undefined) {
          diffTruncated = true;
          codes.add("DIFF_TIME_OR_COMPLEXITY");
          continue;
        }
        if (Buffer.byteLength(diff) + Buffer.byteLength(patch) <= LIMITS.diffBytes) diff += patch;
        else {
          diffTruncated = true;
          codes.add("DIFF_BYTES");
        }
      }
    }
    const result: Result = {
      schemaVersion: 2,
      changedFiles,
      deletedFiles,
      ...(diff || diffTruncated
        ? { diff: { format: "unified" as const, content: diff, truncated: diffTruncated } }
        : {}),
    };
    if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.metadataBytes)
      throw new Error("Serialized capture exceeds metadata bound");
    return codes.size
      ? {
          ...result,
          status: "truncated",
          truncated: true,
          truncation: { codes: [...codes].sort(), omittedPaths },
        }
      : { ...result, status: "complete", truncated: false };
  } catch (error) {
    return {
      schemaVersion: 2,
      status: "failed",
      changedFiles: {},
      deletedFiles: [],
      truncated: false,
      failure: {
        code: "CAPTURE_FAILED",
        message: (error instanceof Error && error.message) || "Capture failed",
      },
    };
  } finally {
    if (temp) await rm(temp, { recursive: true, force: true });
  }
}
