import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { chmod, lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { canonicalJson } from "../config.js";
import { assertNoSymlinkAncestors } from "../fs.js";
import type { LocalSource, ResolvedLocalSource, RuntimeChannels, SourceLimits } from "../types.js";
import type { PhysicalWriter } from "./process.js";

type Entry = { path: string; mode: number; size?: number; digest?: string };
const snapshots = new WeakMap<ResolvedLocalSource, Entry[]>();
const ordered = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function sourceRoot(source: LocalSource, channels: RuntimeChannels): string {
  if (process.platform !== "linux")
    throw new Error("Local source acquisition requires Linux descriptor-anchored traversal");
  const configured = channels.ALLAGENTS_LOCAL_SOURCE_ROOT;
  if (!configured || !isAbsolute(configured))
    throw new Error("Local sources require an absolute ALLAGENTS_LOCAL_SOURCE_ROOT");
  const trusted = resolve(configured);
  const path = resolve(source.path);
  const rel = relative(trusted, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith(sep))
    throw new Error("Local source must stay inside trusted source root");
  if (path.split(sep).includes(".git")) throw new Error("Local source cannot select Git metadata");
  return path;
}

async function rootHandle(path: string, channels: RuntimeChannels): Promise<FileHandle> {
  await assertNoSymlinkAncestors(resolve(channels.ALLAGENTS_LOCAL_SOURCE_ROOT!));
  await assertNoSymlinkAncestors(path);
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    if (!(await handle.stat()).isDirectory()) throw new Error("Local source must be a directory");
    // A directory descriptor anchors traversal even if the host renames the input later.
    const actual = await realpath(`/proc/self/fd/${handle.fd}`);
    if (actual !== path)
      throw new Error("Local source path contains a symlink or changed during acquisition");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readFileHash(
  file: FileHandle,
  signal: AbortSignal,
  maximum: number,
): Promise<{ digest: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of file.createReadStream({ autoClose: false, signal })) {
    size += chunk.length;
    if (size > maximum) throw new Error("Local source exceeds configured byte limit");
    hash.update(chunk);
  }
  signal.throwIfAborted();
  return { digest: hash.digest("hex"), size };
}

async function walk(
  root: string,
  channels: RuntimeChannels,
  limits: SourceLimits,
  signal: AbortSignal,
  copy?: { destination: string; writer: PhysicalWriter; expected: Map<string, Entry> },
): Promise<Entry[]> {
  const entries: Entry[] = [];
  let bytes = 0;
  const maximum = Math.min(limits.maxDownloadBytes, limits.maxExtractedBytes);
  const top = await rootHandle(root, channels);
  const visit = async (directory: FileHandle, rel: string): Promise<void> => {
    const initial = await directory.stat();
    signal.throwIfAborted();
    // readdir on the anchored descriptor's proc path never follows a replaced directory entry.
    const children = await readdir(`/proc/self/fd/${directory.fd}`);
    const visible = children.filter((name) => name !== ".git").sort(ordered);
    for (const name of visible) {
      signal.throwIfAborted();
      const path = rel ? `${rel}/${name}` : name;
      const input = `/proc/self/fd/${directory.fd}/${name}`;
      const initial = await lstat(input);
      if (initial.isSymbolicLink() || (!initial.isDirectory() && !initial.isFile()))
        throw new Error(`Local source contains symlink or special file: ${path}`);
      if (initial.isFile() && initial.nlink !== 1)
        throw new Error(`Local source contains hard-linked file: ${path}`);
      const mode = initial.mode & 0o777;
      const expected = copy?.expected.get(path);
      if (
        copy &&
        (!expected ||
          expected.mode !== mode ||
          expected.size !== (initial.isFile() ? initial.size : undefined))
      )
        throw new Error("Local source changed before materialization");
      if (initial.isDirectory()) {
        const child = await open(
          input,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          const stat = await child.stat();
          if (!stat.isDirectory() || stat.dev !== initial.dev || stat.ino !== initial.ino)
            throw new Error("Local source directory changed during acquisition");
          entries.push({ path, mode });
          if (copy) await copy.writer.directory(join(copy.destination, path));
          await visit(child, path);
          const after = await child.stat();
          if (
            (after.mode & 0o777) !== mode ||
            after.mtimeMs !== stat.mtimeMs ||
            after.ctimeMs !== stat.ctimeMs
          )
            throw new Error("Local source directory changed during acquisition");
          if (copy) await chmod(join(copy.destination, path), mode);
        } finally {
          await child.close();
        }
      } else {
        if (initial.size > maximum - bytes)
          throw new Error("Local source exceeds configured byte limit");
        const file = await open(input, READ_FLAGS);
        try {
          const stat = await file.stat();
          if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.dev !== initial.dev ||
            stat.ino !== initial.ino ||
            stat.size !== initial.size ||
            (stat.mode & 0o777) !== mode
          )
            throw new Error("Local source file changed during acquisition");
          let result: { digest: string; size: number };
          if (copy) {
            const target = join(copy.destination, path);
            await copy.writer.directory(join(copy.destination, rel));
            copy.writer.reserveFile(target, stat.size);
            const hash = createHash("sha256");
            let size = 0;
            await pipeline(
              file.createReadStream({ autoClose: false, signal }),
              new Transform({
                transform(chunk: Buffer, _encoding, done) {
                  size += chunk.length;
                  if (size > stat.size) return done(new Error("Local source changed during copy"));
                  hash.update(chunk);
                  done(null, chunk);
                },
              }),
              createWriteStream(target, { flags: "wx", mode }),
              { signal },
            );
            await chmod(target, mode);
            result = { digest: hash.digest("hex"), size };
          } else result = await readFileHash(file, signal, maximum - bytes);
          const after = await file.stat();
          if (
            result.size !== stat.size ||
            after.nlink !== 1 ||
            after.size !== stat.size ||
            (after.mode & 0o777) !== mode ||
            after.mtimeMs !== stat.mtimeMs ||
            after.ctimeMs !== stat.ctimeMs
          )
            throw new Error("Local source file changed during acquisition");
          if (expected && (expected.digest !== result.digest || expected.size !== result.size))
            throw new Error("Local source changed during copy; seed not published");
          bytes += result.size;
          if (bytes > maximum) throw new Error("Local source exceeds configured byte limit");
          entries.push({ path, mode, size: result.size, digest: result.digest });
        } finally {
          await file.close();
        }
      }
      if (entries.length > 1_000_000) throw new Error("Local source exceeds inventory entry limit");
    }
    signal.throwIfAborted();
    const again = await readdir(`/proc/self/fd/${directory.fd}`);
    if (
      canonicalJson(again.filter((name) => name !== ".git").sort(ordered)) !==
      canonicalJson(visible)
    )
      throw new Error("Local source directory changed during acquisition");
    const after = await directory.stat();
    if (
      (after.mode & 0o777) !== (initial.mode & 0o777) ||
      after.mtimeMs !== initial.mtimeMs ||
      after.ctimeMs !== initial.ctimeMs
    )
      throw new Error("Local source directory changed during acquisition");
  };
  try {
    if (copy) await copy.writer.directory(copy.destination);
    await visit(top, "");
  } finally {
    await top.close();
  }
  return entries.sort((a, b) => ordered(a.path, b.path));
}

export async function resolveLocal(
  source: LocalSource,
  channels: RuntimeChannels,
  limits: SourceLimits,
  signal: AbortSignal,
): Promise<ResolvedLocalSource> {
  signal.throwIfAborted();
  const path = sourceRoot(source, channels);
  const entries = await walk(path, channels, limits, signal);
  const digest = `sha256:${createHash("sha256")
    .update(canonicalJson({ schemaVersion: 1, entries }))
    .digest("hex")}` as const;
  const resolved: ResolvedLocalSource = { ...source, path, digest };
  snapshots.set(resolved, entries);
  return resolved;
}

export async function materializeLocal(
  source: ResolvedLocalSource,
  staging: string,
  limits: SourceLimits,
  channels: RuntimeChannels,
  writer: PhysicalWriter,
  signal: AbortSignal,
): Promise<number> {
  const expected = snapshots.get(source);
  if (!expected) throw new Error("Local source snapshot is not available to this provider");
  if (sourceRoot(source, channels) !== source.path)
    throw new Error("Local source root changed during acquisition");
  const entries = await walk(source.path, channels, limits, signal, {
    destination: join(staging, source.destination),
    writer,
    expected: new Map(expected.map((entry) => [entry.path, entry])),
  });
  if (canonicalJson(entries) !== canonicalJson(expected))
    throw new Error("Local source changed during copy; seed not published");
  return entries.reduce((size, entry) => size + (entry.size ?? 0), 0);
}
