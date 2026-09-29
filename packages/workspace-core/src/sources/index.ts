import { lstat, readdir, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { controlledAcquisitionPhysicalReservation } from "../acquisition-budget.ts";
import { canonicalJson, DEFAULT_LIMITS, validateWorkspace } from "../config.ts";
import type { ResolvedSource, RuntimeChannels, SourceLimits, WorkspaceSpec } from "../types.ts";
import { materializeGit, resolveGit } from "./git.ts";
import { materializeOci, resolveOci } from "./oci.ts";
import { PhysicalWriter } from "./process.ts";

interface ResolutionFlight {
  promise: Promise<ResolvedSource[]>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}
const flights = new Map<string, ResolutionFlight>();

/** Equivalent credential-free source requests share their immutable resolution within a process. */
export async function resolveSources(
  spec: WorkspaceSpec,
  channels: RuntimeChannels,
  signal?: AbortSignal,
): Promise<ResolvedSource[]> {
  signal?.throwIfAborted();
  const normalized = validateWorkspace(spec);
  const limits = { ...DEFAULT_LIMITS, ...normalized.limits };
  const sources = [...normalized.sources].sort((a, b) =>
    a.destination.localeCompare(b.destination, "en"),
  );
  const requests = sources.map(({ permissions: _permissions, ...request }) => request);
  const key = canonicalJson(requests);
  let flight = flights.get(key);
  if (!flight) {
    const controller = new AbortController();
    const acquired: ResolutionFlight = {
      controller,
      waiters: 0,
      settled: false,
      promise: Promise.resolve([]),
    };
    const timeout = AbortSignal.timeout(limits.timeoutMs);
    const acquisitionSignal = AbortSignal.any([controller.signal, timeout]);
    acquired.promise = (async () => {
      const resolved: ResolvedSource[] = [];
      for (const request of sources)
        resolved.push(
          request.type === "git"
            ? await resolveGit(request, channels, acquisitionSignal)
            : await resolveOci(request, channels, acquisitionSignal),
        );
      return resolved;
    })().then(
      (value) => {
        acquired.settled = true;
        return value;
      },
      (error) => {
        acquired.settled = true;
        if (flights.get(key) === acquired) flights.delete(key);
        throw error;
      },
    );
    flight = acquired;
    flights.set(key, acquired);
  }
  flight.waiters++;
  const active = flight;
  return new Promise<ResolvedSource[]>((resolvePromise, reject) => {
    let done = false;
    const finish = () => {
      if (done) return false;
      done = true;
      signal?.removeEventListener("abort", abort);
      active.waiters--;
      if (!active.waiters && !active.settled) {
        active.controller.abort();
        if (flights.get(key) === active) flights.delete(key);
      }
      return true;
    };
    const abort = () => {
      if (finish()) reject(signal?.reason ?? new Error("Source resolution cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    active.promise.then(
      (resolved) => {
        if (finish())
          resolvePromise(
            resolved.map((source) => ({
              ...source,
              permissions:
                sources.find((request) => request.destination === source.destination)
                  ?.permissions ?? "all",
            })),
          );
      },
      (error) => {
        if (finish()) reject(error);
      },
    );
    if (signal?.aborted) abort();
  });
}

async function logicalBytes(root: string): Promise<number> {
  let total = 0;
  for (const name of await readdir(root)) {
    const path = join(root, name);
    const stat = await lstat(path);
    if (stat.isDirectory()) total += await logicalBytes(path);
    else if (stat.isSymbolicLink()) total += Buffer.byteLength(await readlink(path));
    else if (stat.isFile()) total += stat.size;
    else throw new Error("Unsupported special file in source staging");
  }
  return total;
}

export async function materializeSources(
  resolved: ResolvedSource[],
  staging: string,
  limits: SourceLimits,
  channels: RuntimeChannels,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (resolved.length > limits.maxSources) throw new Error("Too many resolved sources");
  staging = resolve(staging);
  const writer = await PhysicalWriter.create(
    staging,
    controlledAcquisitionPhysicalReservation(limits),
  );
  const acquisitionSignal = AbortSignal.any([
    AbortSignal.timeout(limits.timeoutMs),
    ...(signal ? [signal] : []),
  ]);
  let downloaded = 0;
  let extracted = 0;
  for (const source of resolved) {
    acquisitionSignal.throwIfAborted();
    const remaining = {
      ...limits,
      maxDownloadBytes: limits.maxDownloadBytes - downloaded,
      maxExtractedBytes: limits.maxExtractedBytes - extracted,
    };
    if (remaining.maxDownloadBytes <= 0 || remaining.maxExtractedBytes <= 0)
      throw new Error("Aggregate source acquisition limit exhausted");
    downloaded +=
      source.type === "git"
        ? await materializeGit(source, staging, remaining, channels, writer, acquisitionSignal)
        : await materializeOci(source, staging, remaining, channels, writer, acquisitionSignal);
    extracted = await logicalBytes(staging);
    if (downloaded > limits.maxDownloadBytes || extracted > limits.maxExtractedBytes)
      throw new Error("Aggregate source acquisition exceeds configured limits");
  }
}

export { preflightManifest } from "./oci.ts";
