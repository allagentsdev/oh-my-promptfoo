import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, opendir, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTwoFilesPatch } from "diff";
import ignore, { type Ignore } from "ignore";
import { hash as contentHash } from "./fs.js";
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
export interface Baseline {
  entries: Map<string, Entry>;
  ignored: { base: string; rules: Ignore }[];
  incomplete: boolean;
  tracked: Set<string>;
  protectedLinks: Map<string, string>;
  failure?: string;
}
export interface CapturedFile extends Omit<Entry, "bytes" | "omittedCode"> {
  change: "added" | "modified";
  encoding: "base64";
  content: string;
}
interface Result {
  schemaVersion: 1;
  generatedFiles: Record<string, CapturedFile>;
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
      schemaVersion: 1;
      status: "failed";
      generatedFiles: Record<string, never>;
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
async function readEntry(path: string): Promise<Entry | undefined> {
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
async function walk(
  handle: WorkspaceHandle,
  ignored: { base: string; rules: Ignore }[],
  freeze: boolean,
  tracked: Set<string>,
  baseline?: Baseline,
) {
  const entries = new Map<string, Entry>();
  const protectedLinks = baseline?.protectedLinks ?? new Map<string, string>();
  let incomplete = false;
  const started = Date.now();
  let count = 0;
  let retainedBytes = 0;
  let ignoreBytes = 0;
  const shared = new Set(
    handle.sources.filter((s) => s.permissions === "read-only").map((s) => s.destination),
  );
  const trackedParents = new Set<string>();
  for (const path of tracked) {
    const parts = path.split("/");
    parts.pop();
    while (parts.length) {
      trackedParents.add(parts.join("/"));
      parts.pop();
    }
  }
  async function visit(dir: string, rel: string) {
    if (freeze) {
      try {
        const ignorePath = join(dir, ".gitignore");
        const info = await lstat(ignorePath);
        if (info.isFile()) {
          const entry = await readEntry(ignorePath);
          if (!entry?.bytes) throw Error("Ignore rules exceed per-file capture bound");
          ignoreBytes += entry.bytes.length;
          if (ignoreBytes > LIMITS.totalBytes)
            throw Error("Frozen ignore rules exceed capture bound");
          ignored.push({ base: rel, rules: ignore().add(entry.bytes.toString("utf8")) });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
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
      if (++count > LIMITS.candidates || Date.now() - started > LIMITS.time) {
        incomplete = true;
        return;
      }
      if (name === ".git") continue;
      const key = rel ? `${rel}/${name}` : name;
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
      let excluded = false;
      for (const rule of ignored) {
        const relative = rule.base
          ? key.startsWith(`${rule.base}/`)
            ? key.slice(rule.base.length + 1)
            : undefined
          : key;
        if (relative === undefined) continue;
        const result = rule.rules.test(relative + (stat.isDirectory() ? "/" : ""));
        if (result.ignored) excluded = true;
        else if (result.unignored) excluded = false;
      }
      if (excluded && !tracked.has(key) && !trackedParents.has(key)) continue;
      if (stat.isDirectory()) await visit(path, key);
      else {
        const entry = await readEntry(path);
        if (entry) {
          if (entry.bytes) {
            if (!freeze && baseline?.entries.get(key) && same(baseline.entries.get(key)!, entry))
              delete entry.bytes;
            else if (retainedBytes + entry.bytes.length > LIMITS.totalBytes) {
              delete entry.bytes;
              entry.omittedCode = "TOTAL_BYTES";
            } else retainedBytes += entry.bytes.length;
          }
          entries.set(key, entry);
        }
      }
      if (incomplete) return;
    }
  }
  await visit(handle.path, "");
  return { entries, ignored, incomplete, tracked, protectedLinks };
}
async function gitOutput(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const child = spawn("git", args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = Buffer.alloc(0);
  let error = "";
  let overflow = false;
  child.stdout.on("data", (chunk: Buffer) => {
    if (output.length + chunk.length > 4 * 1024 * 1024) {
      overflow = true;
      child.kill("SIGKILL");
    } else output = Buffer.concat([output, chunk]);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (error.length < 4096) error += chunk.toString();
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), LIMITS.time);
  try {
    await new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 && !overflow
          ? resolve()
          : reject(Error(`Private Git baseline failed: ${error.slice(0, 256)}`)),
      );
    });
    return output.toString();
  } finally {
    clearTimeout(timer);
  }
}
export async function establishBaseline(handle: WorkspaceHandle): Promise<Baseline> {
  const tracked = new Set<string>();
  let temp: string | undefined;
  try {
    temp = await mkdtemp(join(tmpdir(), "allagents-baseline-"));
    for (const source of handle.sources) {
      if (source.type !== "git" || source.permissions === "read-only") continue;
      const env = {
        PATH: process.env.PATH,
        HOME: temp,
        GIT_INDEX_FILE: join(temp, `index-${tracked.size}`),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      };
      const args = [
        "--git-dir",
        join(handle.seedPath, source.destination, ".git"),
        "--work-tree",
        join(handle.path, source.destination),
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
      ];
      await gitOutput([...args, "read-tree", source.commit], env);
      for (const path of (await gitOutput([...args, "ls-files", "-c", "-z"], env))
        .split("\0")
        .filter(Boolean))
        tracked.add(`${source.destination}/${path}`);
    }
    return await walk(handle, [], true, tracked);
  } catch (error) {
    return {
      entries: new Map(),
      ignored: [],
      incomplete: false,
      tracked,
      failure: error instanceof Error ? error.message : "Baseline failed",
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
  const deadline = Date.now() + LIMITS.time;
  try {
    if (baseline.failure) throw Error(baseline.failure);
    const after = await walk(handle, baseline.ignored, false, baseline.tracked, baseline);
    const generatedFiles: Record<string, CapturedFile> = {};
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
    for (const path of [...new Set([...baseline.entries.keys(), ...after.entries.keys()])].sort()) {
      if (Date.now() > deadline) {
        omit("TIME", path);
        break;
      }
      const before = baseline.entries.get(path);
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
        Object.defineProperty(generatedFiles, path, {
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
      schemaVersion: 1,
      generatedFiles,
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
      schemaVersion: 1,
      status: "failed",
      generatedFiles: {},
      deletedFiles: [],
      truncated: false,
      failure: {
        code: "CAPTURE_FAILED",
        message: error instanceof Error ? error.message : "Capture failed",
      },
    };
  }
}
