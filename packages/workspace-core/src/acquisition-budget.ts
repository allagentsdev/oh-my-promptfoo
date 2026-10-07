import type { SourceLimits, WorkspaceSource } from "./types.js";

const CONTROLLED_WRITE_HEADROOM = 16 * 1024 ** 2;
type AcquisitionLimits = Pick<SourceLimits, "maxDownloadBytes" | "maxExtractedBytes">;

/** Distinguish authenticated HTTPS acquisition from a local file repository. */
export function gitUsesRemoteAcquisition(repository: string): boolean {
  const protocol = new URL(repository).protocol;
  if (protocol === "https:") return true;
  if (protocol === "file:") return false;
  throw new Error("Unsupported Git acquisition protocol");
}

function sourceByteBudget(limits: AcquisitionLimits): number {
  const total = limits.maxDownloadBytes + limits.maxExtractedBytes;
  if (
    !Number.isSafeInteger(limits.maxDownloadBytes) ||
    !Number.isSafeInteger(limits.maxExtractedBytes) ||
    limits.maxDownloadBytes <= 0 ||
    limits.maxExtractedBytes <= 0 ||
    !Number.isSafeInteger(total * 2 + CONTROLLED_WRITE_HEADROOM)
  )
    throw new Error("Invalid physical source acquisition limits");
  return total;
}

/** Bounds all parent-controlled source writes, including block and inode overhead. */
export function controlledAcquisitionPhysicalReservation(limits: AcquisitionLimits): number {
  return sourceByteBudget(limits) + CONTROLLED_WRITE_HEADROOM;
}

/** Source acquisition is serial, so at most one bounded Git tmpfs is live.
 * Local Git uses the tmpfs path when the reviewed helper is available; the
 * controlled fallback conservatively keeps the same reservation. */
export function acquisitionPhysicalReservation(
  sources: readonly Pick<WorkspaceSource, "type">[],
  limits: AcquisitionLimits,
): number {
  const temporary = sources.some((source) => source.type === "git");
  return (
    controlledAcquisitionPhysicalReservation(limits) + (temporary ? sourceByteBudget(limits) : 0)
  );
}
