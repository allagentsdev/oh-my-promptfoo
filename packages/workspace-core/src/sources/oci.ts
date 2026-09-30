import { createHash } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { OciSource, ResolvedSource, RuntimeChannels, SourceLimits } from "../types.ts";
import {
  digest,
  orasEnvironment,
  type PhysicalWriter,
  runSource,
  withPrivateAcquisition,
} from "./process.ts";

type ResolvedOci = Extract<ResolvedSource, { type: "oci" }>;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const manifestTypes = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.oci.artifact.manifest.v1+json",
]);
const fileTypes = new Set([
  "application/octet-stream",
  "text/plain",
  "application/json",
  "application/vnd.allagents.workspace.file.v1",
]);
interface Descriptor {
  mediaType: string;
  digest: `sha256:${string}`;
  size: number;
  annotations?: Record<string, unknown>;
}
interface FileDescriptor extends Descriptor {
  title: string;
}

function executable(channels: RuntimeChannels): string {
  const path = channels.ALLAGENTS_ORAS_PATH;
  if (!path || !isAbsolute(path))
    throw new Error(
      "OCI acquisition requires an absolute ALLAGENTS_ORAS_PATH pointing to ORAS 1.x",
    );
  return path;
}

async function validateVersion(
  command: string,
  env: NodeJS.ProcessEnv,
  channels: RuntimeChannels,
  signal?: AbortSignal,
): Promise<void> {
  const output = await runSource(command, ["version"], { env, channels, signal, limit: 16 * 1024 });
  if (!/Version:\s*1\.\d+\.\d+/.test(output.toString()))
    throw new Error("OCI acquisition requires ORAS 1.x");
}

export async function resolveOci(
  source: OciSource,
  channels: RuntimeChannels,
  signal?: AbortSignal,
): Promise<ResolvedOci> {
  if ("digest" in source && source.digest)
    return { ...source, digest: source.digest, materializerVersion: 1 };
  return withPrivateAcquisition(channels, async (root, env) => {
    const command = executable(channels);
    await validateVersion(command, env, channels, signal);
    const auth = await orasEnvironment(root, env, channels);
    const bytes = await runSource(
      command,
      ["manifest", "fetch", "--descriptor", ...auth.args, `${source.repository}:${source.tag}`],
      { env: auth.env, channels, signal, privatePaths: [root, ...auth.redactions] },
    );
    const descriptor = JSON.parse(bytes.toString()) as unknown;
    if (
      !descriptor ||
      typeof descriptor !== "object" ||
      !("digest" in descriptor) ||
      typeof descriptor.digest !== "string" ||
      !digestPattern.test(descriptor.digest)
    )
      throw new Error("ORAS did not resolve an immutable manifest digest");
    return { ...source, digest: descriptor.digest as `sha256:${string}`, materializerVersion: 1 };
  });
}

function descriptor(value: unknown): Descriptor {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed OCI descriptor");
  const record = value as Record<string, unknown>;
  if (
    typeof record.mediaType !== "string" ||
    typeof record.digest !== "string" ||
    !digestPattern.test(record.digest) ||
    !Number.isSafeInteger(record.size) ||
    (record.size as number) < 0
  )
    throw new Error("Malformed OCI descriptor");
  if ("urls" in record || "data" in record || "platform" in record)
    throw new Error("Unsupported OCI descriptor layout");
  if (
    record.annotations !== undefined &&
    (!record.annotations ||
      typeof record.annotations !== "object" ||
      Array.isArray(record.annotations))
  )
    throw new Error("Malformed OCI annotations");
  return record as unknown as Descriptor;
}

function titlePath(root: string, title: unknown): string {
  if (
    typeof title !== "string" ||
    !title ||
    title.length > 4096 ||
    title.includes("\\") ||
    title.includes("\0") ||
    isAbsolute(title) ||
    /^[A-Za-z]:/.test(title) ||
    title.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("OCI file title escapes containment");
  const path = resolve(root, title);
  if (!path.startsWith(`${root}${sep}`)) throw new Error("OCI file title escapes containment");
  return path;
}

export function preflightManifest(
  bytes: Buffer,
  expectedDigest: string,
  root: string,
  limits: SourceLimits,
): FileDescriptor[] {
  if (digest(bytes) !== expectedDigest) throw new Error("OCI manifest digest mismatch");
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Malformed OCI manifest JSON");
  }
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    typeof manifest.mediaType !== "string" ||
    !manifestTypes.has(manifest.mediaType)
  )
    throw new Error("Unsupported OCI manifest media type");
  if (manifest.subject !== undefined) throw new Error("OCI referrer layouts are not supported");
  let files: unknown[];
  if (manifest.mediaType === "application/vnd.oci.image.manifest.v1+json") {
    if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.layers))
      throw new Error("Unsupported OCI manifest layout");
    const config = descriptor(manifest.config);
    if (
      !["application/vnd.oci.empty.v1+json", "application/vnd.unknown.config.v1+json"].includes(
        config.mediaType,
      ) ||
      config.size !== 2 ||
      config.digest !== digest(Buffer.from("{}"))
    )
      throw new Error("Only the canonical empty OCI artifact configuration is supported");
    files = manifest.layers;
  } else {
    if (!Array.isArray(manifest.blobs)) throw new Error("Unsupported OCI artifact manifest layout");
    files = manifest.blobs;
  }
  const result: FileDescriptor[] = [];
  const titles = new Set<string>();
  let downloaded = bytes.length;
  let extracted = 0;
  for (const file of files) {
    const item = descriptor(file);
    if (!fileTypes.has(item.mediaType))
      throw new Error(
        "OCI archives, compressed layers, and special-file layouts are not supported",
      );
    const title = item.annotations?.["org.opencontainers.image.title"];
    titlePath(root, title);
    const normalized = (title as string).normalize("NFC");
    if (normalized !== title || titles.has(normalized))
      throw new Error("Duplicate or nonnormalized OCI file title");
    titles.add(normalized);
    downloaded += item.size;
    extracted += item.size;
    if (
      !Number.isSafeInteger(downloaded) ||
      downloaded > limits.maxDownloadBytes ||
      extracted > limits.maxExtractedBytes
    )
      throw new Error("Declared OCI artifact bytes exceed source limits before blob download");
    result.push({ ...item, title: normalized });
  }
  const sorted = [...titles].sort();
  for (let i = 1; i < sorted.length; i++)
    if (sorted[i].startsWith(`${sorted[i - 1]}/`)) throw new Error("Overlapping OCI file titles");
  return result.sort((a, b) => a.title.localeCompare(b.title));
}

/** Manifest preflight precedes every blob; writes are streamed, counted, and verified. */
export async function materializeOci(
  source: ResolvedOci,
  staging: string,
  limits: SourceLimits,
  channels: RuntimeChannels,
  writer: PhysicalWriter,
  signal?: AbortSignal,
): Promise<number> {
  return withPrivateAcquisition(channels, async (root, env) => {
    const command = executable(channels);
    await validateVersion(command, env, channels, signal);
    const auth = await orasEnvironment(root, env, channels);
    const options = { env: auth.env, channels, signal, privatePaths: [root, ...auth.redactions] };
    const destination = resolve(staging, source.destination);
    const manifest = await runSource(
      command,
      ["manifest", "fetch", ...auth.args, `${source.repository}@${source.digest}`],
      { ...options, limit: Math.min(limits.maxDownloadBytes, 4 * 1024 * 1024) },
    );
    const files = preflightManifest(manifest, source.digest, destination, limits);
    let received = manifest.length;
    await writer.directory(destination);
    for (const descriptor of files) {
      signal?.throwIfAborted();
      const path = titlePath(destination, descriptor.title);
      await writer.directory(resolve(path, ".."));
      writer.reserveFile(path, descriptor.size);
      const file = await open(path, "wx", 0o644);
      const hash = createHash("sha256");
      let size = 0;
      let accepted = false;
      try {
        await runSource(
          command,
          [
            "blob",
            "fetch",
            "--output",
            "-",
            ...auth.args,
            `${source.repository}@${descriptor.digest}`,
          ],
          {
            ...options,
            onChunk: async (chunk) => {
              size += chunk.length;
              received += chunk.length;
              if (size > descriptor.size || received > limits.maxDownloadBytes)
                throw new Error("OCI blob stream exceeds declared or aggregate byte limit");
              hash.update(chunk);
              let offset = 0;
              while (offset < chunk.length) {
                const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
                if (!bytesWritten) throw new Error("OCI staging writer made no progress");
                offset += bytesWritten;
              }
            },
          },
        );
        if (size !== descriptor.size || `sha256:${hash.digest("hex")}` !== descriptor.digest)
          throw new Error("OCI blob size or digest mismatch");
        accepted = true;
      } finally {
        await file.close();
        if (!accepted) await rm(path, { force: true });
      }
    }
    return received;
  });
}
