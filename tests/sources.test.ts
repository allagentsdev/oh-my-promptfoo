import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  statfs,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { DEFAULT_LIMITS } from "../packages/workspace-core/src/config.ts";
import { atomicJson, PACKAGE, processIdentity } from "../packages/workspace-core/src/fs.ts";
import { helperAvailable, helperInvoke } from "../packages/workspace-core/src/helper.ts";
import {
  materializeSources,
  resolveSources,
} from "../packages/workspace-core/src/sources/index.ts";
import {
  digest,
  PhysicalWriter,
  runSource,
  withPrivateAcquisition,
} from "../packages/workspace-core/src/sources/process.ts";
import {
  createGitStagingChild,
  removeGitStagingChild,
  verifyGitStagingRoot,
} from "../packages/workspace-core/src/sources/unprivileged-staging.ts";
import type { WorkspaceSpec } from "../packages/workspace-core/src/types.ts";

const exec = promisify(execFile);
const roots: string[] = [];
const privateAclCheck =
  "if(/\\(I\\)|Everyone|Authenticated Users|BUILTIN\\\\Users/i.test(acl)||!/\\(F\\)/.test(acl))process.exit(4);";
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function temporary(): Promise<string> {
  const root = await mkdtemp(join(realpathSync(tmpdir()), "allagents-source-test-"));
  roots.push(root);
  return root;
}
async function fixture(): Promise<{
  root: string;
  repository: string;
  staging: string;
  commit: string;
  spec: WorkspaceSpec;
}> {
  const root = await temporary();
  const repository = join(root, "repository");
  const staging = join(root, "staging");
  await mkdir(repository);
  await mkdir(staging);
  const git = (...args: string[]) =>
    exec("git", ["-C", repository, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      },
    });
  await git("init", "-b", "main");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await git("config", "core.symlinks", "true");
  await writeFile(join(repository, "hello.txt"), "hello\n");
  await writeFile(join(repository, "binary.bin"), Buffer.from([0, 1, 255]));
  await writeFile(join(repository, "run.sh"), "#!/bin/sh\necho hello\n");
  await chmod(join(repository, "run.sh"), 0o755);
  await symlink("hello.txt", join(repository, "link"));
  await git("add", ".");
  await git("update-index", "--chmod=+x", "run.sh");
  await git("commit", "-m", "fixture");
  const { stdout } = await git("rev-parse", "HEAD");
  const commit = stdout.trim();
  return {
    root,
    repository,
    staging,
    commit,
    spec: {
      sources: [
        {
          type: "git",
          repository: pathToFileURL(repository).href,
          ref: "main",
          destination: "project",
        },
      ],
    },
  };
}

describe("bounded Git acquisition", () => {
  test("uppercase local URL schemes use read-only Git acquisition", async () => {
    const { staging, spec } = await fixture();
    spec.sources[0].repository = spec.sources[0].repository.replace(/^file:/, "FILE:");
    const sources = await resolveSources(spec, {});
    await materializeSources(sources, staging, DEFAULT_LIMITS, {});
    expect(await readFile(join(staging, "project", "hello.txt"), "utf8")).toBe("hello\n");
    expect(await readdir(staging)).toEqual(["project"]);
  });
  test("immutable local acquisition preserves Git executable modes under a restrictive umask", async () => {
    const { repository, staging, spec, commit } = await fixture();
    const before = await readFile(join(repository, ".git", "index"));
    const sources = await resolveSources(spec, {});
    expect(sources[0].type === "git" && sources[0].commit).toBe(commit);
    const previousUmask = process.umask(0o077);
    try {
      await materializeSources(sources, staging, DEFAULT_LIMITS, {});
    } finally {
      process.umask(previousUmask);
    }
    const project = join(staging, "project");
    expect(await readFile(join(project, "hello.txt"), "utf8")).toBe("hello\n");
    expect(await readFile(join(project, "binary.bin"))).toEqual(Buffer.from([0, 1, 255]));
    if (process.platform === "win32")
      expect(
        (await exec("git", ["-C", project, "ls-files", "--stage", "--", "run.sh"])).stdout,
      ).toMatch(/^100755 /);
    else expect((await lstat(join(project, "run.sh"))).mode & 0o111).toBe(0o111);
    expect((await exec("git", ["-C", project, "status", "--porcelain"])).stdout).toBe("");
    expect((await exec("git", ["-C", project, "rev-parse", "HEAD"])).stdout.trim()).toBe(commit);
    expect((await exec("git", ["-C", project, "remote"])).stdout).toBe("");
    await writeFile(join(project, "hello.txt"), "private");
    expect(await readFile(join(repository, "hello.txt"), "utf8")).toBe("hello\n");
    expect(await readFile(join(repository, ".git", "index"))).toEqual(before);
  });
  test("equivalent request resolves once but preserves each source permissions", async () => {
    const { spec, repository, commit } = await fixture();
    const first = await resolveSources(spec, {});
    await writeFile(join(repository, "hello.txt"), "new");
    await exec("git", ["-C", repository, "commit", "-am", "second"]);
    const other = {
      ...spec,
      sources: spec.sources.map((source) => ({ ...source, permissions: "read-only" as const })),
    };
    const second = await resolveSources(other, {});
    expect(second[0].type === "git" && second[0].commit).toBe(commit);
    expect(first[0].permissions).toBe("all");
    expect(second[0].permissions).toBe("read-only");
  });
  test("rejects submodules before accepting Git objects", async () => {
    const { spec, repository, staging } = await fixture();
    await writeFile(
      join(repository, ".gitmodules"),
      '[submodule "escape"]\npath = escape\nurl = https://example.invalid/repo\n',
    );
    await exec("git", ["-C", repository, "add", ".gitmodules"]);
    await exec("git", ["-C", repository, "commit", "-m", "submodule"]);
    spec.sources[0] = {
      ...spec.sources[0],
      ref: (await exec("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim(),
    } as (typeof spec.sources)[0];
    const sources = await resolveSources(spec, {});
    await expect(materializeSources(sources, staging, DEFAULT_LIMITS, {})).rejects.toThrow(
      "submodules",
    );
    expect(await readdir(staging)).toEqual([]);
  });
  test("rejects escaping symlinks and refuses byte overflow", async () => {
    const { spec, repository, staging } = await fixture();
    await symlink("../../outside", join(repository, "escape"));
    await exec("git", ["-C", repository, "add", "escape"]);
    await exec("git", ["-C", repository, "commit", "-m", "unsafe"]);
    spec.sources[0] = {
      ...spec.sources[0],
      ref: (await exec("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim(),
    } as (typeof spec.sources)[0];
    const sources = await resolveSources(spec, {});
    await expect(materializeSources(sources, staging, DEFAULT_LIMITS, {})).rejects.toThrow(
      "symlink escapes",
    );
    const { spec: safe, staging: bounded } = await fixture();
    const valid = await resolveSources(safe, {});
    await expect(
      materializeSources(valid, bounded, { ...DEFAULT_LIMITS, maxDownloadBytes: 16 }, {}),
    ).rejects.toThrow("limit");
  });
  test("physical parent admission rejects before creating an oversized inode", async () => {
    const root = await temporary();
    const writer = await PhysicalWriter.create(root, 1);
    await expect(writer.file(join(root, "file"), "")).rejects.toThrow(
      "physical staging reservation",
    );
    expect(await readdir(root)).toEqual([]);
  });
  test("pre-abort does not create acquisition state", async () => {
    const { spec, staging } = await fixture();
    const signal = AbortSignal.abort(new Error("cancelled"));
    await expect(resolveSources(spec, {}, signal)).rejects.toThrow("cancelled");
    expect(await readdir(staging)).toEqual([]);
  });
  test("unavailable physical mount bound rejects before a Git writer starts", async () => {
    const root = await temporary();
    const fakeBin = join(root, "bin");
    await mkdir(fakeBin);
    const sentinel = join(root, "git-started");
    await writeFile(join(fakeBin, "git"), `#!/bin/sh\necho started > '${sentinel}'\nexit 1\n`, {
      mode: 0o700,
    });
    const original = process.env.PATH;
    process.env.PATH = fakeBin;
    try {
      await expect(
        materializeSources(
          [
            {
              type: "git",
              repository: "https://example.invalid/repository",
              ref: "main",
              commit: "0".repeat(40),
              destination: "project",
            },
          ],
          root,
          DEFAULT_LIMITS,
          {},
        ),
      ).rejects.toThrow("helper");
      expect(await readdir(root)).not.toContain("git-started");
    } finally {
      process.env.PATH = original;
    }
  });
  test("no-privileged-helper mode refuses helper invocation without spawning sudo", async () => {
    const previous = process.env.ALLAGENTS_NO_PRIVILEGED_HELPER;
    process.env.ALLAGENTS_NO_PRIVILEGED_HELPER = "1";
    try {
      expect(await helperAvailable()).toBe(false);
      await expect(helperInvoke("acquire-tmpfs", ["/does-not-exist", "4096"])).rejects.toThrow(
        "forbidden",
      );
    } finally {
      if (previous === undefined) delete process.env.ALLAGENTS_NO_PRIVILEGED_HELPER;
      else process.env.ALLAGENTS_NO_PRIVILEGED_HELPER = previous;
    }
  });
  test("external Git staging rejects symlinks, non-tmpfs, and excessive physical capacity", async () => {
    if (process.platform !== "linux") return;
    const { root, staging } = await fixture();
    await chmod(root, 0o700);
    await expect(verifyGitStagingRoot(root, DEFAULT_LIMITS)).rejects.toThrow("tmpfs");
    const linked = join(root, "linked");
    await symlink(root, linked);
    await expect(verifyGitStagingRoot(linked, DEFAULT_LIMITS)).rejects.toThrow("symlink");
    const candidate = await mkdtemp("/dev/shm/allagents-bounded-test-");
    roots.push(candidate);
    await chmod(candidate, 0o700);
    await expect(
      verifyGitStagingRoot(candidate, { ...DEFAULT_LIMITS, maxDownloadBytes: 4096 }),
    ).rejects.toThrow("exceeds source limits");
    const separate = await temporary();
    await chmod(separate, 0o700);
    const sentinel = join(root, "git-started");
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "git"), `#!/bin/sh\necho started > '${sentinel}'\nexit 1\n`, {
      mode: 0o700,
    });
    const previousPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      await expect(
        materializeSources(
          [
            {
              type: "git",
              repository: "https://example.invalid/repository",
              ref: "main",
              commit: "0".repeat(40),
              destination: "project",
            },
          ],
          staging,
          DEFAULT_LIMITS,
          { ALLAGENTS_GIT_STAGING_ROOT: separate },
        ),
      ).rejects.toThrow("tmpfs");
      expect(await readdir(root)).not.toContain("git-started");
    } finally {
      process.env.PATH = previousPath;
    }
  });
  test("pre-mounted private tmpfs stages a real Git clone without a privileged helper", async () => {
    if (process.platform !== "linux") return;
    const { spec, staging } = await fixture();
    const mount = await statfs("/dev/shm", { bigint: true });
    const total = Number(mount.blocks * mount.bsize);
    if (!Number.isSafeInteger(total) || total > 100 * 1024 ** 3) return;
    const candidate = await mkdtemp("/dev/shm/allagents-bounded-test-");
    roots.push(candidate);
    await chmod(candidate, 0o700);
    const previous = process.env.ALLAGENTS_NO_PRIVILEGED_HELPER;
    process.env.ALLAGENTS_NO_PRIVILEGED_HELPER = "1";
    try {
      const limits = {
        ...DEFAULT_LIMITS,
        maxDownloadBytes: Math.ceil(total / 2),
        maxExtractedBytes: Math.ceil(total / 2),
      };
      const sources = await resolveSources(spec, {});
      await materializeSources(sources, staging, limits, {
        ALLAGENTS_GIT_STAGING_ROOT: candidate,
      });
      expect(await readFile(join(staging, "project", "hello.txt"), "utf8")).toBe("hello\n");
      expect(await readdir(candidate)).toEqual([]);
      expect(await readdir(staging)).toEqual(["project"]);
    } finally {
      if (previous === undefined) delete process.env.ALLAGENTS_NO_PRIVILEGED_HELPER;
      else process.env.ALLAGENTS_NO_PRIVILEGED_HELPER = previous;
    }
  });
  test("staging reaper removes only dead marked children, preserving live and unmarked children", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp("/dev/shm/allagents-bounded-test-");
    roots.push(root);
    await chmod(root, 0o700);
    const fs = await statfs(root, { bigint: true });
    const total = Number(fs.blocks * fs.bsize);
    if (!Number.isSafeInteger(total) || total > 100 * 1024 ** 3) return;
    const limits = {
      ...DEFAULT_LIMITS,
      maxDownloadBytes: Math.ceil(total / 2),
      maxExtractedBytes: Math.ceil(total / 2),
    };
    const dead = join(root, "allagents-bounded-git-00000000-0000-0000-0000-000000000001");
    const live = join(root, "allagents-bounded-git-00000000-0000-0000-0000-000000000002");
    const unmarked = join(root, "allagents-bounded-git-00000000-0000-0000-0000-000000000003");
    for (const child of [dead, live, unmarked]) await mkdir(child, { mode: 0o700 });
    const identity = await processIdentity();
    for (const child of [dead, live])
      await atomicJson(join(child, ".allagents-owner.json"), {
        schemaVersion: 1,
        package: PACKAGE,
        kind: "bounded-git-acquisition",
        path: child,
        identity: child === dead ? { ...identity, boot: "previous-boot" } : identity,
      });
    const current = join(root, "allagents-bounded-git-00000000-0000-0000-0000-000000000004");
    await createGitStagingChild(root, limits, current);
    expect((await readdir(root)).sort()).toEqual([
      "allagents-bounded-git-00000000-0000-0000-0000-000000000002",
      "allagents-bounded-git-00000000-0000-0000-0000-000000000003",
      "allagents-bounded-git-00000000-0000-0000-0000-000000000004",
    ]);
    await removeGitStagingChild(root, current);
  });
});

async function fakeOras(
  root: string,
  manifest: Buffer,
  blobs: Record<string, string>,
  extra = "",
): Promise<string> {
  const path = join(root, "oras-fixture.cjs");
  await writeFile(
    path,
    `#!/usr/bin/env node\nconst fs=require('fs');const args=process.argv.slice(2);if(args[0]==='version'){console.log('Version: 1.3.0');process.exit(0);}const manifest=Buffer.from('${manifest.toString("base64")}','base64');const blobs=${JSON.stringify(blobs)};${extra}\nif(args[0]==='manifest'){if(args.includes('--descriptor'))process.stdout.write(JSON.stringify({digest:'${digest(manifest)}'}));else process.stdout.write(manifest);}else if(args[0]==='blob'){const ref=args[args.length-1];fs.appendFileSync(${JSON.stringify(join(root, "blob-calls"))},'call\\n');process.stdout.write(Buffer.from(blobs[ref.slice(ref.lastIndexOf('@')+1)]||'','base64'));}else process.exit(3);\n`,
    { mode: 0o700 },
  );
  if (process.platform === "win32") {
    const executable = join(root, "oras-fixture.exe");
    await exec(process.execPath, ["build", "--compile", path, "--outfile", executable]);
    return executable;
  }
  return path;
}
function manifestFor(
  bytes: Buffer,
  title = "data.txt",
  size = bytes.length,
  mediaType = "application/octet-stream",
): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        mediaType: "application/vnd.oci.empty.v1+json",
        digest: digest(Buffer.from("{}")),
        size: 2,
      },
      layers: [
        {
          mediaType,
          digest: digest(bytes),
          size,
          annotations: { "org.opencontainers.image.title": title },
        },
      ],
    }),
  );
}

describe("OCI manifest and streaming defenses", () => {
  test("valid binary artifact has pinned provenance and exact bytes", async () => {
    const root = await temporary();
    const bytes = Buffer.from([0, 255, 12]);
    const manifest = manifestFor(bytes);
    const oras = await fakeOras(root, manifest, { [digest(bytes)]: bytes.toString("base64") });
    const staging = join(root, "staging");
    await mkdir(staging);
    const sources = await resolveSources(
      {
        sources: [
          {
            type: "oci",
            repository: "registry.example.test/fixture",
            tag: "test",
            destination: "data",
          },
        ],
      },
      { ALLAGENTS_ORAS_PATH: oras },
    );
    expect(sources[0].type === "oci" && sources[0].digest).toBe(digest(manifest));
    await materializeSources(sources, staging, DEFAULT_LIMITS, { ALLAGENTS_ORAS_PATH: oras });
    expect(await readFile(join(staging, "data", "data.txt"))).toEqual(bytes);
  });
  test.each([
    "../escape",
    "/escape",
    "a/../escape",
    "a\\escape",
    "C:/escape",
  ])("rejects malicious title %s before any blob fetch", async (title) => {
    const root = await temporary();
    const bytes = Buffer.from("x");
    const manifest = manifestFor(bytes, title);
    const oras = await fakeOras(root, manifest, { [digest(bytes)]: bytes.toString("base64") });
    const staging = join(root, "stage");
    await mkdir(staging);
    await expect(
      materializeSources(
        [
          {
            type: "oci",
            repository: "registry.test/fixture",
            digest: digest(manifest),
            destination: "data",
          },
        ],
        staging,
        DEFAULT_LIMITS,
        { ALLAGENTS_ORAS_PATH: oras },
      ),
    ).rejects.toThrow("containment");
    expect(await readdir(root)).not.toContain("blob-calls");
  });
  test("declared overflow rejects before blob subprocess, lying stream is stopped and removed", async () => {
    const root = await temporary();
    const bytes = Buffer.alloc(1000, 65);
    const manifest = manifestFor(bytes);
    const oras = await fakeOras(root, manifest, { [digest(bytes)]: bytes.toString("base64") });
    const staging = join(root, "stage");
    await mkdir(staging);
    await expect(
      materializeSources(
        [
          {
            type: "oci",
            repository: "registry.test/fixture",
            digest: digest(manifest),
            destination: "data",
          },
        ],
        staging,
        { ...DEFAULT_LIMITS, maxExtractedBytes: 100 },
        { ALLAGENTS_ORAS_PATH: oras },
      ),
    ).rejects.toThrow("before blob");
    expect(await readdir(root)).not.toContain("blob-calls");
    const lying = manifestFor(bytes, "data.txt", 2);
    const liar = await fakeOras(root, lying, { [digest(bytes)]: bytes.toString("base64") });
    await expect(
      materializeSources(
        [
          {
            type: "oci",
            repository: "registry.test/fixture",
            digest: digest(lying),
            destination: "data",
          },
        ],
        staging,
        DEFAULT_LIMITS,
        { ALLAGENTS_ORAS_PATH: liar },
      ),
    ).rejects.toThrow("stream exceeds");
    expect(await readdir(join(staging, "data"))).toEqual([]);
  });
  test("rejects manifest and blob digest mismatches and unsupported archives", async () => {
    const root = await temporary();
    const bytes = Buffer.from("x");
    const manifest = manifestFor(bytes);
    const oras = await fakeOras(root, manifest, {
      [digest(bytes)]: Buffer.from("z").toString("base64"),
    });
    const staging = join(root, "stage");
    await mkdir(staging);
    await expect(
      materializeSources(
        [
          {
            type: "oci",
            repository: "registry.test/fixture",
            digest: digest(Buffer.from("wrong")),
            destination: "a",
          },
        ],
        staging,
        DEFAULT_LIMITS,
        { ALLAGENTS_ORAS_PATH: oras },
      ),
    ).rejects.toThrow("manifest digest mismatch");
    await expect(
      materializeSources(
        [
          {
            type: "oci",
            repository: "registry.test/fixture",
            digest: digest(manifest),
            destination: "b",
          },
        ],
        staging,
        DEFAULT_LIMITS,
        { ALLAGENTS_ORAS_PATH: oras },
      ),
    ).rejects.toThrow("blob size or digest mismatch");
    const archive = manifestFor(
      bytes,
      "file.tar",
      bytes.length,
      "application/vnd.oci.image.layer.v1.tar",
    );
    const archiveOras = await fakeOras(root, archive, {});
    await expect(
      materializeSources(
        [
          {
            type: "oci",
            repository: "registry.test/fixture",
            digest: digest(archive),
            destination: "c",
          },
        ],
        staging,
        DEFAULT_LIMITS,
        { ALLAGENTS_ORAS_PATH: archiveOras },
      ),
    ).rejects.toThrow("archives");
  });
  test("auth copy is private, is removed after failure, and emitted auth tokens are redacted", async () => {
    const root = await temporary();
    const manifest = manifestFor(Buffer.from("x"));
    const secret = "registry-secret-test";
    const auth = join(root, "auth.json");
    await writeFile(
      auth,
      JSON.stringify({
        auths: { "registry.test": { auth: Buffer.from(`user:${secret}`).toString("base64") } },
      }),
    );
    let checkPrivacy = "if((fs.statSync(p).mode&511)!==384)process.exit(4);";
    if (process.platform === "win32") {
      const icacls = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
      checkPrivacy = `const acl=require('node:child_process').execFileSync(${JSON.stringify(icacls)},[p],{encoding:'utf8'});${privateAclCheck}`;
    }
    const oras = await fakeOras(
      root,
      manifest,
      {},
      `if(args[0]==='manifest'){const p=args[args.indexOf('--registry-config')+1];fs.writeFileSync(${JSON.stringify(join(root, "copy-path"))},p);${checkPrivacy}process.stderr.write('${secret}');process.exit(5);}`,
    );
    const staging = join(root, "stage");
    await mkdir(staging);
    let error = "";
    try {
      await materializeSources(
        [
          {
            type: "oci",
            repository: "registry.test/fixture",
            digest: digest(manifest),
            destination: "a",
          },
        ],
        staging,
        DEFAULT_LIMITS,
        { ALLAGENTS_ORAS_PATH: oras, ALLAGENTS_ORAS_AUTH_FILE: auth },
      );
    } catch (caught) {
      error = String(caught);
    }
    expect(error).toContain("[redacted]");
    expect(error).not.toContain(secret);
    const copy = await readFile(join(root, "copy-path"), "utf8");
    await expect(lstat(copy)).rejects.toThrow();
  });
  test("aggregate limits span all configured sources", async () => {
    const root = await temporary();
    const bytes = Buffer.alloc(10, 1);
    const manifest = manifestFor(bytes);
    const oras = await fakeOras(root, manifest, { [digest(bytes)]: bytes.toString("base64") });
    const staging = join(root, "stage");
    await mkdir(staging);
    await expect(
      materializeSources(
        [
          {
            type: "oci",
            repository: "registry.test/fixture",
            digest: digest(manifest),
            destination: "a",
          },
          {
            type: "oci",
            repository: "registry.test/fixture",
            digest: digest(manifest),
            destination: "b",
          },
        ],
        staging,
        { ...DEFAULT_LIMITS, maxExtractedBytes: 15 },
        { ALLAGENTS_ORAS_PATH: oras },
      ),
    ).rejects.toThrow("before blob");
  });
});

test("source process cancellation kills its process group and redacts credentials", async () => {
  const signal = AbortSignal.timeout(50);
  await expect(
    runSource(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      env: { PATH: process.env.PATH },
      channels: {},
      signal,
    }),
  ).rejects.toThrow();
  await expect(
    runSource(process.execPath, ["-e", 'process.stderr.write("secret-token");process.exit(1)'], {
      env: { PATH: process.env.PATH },
      channels: { ALLAGENTS_GIT_TOKEN: "secret-token" },
    }),
  ).rejects.toThrow("[redacted]");
});

test("source cancellation terminates a spawned descendant before it can write", async () => {
  const root = await temporary();
  const escaped = join(root, "escaped");
  const abort = new AbortController();
  const descendant = `setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "escaped"), 500)`;
  const script = `const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}, process.argv[1]], { stdio: "ignore" }); process.stdout.write("started\\n"); setInterval(() => {}, 1000);`;
  await expect(
    runSource(process.execPath, ["-e", script, escaped], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      channels: {},
      signal: abort.signal,
      onChunk: async (bytes) => {
        if (bytes.includes("started")) abort.abort(new Error("stop source tree"));
      },
    }),
  ).rejects.toThrow("stop source tree");
  await new Promise((resolve) => setTimeout(resolve, 650));
  await expect(lstat(escaped)).rejects.toThrow();
});

test("private acquisition recovery removes only marked dead credential directories", async () => {
  const identity = await processIdentity();
  const dead = await mkdtemp(join(realpathSync(tmpdir()), "allagents-acquisition-"));
  roots.push(dead);
  const live = await mkdtemp(join(realpathSync(tmpdir()), "allagents-acquisition-"));
  roots.push(live);
  const malformed = await mkdtemp(join(realpathSync(tmpdir()), "allagents-acquisition-"));
  roots.push(malformed);
  await atomicJson(join(dead, ".allagents-owner.json"), {
    schemaVersion: 1,
    package: PACKAGE,
    kind: "source-acquisition",
    identity: { ...identity, pid: 2147483647 },
  });
  await writeFile(join(dead, "registry-auth.json"), "secret", { mode: 0o600 });
  await atomicJson(join(live, ".allagents-owner.json"), {
    schemaVersion: 1,
    package: PACKAGE,
    kind: "source-acquisition",
    identity,
  });
  await writeFile(join(malformed, ".allagents-owner.json"), "{}", { mode: 0o600 });
  await withPrivateAcquisition({}, async (root, env) => {
    if (process.platform === "win32") {
      expect(env.TEMP).toBe(root);
      expect(env.TMP).toBe(root);
      expect(env.USERPROFILE).toBe(root);
      const icacls = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe");
      const { stdout } = await exec(icacls, [root]);
      expect(stdout).not.toMatch(/\(I\)|Everyone|Authenticated Users|BUILTIN\\Users/i);
      expect(stdout).toMatch(/\(F\)/);
    } else expect((await lstat(root)).mode & 0o077).toBe(0);
  });
  await expect(lstat(dead)).rejects.toThrow();
  expect((await lstat(live)).isDirectory()).toBe(true);
  expect((await lstat(malformed)).isDirectory()).toBe(true);
});

test("private acquisition canonicalizes platform temp aliases and cleans its marked scratch", async () => {
  const root = await temporary();
  const physical = join(root, "physical");
  const alias = join(root, "platform-alias");
  await mkdir(physical);
  await symlink(physical, alias, process.platform === "win32" ? "junction" : "dir");
  const module = pathToFileURL(
    join(process.cwd(), "packages/workspace-core/src/sources/process.ts"),
  ).href;
  const code = `const {withPrivateAcquisition}=await import(${JSON.stringify(module)});let observed;await withPrivateAcquisition({},async(root,env)=>{observed=root;if(env.HOME!==root)throw Error('Environment escaped acquisition');});console.log(observed);`;
  const { stdout } = await exec(process.execPath, ["-e", code], {
    env: {
      ...process.env,
      TMPDIR: alias,
      ...(process.platform === "win32" ? { TEMP: alias, TMP: alias } : {}),
    },
  });
  expect(stdout.trim().startsWith(`${physical}${sep}`)).toBe(true);
  expect(await readdir(physical)).toEqual([]);
});
