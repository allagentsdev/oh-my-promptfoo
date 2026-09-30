import { createHash, randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { gitUsesRemoteAcquisition } from "../acquisition-budget.ts";
import { atomicJson, isMounted, json, MARKER, PACKAGE, processIdentity } from "../fs.ts";
import { helperAvailable, helperInvoke } from "../helper.ts";
import type { GitSource, ResolvedSource, RuntimeChannels, SourceLimits } from "../types.ts";
import { type PhysicalWriter, runSource, withPrivateAcquisition } from "./process.ts";

type ResolvedGit = Extract<ResolvedSource, { type: "git" }>;
const safeGitArgs = [
  "--no-replace-objects",
  "-c",
  "core.fsmonitor=false",
  "-c",
  `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
  "-c",
  "credential.helper=",
  "-c",
  "protocol.file.allow=always",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "core.untrackedCache=false",
];
const hexObject = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const preparationPhases = channel("allagents.workspace.preparation");
async function measuredGitPhase<T>(phase: string, work: () => Promise<T>): Promise<T> {
  if (!preparationPhases.hasSubscribers) return work();
  const start = process.hrtime.bigint();
  try {
    return await work();
  } finally {
    preparationPhases.publish({
      phase,
      elapsedMs: Number(process.hrtime.bigint() - start) / 1_000_000,
    });
  }
}

export function containedPath(root: string, path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    path
      .split("/")
      .some((piece) => !piece || piece === "." || piece === ".." || piece.toLowerCase() === ".git")
  )
    throw new Error("Source contains an unsafe file path");
  const destination = resolve(root, path);
  if (!destination.startsWith(`${resolve(root)}${sep}`))
    throw new Error("Source path escapes its destination");
  return destination;
}

async function gitCredentials(
  root: string,
  env: NodeJS.ProcessEnv,
  channels: RuntimeChannels,
): Promise<NodeJS.ProcessEnv> {
  if (!channels.ALLAGENTS_GIT_TOKEN && !channels.ALLAGENTS_GIT_USERNAME) return env;
  const helper = join(root, "askpass.cjs");
  await writeFile(
    helper,
    '#!/usr/bin/env node\nprocess.stdout.write((/username/i.test(process.argv[2] || "") ? process.env.ALLAGENTS_PRIVATE_GIT_USERNAME || "" : process.env.ALLAGENTS_PRIVATE_GIT_TOKEN || "") + "\\n");\n',
    { mode: 0o700 },
  );
  if (process.platform === "win32") {
    // Windows does not execute a .cjs shebang directly. The wrapper receives
    // no untrusted prompt arguments: Git already has a private username, so
    // the only remaining askpass value is the private token.
    await writeFile(
      join(root, "askpass.cmd"),
      `@echo off\r\n"${process.execPath}" "%~dp0askpass.cjs"\r\n`,
      { mode: 0o700 },
    );
  }
  return {
    ...env,
    GIT_ASKPASS: process.platform === "win32" ? join(root, "askpass.cmd") : helper,
    GIT_ASKPASS_REQUIRE: "force",
    ...(process.platform === "win32"
      ? {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "credential.username",
          GIT_CONFIG_VALUE_0: channels.ALLAGENTS_GIT_USERNAME ?? "oauth2",
        }
      : {}),
    ALLAGENTS_PRIVATE_GIT_USERNAME: channels.ALLAGENTS_GIT_USERNAME ?? "oauth2",
    ALLAGENTS_PRIVATE_GIT_TOKEN: channels.ALLAGENTS_GIT_TOKEN ?? "",
  };
}

export async function resolveGit(
  source: GitSource,
  channels: RuntimeChannels,
  signal?: AbortSignal,
): Promise<ResolvedGit> {
  return withPrivateAcquisition(channels, async (root, env) => {
    if (!gitUsesRemoteAcquisition(source.repository)) {
      const repository = fileURLToPath(source.repository);
      const response = await runSource(
        "git",
        [
          ...safeGitArgs,
          "-C",
          repository,
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${source.ref}^{commit}`,
        ],
        { env, channels, signal, privatePaths: [root, repository] },
      );
      const commit = response.toString().trim();
      if (!hexObject.test(commit)) throw new Error("Git did not resolve an immutable commit");
      return { ...source, commit, materializerVersion: 1 };
    }
    if (hexObject.test(source.ref))
      return { ...source, commit: source.ref, materializerVersion: 1 };
    const gitEnv = await gitCredentials(root, env, channels);
    const response = await runSource(
      "git",
      [
        ...safeGitArgs,
        "ls-remote",
        "--exit-code",
        source.repository,
        source.ref,
        `refs/heads/${source.ref}`,
        `refs/tags/${source.ref}`,
        `refs/tags/${source.ref}^{}`,
      ],
      { env: gitEnv, channels, signal, privatePaths: [root] },
    );
    const refs = response
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("\t"));
    const exact =
      refs.find(([, name]) => name === source.ref) ??
      refs.find(([, name]) => name === `refs/heads/${source.ref}`) ??
      refs.find(([, name]) => name === `refs/tags/${source.ref}`);
    if (!exact) throw new Error("Requested Git ref was not found");
    const peeled = refs.find(([, name]) => name === `${exact[1]}^{}`);
    const commit = (peeled ?? exact)[0];
    if (!hexObject.test(commit)) throw new Error("Git did not resolve an immutable commit");
    return { ...source, commit, materializerVersion: 1 };
  });
}

interface TreeFile {
  mode: string;
  object: string;
  path: string;
}
function parseTreeListing(bytes: Buffer, root: string): TreeFile[] {
  const entries: TreeFile[] = [];
  const names = new Set<string>();
  for (const value of bytes.toString("utf8").split("\0")) {
    if (!value) continue;
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(value);
    if (!match || match[1] === "160000" || match[2] !== "blob")
      throw new Error("Git submodules and special tree entries are not supported");
    if (!["100644", "100755", "120000"].includes(match[1]))
      throw new Error("Unsupported Git file mode");
    const path = match[4];
    containedPath(root, path);
    if (path === ".gitmodules" || path.endsWith("/.gitmodules"))
      throw new Error("Git submodules are not supported");
    if (path.includes("\ufffd") || names.has(path.normalize("NFC")))
      throw new Error("Git contains invalid or conflicting file names");
    names.add(path.normalize("NFC"));
    entries.push({ mode: match[1], object: match[3], path });
  }
  return entries;
}

async function writeDetachedGit(
  root: string,
  commit: string,
  writer?: PhysicalWriter,
): Promise<void> {
  if (writer) await writer.directory(join(root, ".git", "refs"));
  else await mkdir(join(root, ".git", "refs"), { recursive: true });
  const files = {
    HEAD: `${commit}\n`,
    shallow: `${commit}\n`,
    config: `[core]\n\trepositoryformatversion = ${commit.length === 64 ? 1 : 0}\n\tbare = false\n\tfilemode = ${process.platform === "win32" ? "false" : "true"}\n${commit.length === 64 ? "[extensions]\n\tobjectformat = sha256\n" : ""}`,
  };
  for (const [name, bytes] of Object.entries(files)) {
    if (writer) await writer.file(join(root, ".git", name), bytes);
    else await writeFile(join(root, ".git", name), bytes);
  }
}

/** Local acquisition never launches a filesystem writer: every byte is written by the bounded parent. */
async function materializeLocal(
  source: ResolvedGit,
  destination: string,
  limits: SourceLimits,
  channels: RuntimeChannels,
  writer: PhysicalWriter,
  signal?: AbortSignal,
): Promise<number> {
  const repository = fileURLToPath(source.repository);
  return withPrivateAcquisition(channels, async (root, env) => {
    const options = { env, channels, signal, privatePaths: [root, repository] };
    const listing = await runSource(
      "git",
      [...safeGitArgs, "-C", repository, "ls-tree", "-rz", "--full-tree", source.commit],
      { ...options, limit: limits.maxDownloadBytes },
    );
    const entries = parseTreeListing(listing, destination);
    const byObject = new Map<string, TreeFile[]>();
    for (const entry of entries)
      byObject.set(entry.object, [...(byObject.get(entry.object) ?? []), entry]);
    const objectList = (
      await runSource(
        "git",
        [
          ...safeGitArgs,
          "-C",
          repository,
          "rev-list",
          "--objects",
          "--no-object-names",
          "--no-walk",
          source.commit,
        ],
        { ...options, limit: limits.maxDownloadBytes },
      )
    )
      .toString()
      .trim()
      .split("\n");
    if (!objectList.every((object) => hexObject.test(object)))
      throw new Error("Invalid Git object inventory");
    await writer.directory(join(destination, ".git", "objects"));
    let received = 0;
    let extracted = 0;
    let compressedBytes = 0;
    let pending = Buffer.alloc(0);
    let current: { id: string; type: string; size: number } | undefined;
    let accepted = 0;
    await runSource("git", [...safeGitArgs, "-C", repository, "cat-file", "--batch"], {
      ...options,
      input: `${objectList.join("\n")}\n`,
      onChunk: async (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        while (true) {
          if (!current) {
            const newline = pending.indexOf(10);
            if (newline < 0) {
              if (pending.length > 1024) throw new Error("Malformed Git object header");
              break;
            }
            const match = /^([a-f0-9]+) (blob|tree|commit) (\d+)$/.exec(
              pending.subarray(0, newline).toString(),
            );
            if (!match || match[1] !== objectList[accepted])
              throw new Error("Malformed Git object inventory response");
            const size = Number(match[3]);
            if (
              !Number.isSafeInteger(size) ||
              size < 0 ||
              received + size > limits.maxDownloadBytes
            )
              throw new Error("Git download exceeds maxDownloadBytes");
            received += size;
            current = { id: match[1], type: match[2], size };
            pending = pending.subarray(newline + 1);
          }
          if (pending.length < current.size + 1) break;
          if (pending[current.size] !== 10) throw new Error("Malformed Git object boundary");
          const body = pending.subarray(0, current.size);
          const canonical = Buffer.concat([Buffer.from(`${current.type} ${current.size}\0`), body]);
          const objectId = createHash(source.commit.length === 64 ? "sha256" : "sha1")
            .update(canonical)
            .digest("hex");
          if (objectId !== current.id) throw new Error("Git object digest mismatch");
          const compressed = deflateSync(canonical);
          compressedBytes += compressed.length;
          if (compressedBytes + extracted > limits.maxExtractedBytes)
            throw new Error("Git materialization exceeds maxExtractedBytes");
          const objectPath = join(destination, ".git", "objects", current.id.slice(0, 2));
          await writer.file(join(objectPath, current.id.slice(2)), compressed, 0o444);
          for (const entry of byObject.get(current.id) ?? []) {
            extracted += body.length;
            if (compressedBytes + extracted > limits.maxExtractedBytes)
              throw new Error("Git materialization exceeds maxExtractedBytes");
            const path = containedPath(destination, entry.path);
            if (entry.mode === "120000") {
              const target = body.toString("utf8");
              if (!Buffer.from(target, "utf8").equals(body))
                throw new Error("Git contains a non-UTF-8 symlink target");
              const resolved = resolve(path, "..", target);
              if (
                target.includes("\0") ||
                isAbsolute(target) ||
                (resolved !== destination && !resolved.startsWith(`${destination}${sep}`))
              )
                throw new Error("Git symlink escapes source containment");
              await writer.link(path, target);
            } else await writer.file(path, body, entry.mode === "100755" ? 0o755 : 0o644);
          }
          pending = pending.subarray(current.size + 1);
          current = undefined;
          accepted++;
        }
      },
    });
    if (pending.length || current || accepted !== objectList.length)
      throw new Error("Incomplete Git object stream");
    await writeDetachedGit(destination, source.commit, writer);
    // Build Git's index through a bounded parent-controlled serialization, never git checkout/read-tree.
    await writeGitIndex(destination, entries, source.commit.length === 64 ? 32 : 20, writer);
    await validateGitTree(destination, limits);
    return received;
  });
}

async function writeGitIndex(
  root: string,
  entries: TreeFile[],
  hashBytes: number,
  writer: PhysicalWriter,
): Promise<void> {
  const sorted = [...entries].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
  );
  const header = Buffer.alloc(12);
  header.write("DIRC");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  const records: Buffer[] = [header];
  for (const entry of sorted) {
    const path = containedPath(root, entry.path);
    const stat = await lstat(path);
    const name = Buffer.from(entry.path);
    const record = Buffer.alloc(40 + hashBytes + 2 + name.length + 1);
    const mtime = stat.mtimeMs / 1000;
    const ctime = stat.ctimeMs / 1000;
    record.writeUInt32BE(Math.floor(ctime) >>> 0, 0);
    record.writeUInt32BE(Math.floor((ctime % 1) * 1e9) >>> 0, 4);
    record.writeUInt32BE(Math.floor(mtime) >>> 0, 8);
    record.writeUInt32BE(Math.floor((mtime % 1) * 1e9) >>> 0, 12);
    record.writeUInt32BE(stat.dev >>> 0, 16);
    record.writeUInt32BE(stat.ino >>> 0, 20);
    record.writeUInt32BE(Number.parseInt(entry.mode, 8), 24);
    record.writeUInt32BE(stat.uid >>> 0, 28);
    record.writeUInt32BE(stat.gid >>> 0, 32);
    record.writeUInt32BE(stat.size >>> 0, 36);
    Buffer.from(entry.object, "hex").copy(record, 40);
    record.writeUInt16BE(Math.min(name.length, 0xfff), 40 + hashBytes);
    name.copy(record, 42 + hashBytes);
    records.push(record, Buffer.alloc((8 - (record.length % 8)) % 8));
  }
  const content = Buffer.concat(records);
  records.push(
    createHash(hashBytes === 32 ? "sha256" : "sha1")
      .update(content)
      .digest(),
  );
  await writer.file(join(root, ".git", "index"), Buffer.concat(records));
}

export async function validateGitTree(root: string, limits: SourceLimits): Promise<void> {
  let bytes = 0;
  async function walk(path: string): Promise<void> {
    for (const name of await readdir(path)) {
      const child = join(path, name);
      const stat = await lstat(child);
      if (stat.isSymbolicLink()) {
        const targetBytes = await readlink(child, { encoding: "buffer" });
        const target = targetBytes.toString("utf8");
        if (!Buffer.from(target, "utf8").equals(targetBytes))
          throw new Error("Git contains a non-UTF-8 symlink target");
        const resolved = resolve(path, target);
        if (isAbsolute(target) || (resolved !== root && !resolved.startsWith(`${root}${sep}`)))
          throw new Error("Git symlink escapes source containment");
        try {
          const actual = await realpath(child);
          if (actual !== root && !actual.startsWith(`${root}${sep}`))
            throw new Error("Git symlink escapes realpath containment");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        bytes += Buffer.byteLength(target);
      } else if (stat.isDirectory()) await walk(child);
      else if (stat.isFile()) bytes += stat.size;
      else throw new Error("Git materialization contains a special file");
      if (bytes > limits.maxExtractedBytes)
        throw new Error("Git materialization exceeds maxExtractedBytes");
    }
  }
  await walk(root);
}

async function materializeBoundedGit(
  source: ResolvedGit,
  destination: string,
  staging: string,
  limits: SourceLimits,
  channels: RuntimeChannels,
  writer: PhysicalWriter,
  signal?: AbortSignal,
): Promise<number> {
  const local = !gitUsesRemoteAcquisition(source.repository);
  const repository = local ? fileURLToPath(source.repository) : undefined;
  const gitDirectory = repository ? join(repository, ".git") : undefined;
  const gitDirectoryStat = gitDirectory
    ? await lstat(gitDirectory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      })
    : undefined;
  const objectsStat = gitDirectoryStat?.isDirectory()
    ? await lstat(join(gitDirectory!, "objects")).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      })
    : undefined;
  const localShared =
    !!gitDirectoryStat?.isDirectory() &&
    !gitDirectoryStat.isSymbolicLink() &&
    !!objectsStat?.isDirectory() &&
    !objectsStat.isSymbolicLink() &&
    !(await lstat(join(gitDirectory!, "objects", "info", "alternates")).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    ));
  const bounded = join(staging, `bounded-git-${randomUUID()}`);
  const recoveryPath = join(staging, ".allagents-acquisition.json");
  const record = {
    schemaVersion: 1,
    package: PACKAGE,
    kind: "bounded-git-acquisition",
    identity: await processIdentity(),
    path: bounded,
    state: "pending",
  };
  await atomicJson(recoveryPath, record);
  await mkdir(bounded, { mode: 0o700 });
  let acquisitionError: unknown;
  try {
    // A kernel-enforced aggregate physical bound exists before any writing Git child launches.
    await helperInvoke("acquire-tmpfs", [
      bounded,
      String(limits.maxDownloadBytes + limits.maxExtractedBytes),
    ]);
    await atomicJson(recoveryPath, { ...record, state: "active" });
    return await withPrivateAcquisition(channels, async (root, env) => {
      const gitEnv = local ? env : await gitCredentials(root, env, channels);
      const options = {
        env: gitEnv,
        channels,
        signal,
        privatePaths: [root, bounded, ...(repository ? [repository] : [])],
      };
      const checkout = join(bounded, "repository");
      await measuredGitPhase("git-clone", () =>
        runSource(
          "git",
          [
            ...safeGitArgs,
            "clone",
            "--no-checkout",
            ...(localShared
              ? ["--shared"]
              : ["--no-local", "--no-hardlinks", ...(local ? [] : ["--depth=1"])]),
            "--",
            localShared ? repository! : source.repository,
            checkout,
          ],
          options,
        ),
      );
      if (local) {
        try {
          await runSource(
            "git",
            [...safeGitArgs, "-C", checkout, "cat-file", "-e", `${source.commit}^{commit}`],
            options,
          );
        } catch {
          await runSource(
            "git",
            [...safeGitArgs, "-C", checkout, "fetch", "--no-tags", "origin", source.commit],
            options,
          );
        }
      } else {
        await runSource(
          "git",
          [
            ...safeGitArgs,
            "-C",
            checkout,
            "fetch",
            "--depth=1",
            "--no-tags",
            "origin",
            source.commit,
          ],
          options,
        );
      }
      let downloaded = 0;
      const count = async (path: string): Promise<void> => {
        for (const name of await readdir(path)) {
          const file = join(path, name);
          const stat = await lstat(file);
          if (stat.isDirectory()) await count(file);
          else downloaded += stat.size;
        }
      };
      if (!localShared) {
        await count(join(checkout, ".git"));
        if (downloaded > limits.maxDownloadBytes)
          throw new Error("Git download exceeds maxDownloadBytes");
      }
      const listing = await runSource(
        "git",
        [...safeGitArgs, "-C", checkout, "ls-tree", "-rz", "--full-tree", source.commit],
        { ...options, limit: limits.maxDownloadBytes },
      );
      parseTreeListing(listing, checkout);
      await measuredGitPhase("git-checkout", () =>
        runSource(
          "git",
          [
            ...safeGitArgs,
            "-c",
            "checkout.workers=8",
            "-c",
            "checkout.thresholdForParallelism=100",
            "-C",
            checkout,
            "checkout",
            "--detach",
            "--force",
            source.commit,
          ],
          options,
        ),
      );
      await measuredGitPhase("git-validate-tree", () => validateGitTree(checkout, limits));
      if (localShared) {
        const git = join(checkout, ".git");
        // Keep only the pinned commit reachable while Git repacks objects from
        // the source's read-only alternate into the bounded temporary clone.
        for (const name of ["refs", "packed-refs", "logs"])
          await rm(join(git, name), { recursive: true, force: true });
        await mkdir(join(git, "refs"));
        await writeFile(join(git, "shallow"), `${source.commit}\n`);
        await measuredGitPhase("git-repack", () =>
          runSource(
            "git",
            [
              ...safeGitArgs,
              "-C",
              checkout,
              "repack",
              "-a",
              "-d",
              "--window=0",
              "--depth=0",
              "--no-local",
              "-q",
            ],
            options,
          ),
        );
        await rm(join(git, "objects", "info", "alternates"), { force: true });
        await measuredGitPhase("git-fsck", () =>
          runSource(
            "git",
            [...safeGitArgs, "-C", checkout, "fsck", "--connectivity-only", "--no-reflogs"],
            options,
          ),
        );
        downloaded = 0;
        await count(git);
        if (downloaded > limits.maxDownloadBytes)
          throw new Error("Git download exceeds maxDownloadBytes");
      }
      for (const name of [
        "config",
        "FETCH_HEAD",
        "ORIG_HEAD",
        "packed-refs",
        "logs",
        "refs",
        "hooks",
      ])
        await rm(join(checkout, ".git", name), { recursive: true, force: true });
      await writeDetachedGit(checkout, source.commit);
      // External Git is now quiescent; only bounded, already verified parent copying remains.
      await measuredGitPhase("git-seed-copy", () =>
        copyVerifiedTree(checkout, destination, writer),
      );
      return downloaded;
    });
  } catch (error) {
    acquisitionError = error;
    throw error;
  } finally {
    // A helper may mount successfully and fail before its parent receives completion.
    // The already-published record owns that mount, even while still pending.
    await detachAcquisition(bounded, recoveryPath, acquisitionError);
  }
}

async function detachAcquisition(
  path: string,
  recordPath: string,
  acquisitionError: unknown,
): Promise<void> {
  try {
    if (await isMounted(path)) await helperInvoke("release-tmpfs", [path]);
    if (await isMounted(path))
      throw new Error("Bounded Git staging remains mounted; acquisition recovery record retained");
    await rm(path, { recursive: true, force: true });
    await rm(recordPath, { force: true });
  } catch (error) {
    if (acquisitionError)
      throw new AggregateError(
        [acquisitionError, error],
        "Source acquisition and staging detach failed; recovery record retained",
      );
    throw error;
  }
}

async function copyVerifiedTree(
  source: string,
  destination: string,
  writer: PhysicalWriter,
): Promise<void> {
  const files: {
    input: string;
    output: string;
    target?: string;
    atime?: Date;
    mtime?: Date;
  }[] = [];
  async function plan(inputDirectory: string, outputDirectory: string): Promise<void> {
    await writer.directory(outputDirectory);
    for (const name of await readdir(inputDirectory)) {
      const input = join(inputDirectory, name);
      const output = join(outputDirectory, name);
      const stat = await lstat(input);
      if (stat.isDirectory()) await plan(input, output);
      else if (stat.isSymbolicLink()) {
        const target = await readlink(input);
        writer.reserveFile(output, Buffer.byteLength(target));
        files.push({ input, output, target });
      } else {
        writer.reserveFile(output, stat.size);
        files.push({ input, output, atime: stat.atime, mtime: stat.mtime });
      }
    }
  }
  await measuredGitPhase("git-seed-copy-plan", () => plan(source, destination));
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  await measuredGitPhase("git-seed-copy-files", () =>
    Promise.all(
      Array.from({ length: Math.min(32, files.length) }, async () => {
        while (!failed && cursor < files.length) {
          const file = files[cursor++];
          try {
            if (file.target === undefined) {
              await copyFile(file.input, file.output, constants.COPYFILE_EXCL);
              await utimes(file.output, file.atime!, file.mtime!);
            } else await writer.link(file.output, file.target);
          } catch (error) {
            failed = true;
            failure = error;
          }
        }
      }),
    ),
  );
  if (failed) throw failure;
}

export async function materializeGit(
  source: ResolvedGit,
  staging: string,
  limits: SourceLimits,
  channels: RuntimeChannels,
  writer: PhysicalWriter,
  signal?: AbortSignal,
): Promise<number> {
  const destination = resolve(staging, source.destination);
  if (!gitUsesRemoteAcquisition(source.repository)) {
    const stage = dirname(staging);
    const cache = dirname(dirname(stage));
    const packageStage =
      basename(staging) === "tree" &&
      basename(dirname(stage)) === "staging" &&
      /^[a-f0-9-]{36}$/.test(basename(stage));
    const marker = packageStage
      ? await json<{ package: string; kind: string }>(join(cache, MARKER)).catch(() => undefined)
      : undefined;
    if (marker?.package !== PACKAGE || marker.kind !== "cache" || !(await helperAvailable()))
      return materializeLocal(source, destination, limits, channels, writer, signal);
  }
  return materializeBoundedGit(source, destination, staging, limits, channels, writer, signal);
}
