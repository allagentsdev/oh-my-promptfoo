import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LIMITS } from "../packages/workspace-core/src/config.ts";
import { ownedRoot } from "../packages/workspace-core/src/fs.ts";
import {
  materializeSources,
  resolveSources,
} from "../packages/workspace-core/src/sources/index.ts";

const real = process.env.ALLAGENTS_TEST_GIT_HTTPS === "1" ? test : test.skip;
real(
  "real HTTPS Git fetch is kernel-bounded, pinned, sanitized, and unmounted after publication",
  async () => {
    const parent = await mkdtemp(join(realpathSync(tmpdir()), "allagents-https-git-"));
    const cache = join(parent, "cache");
    await ownedRoot(cache, "cache");
    const staging = join(cache, "staging", "fixture", "tree");
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      const sources = await resolveSources(
        {
          sources: [
            {
              type: "git",
              repository: "https://github.com/octocat/Hello-World.git",
              ref: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
              destination: "project",
            },
          ],
        },
        {},
      );
      await materializeSources(sources, staging, DEFAULT_LIMITS, {});
      expect(await readFile(join(staging, "project", "README"), "utf8")).toContain("Hello World");
      expect(await readdir(staging)).toEqual(["project"]);
      expect(await readFile(join(staging, "project", ".git", "config"), "utf8")).not.toContain(
        "github",
      );
      expect(await readdir(join(staging, "project", ".git", "refs"))).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
  120000,
);

real(
  "real external Git writer cannot exceed a tiny kernel staging capacity and publishes nothing",
  async () => {
    const parent = await mkdtemp(join(realpathSync(tmpdir()), "allagents-https-git-"));
    const cache = join(parent, "cache");
    await ownedRoot(cache, "cache");
    const staging = join(cache, "staging", "fixture", "tree");
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      await expect(
        materializeSources(
          [
            {
              type: "git",
              repository: "https://github.com/octocat/Hello-World.git",
              ref: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
              commit: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
              destination: "project",
            },
          ],
          staging,
          { ...DEFAULT_LIMITS, maxDownloadBytes: 4096, maxExtractedBytes: 4096 },
          {},
        ),
      ).rejects.toThrow();
      expect(await readdir(staging)).toEqual([]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  },
  120000,
);
