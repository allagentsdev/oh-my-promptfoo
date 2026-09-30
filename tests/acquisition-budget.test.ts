import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquisitionPhysicalReservation,
  controlledAcquisitionPhysicalReservation,
  gitUsesRemoteAcquisition,
} from "../packages/workspace-core/src/acquisition-budget.ts";
import { PhysicalWriter } from "../packages/workspace-core/src/sources/process.ts";
import type { WorkspaceSource } from "../packages/workspace-core/src/types.ts";

const limits = { maxDownloadBytes: 4096, maxExtractedBytes: 8192 };
const sum = limits.maxDownloadBytes + limits.maxExtractedBytes;
const headroom = 16 * 1024 ** 2;
const file = { type: "git", repository: "file:///fixture" } as const;
const https = { type: "git", repository: "https://example.test/repository" } as const;
const oci = { type: "oci", repository: "example.test/artifact" } as const;

test.each<{
  name: string;
  sources: Pick<WorkspaceSource, "type" | "repository">[];
  temporary: number;
}>([
  { name: "empty workspace", sources: [], temporary: 0 },
  { name: "local Git", sources: [file], temporary: sum },
  { name: "OCI", sources: [oci], temporary: 0 },
  { name: "local Git and OCI", sources: [file, oci], temporary: sum },
  { name: "HTTPS Git", sources: [https], temporary: sum },
  { name: "mixed sources", sources: [file, oci, https], temporary: sum },
  { name: "serial HTTPS Git sources", sources: [https, https], temporary: sum },
])("physical reservation for $name accounts for simultaneous storage", ({ sources, temporary }) => {
  expect(controlledAcquisitionPhysicalReservation(limits)).toBe(sum + headroom);
  expect(acquisitionPhysicalReservation(sources, limits)).toBe(sum + headroom + temporary);
});

test("URL protocol classification matches accepted case-insensitive Git schemes", () => {
  expect(gitUsesRemoteAcquisition("FILE:///fixture")).toBe(false);
  expect(gitUsesRemoteAcquisition("HTTPS://example.test/repository")).toBe(true);
  expect(() => gitUsesRemoteAcquisition("ssh://example.test/repository")).toThrow(
    "Unsupported Git acquisition protocol",
  );
});

test("unsafe arithmetic cannot silently produce an unbounded admission budget", () => {
  expect(() =>
    acquisitionPhysicalReservation([file], {
      maxDownloadBytes: Number.MAX_SAFE_INTEGER,
      maxExtractedBytes: 1,
    }),
  ).toThrow("Invalid physical source acquisition limits");
});

test("shared controlled budget rejects an oversized write before creating its inode", async () => {
  const root = await mkdtemp(join(realpathSync(tmpdir()), "allagents-acquisition-budget-"));
  try {
    const maximum = controlledAcquisitionPhysicalReservation(limits);
    const writer = await PhysicalWriter.create(root, maximum);
    await expect(writer.file(join(root, "oversized"), Buffer.alloc(maximum + 1))).rejects.toThrow(
      "physical staging reservation",
    );
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
