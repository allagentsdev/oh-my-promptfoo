import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { workspaceReaderPath } from "../packages/oh-my-promptfoo/src/grader-policy";

function readProtected(root: string, sourceRoots: Record<string, string>) {
  const requests = [
    {
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    },
    { method: "notifications/initialized" },
    {
      id: 2,
      method: "tools/call",
      params: { name: "read_file", arguments: { path: "source/input.txt" } },
    },
  ];
  return spawnSync(process.execPath, [workspaceReaderPath(), root, JSON.stringify(sourceRoots)], {
    input: `${requests.map((request) => JSON.stringify({ jsonrpc: "2.0", ...request })).join("\n")}\n`,
    encoding: "utf8",
    timeout: 10_000,
  });
}

async function withLink(
  run: (dirs: { workspace: string; protectedRoot: string; other: string }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "omp-reader-"));
  try {
    const workspace = join(root, "workspace");
    const protectedRoot = join(root, "protected-long-directory-name");
    const other = join(root, "other-directory");
    for (const directory of [workspace, protectedRoot, other]) await mkdir(directory);
    await writeFile(join(protectedRoot, "input.txt"), "protected source");
    await symlink(protectedRoot, join(workspace, "source"), "dir");
    await run({ workspace, protectedRoot, other });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function shortPath(path: string): string {
  const result = spawnSync("cmd.exe", ["/d", "/s", "/c", `for %I in ("${path}") do @echo %~sI`], {
    encoding: "utf8",
    windowsVerbatimArguments: true,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test.runIf(process.platform === "win32")(
  "workspace reader accepts a declared link target spelled with Windows 8.3 short names",
  async (context) => {
    await withLink(async ({ workspace, protectedRoot }) => {
      const short = shortPath(protectedRoot);
      // 8.3 generation can be disabled per volume; then no short spelling exists.
      if (short.toLowerCase() === protectedRoot.toLowerCase())
        context.skip("8.3 short names are disabled on this volume");
      const child = readProtected(workspace, { source: short });
      assert.equal(child.status, 0, child.stderr);
      const reply = child.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .find((line) => line.id === 2);
      assert.equal(JSON.parse(reply.result.content[0].text).text, "protected source");
    });
  },
);

test("workspace reader still refuses undeclared or mismatched source links", async () => {
  await withLink(async ({ workspace, protectedRoot, other }) => {
    const mismatched = readProtected(workspace, { source: other });
    assert.notEqual(mismatched.status, 0);
    assert.match(mismatched.stderr, /not a declared protected directory link/);
    // A real directory, not a symlink, is never a declared link even when its target matches.
    await mkdir(join(workspace, "plain"));
    const plain = readProtected(workspace, { plain: join(workspace, "plain") });
    assert.notEqual(plain.status, 0);
    assert.match(plain.stderr, /not a declared protected directory link/);
    const accepted = readProtected(workspace, { source: protectedRoot });
    assert.equal(accepted.status, 0, accepted.stderr);
  });
});
