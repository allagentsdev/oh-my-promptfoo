import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { destination } from "./config.js";
import { assertNoSymlinkAncestors, contained, json, MARKER, PACKAGE, treeStamp } from "./fs.js";
import { publishProgress } from "./progress.js";
import { runSource, sourceEnvironment } from "./sources/process.js";
import type { GitSource, ResolvedSource, RuntimeChannels, WorkspaceSpec } from "./types.js";

interface Entry {
  repository: string;
  commit: string;
  destination: string;
}
interface Manifest {
  schemaVersion: 1;
  sources: Entry[];
}
const commitPattern = /^[a-f0-9]{40}$/;
const validUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
};
export function preparedKey(source: Entry): string {
  return createHash("sha256")
    .update(JSON.stringify([source.repository, source.commit, source.destination]))
    .digest("hex");
}

async function privateDirectory(path: string, strictMode = false): Promise<void> {
  try {
    await assertNoSymlinkAncestors(path);
    const info = await lstat(path);
    if (
      !info.isDirectory() ||
      (process.getuid && info.uid !== process.getuid()) ||
      (process.platform !== "win32" && (info.mode & (strictMode ? 0o077 : 0o022)) !== 0)
    )
      throw new Error("Unsafe prepared source directory");
  } catch {
    throw new Error("Prepared source directory is not private or owned");
  }
}

/** The runner, not the provider, owns this root. No operation here writes to it. */
export class PreparedSources {
  private readonly entries = new Map<string, Entry>();
  private readonly stamps = new Map<string, string>();
  private readonly invalid = new Set<string>();
  private constructor(
    readonly root: string,
    private channels: RuntimeChannels,
  ) {}

  static async open(
    root: string,
    spec: WorkspaceSpec,
    channels: RuntimeChannels,
    cache: string,
    runtime: string,
  ): Promise<PreparedSources> {
    if (!root || !isAbsolute(root) || resolve(root) !== root)
      throw new Error("Prepared source root must be an absolute normalized path");
    for (const other of [cache, runtime]) {
      const distance = relative(root, other);
      const inverse = relative(other, root);
      const inside = (value: string) =>
        !value || (value !== ".." && !value.startsWith(`..${sep}`) && !value.startsWith(sep));
      if (inside(distance) || inside(inverse))
        throw new Error("Prepared source root overlaps package roots");
    }
    await privateDirectory(root, true);
    try {
      for (const name of [MARKER, "manifest.json"]) {
        const info = await lstat(join(root, name));
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          (process.getuid && info.uid !== process.getuid()) ||
          (process.platform !== "win32" && (info.mode & 0o022) !== 0)
        )
          throw new Error("Unsafe prepared source metadata");
      }
    } catch {
      throw new Error("Prepared source metadata is not private or owned");
    }
    let marker: { schemaVersion: number; package: string; kind: string };
    try {
      marker = await json<typeof marker>(join(root, MARKER), 4096);
    } catch {
      throw new Error("Invalid prepared source ownership marker");
    }
    if (
      !marker ||
      Object.keys(marker).sort().join(",") !== "kind,package,schemaVersion" ||
      marker.schemaVersion !== 1 ||
      marker.package !== PACKAGE ||
      marker.kind !== "prebuilt-sources"
    )
      throw new Error("Invalid prepared source ownership marker");
    await privateDirectory(join(root, "sources"));
    let manifest: Manifest;
    try {
      manifest = await json<Manifest>(join(root, "manifest.json"), 1024 * 1024);
    } catch {
      throw new Error("Invalid prepared source manifest");
    }
    if (
      !manifest ||
      Object.keys(manifest).sort().join(",") !== "schemaVersion,sources" ||
      manifest.schemaVersion !== 1 ||
      !Array.isArray(manifest.sources)
    )
      throw new Error("Invalid prepared source manifest");
    const prepared = new PreparedSources(root, channels);
    for (const source of manifest.sources) {
      if (
        !source ||
        Object.keys(source).sort().join(",") !== "commit,destination,repository" ||
        !validUrl(source.repository) ||
        !commitPattern.test(source.commit) ||
        destination(source.destination) !== source.destination
      )
        throw new Error("Invalid prepared source identity");
      if (prepared.entries.has(source.destination)) throw new Error("Duplicate prepared source");
      prepared.entries.set(source.destination, source);
    }
    if (spec.sources.some((source) => source.type === "oci"))
      throw new Error("Prepared source root refuses remote OCI acquisition");
    if (
      spec.sources.some(
        (source) =>
          source.type === "git" &&
          validUrl(source.repository) &&
          source.permissions !== "read-only",
      )
    )
      throw new Error("Prepared source root refuses writable remote Git acquisition");
    const required = spec.sources.filter(
      (source): source is GitSource =>
        source.type === "git" && source.permissions === "read-only" && validUrl(source.repository),
    );
    if (required.length !== prepared.entries.size)
      throw new Error("Prepared source manifest does not match workspace sources");
    for (const source of required) {
      const listed = prepared.entries.get(source.destination);
      if (!listed || listed.repository !== source.repository || source.ref !== listed.commit)
        throw new Error("Prepared source manifest does not match pinned Git source");
    }
    return prepared;
  }

  resolves(source: GitSource): ResolvedSource | undefined {
    const entry = this.entries.get(source.destination);
    if (!entry) return undefined;
    return { ...source, commit: entry.commit, materializerVersion: 1 };
  }

  path(source: Entry): string {
    return contained(this.root, join(this.root, "sources", preparedKey(source), "protected"));
  }

  async check(
    source: Entry,
    baseline?: string,
    progress?: { caseIndex: number; sourceIndex: number; sourceCount: number },
  ): Promise<string> {
    const key = preparedKey(source);
    if (this.invalid.has(key))
      throw new Error("Prepared source checkout mutated; reuse invalidated");
    const path = this.path(source);
    try {
      await privateDirectory(join(this.root, "sources", key));
      await privateDirectory(join(this.root, "sources", key, "seed"));
      await privateDirectory(join(this.root, "sources", key, "mirror"));
      await privateDirectory(path);
      const git = join(path, ".git");
      await privateDirectory(git);
      const alternates = join(git, "objects", "info", "alternates");
      const alternate = await lstat(alternates).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (alternate) throw new Error("Prepared Git objects must be self-contained");
      // Use private child configuration only; neither the runner's credentials nor Git's
      // local hooks, aliases, replacements or fsmonitor are allowed into validation.
      const args = [
        "--no-optional-locks",
        "--no-replace-objects",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
        "-C",
        path,
        `--git-dir=${git}`,
        `--work-tree=${path}`,
      ];
      const env = sourceEnvironment(this.root);
      const run = async (command: string[]) =>
        runSource("git", [...args, ...command], {
          env,
          channels: this.channels,
          privatePaths: [this.root, path],
          limit: 4096,
        });
      if (progress)
        publishProgress(
          "protected-git-check-start",
          progress.caseIndex,
          progress.sourceIndex,
          progress.sourceCount,
        );
      let gitOutcome: "ok" | "error" = "error";
      try {
        if ((await run(["rev-parse", "--verify", "HEAD"])).toString().trim() !== source.commit)
          throw new Error("Prepared source HEAD differs from pinned commit");
        if ((await run(["status", "--porcelain=v1", "-z", "--untracked-files=all"])).length)
          throw new Error("Prepared source Git worktree is not clean");
        gitOutcome = "ok";
      } finally {
        if (progress)
          publishProgress(
            "protected-git-check-finished",
            progress.caseIndex,
            progress.sourceIndex,
            progress.sourceCount,
            gitOutcome,
          );
      }
      if (progress)
        publishProgress(
          "protected-stamp-start",
          progress.caseIndex,
          progress.sourceIndex,
          progress.sourceCount,
        );
      let stampOutcome: "ok" | "error" = "error";
      try {
        const stamp = await treeStamp(path, true);
        const expected = baseline ?? this.stamps.get(key);
        if (expected && expected !== stamp) throw new Error("Prepared source checkout mutated");
        this.stamps.set(key, stamp);
        stampOutcome = "ok";
        return stamp;
      } finally {
        if (progress)
          publishProgress(
            "protected-stamp-finished",
            progress.caseIndex,
            progress.sourceIndex,
            progress.sourceCount,
            stampOutcome,
          );
      }
    } catch {
      this.invalid.add(key);
      throw new Error("Prepared source checkout failed integrity verification");
    }
  }
}
