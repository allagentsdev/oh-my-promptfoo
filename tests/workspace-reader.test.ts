import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

type Call = { name: string; arguments: Record<string, unknown> };

function callReader(
  root: string,
  sourceRoots: Record<string, string>,
  calls: Call[],
  options: { preload?: string; env?: Record<string, string> } = {},
) {
  const requests = [
    {
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    },
    ...calls.map((params, index) => ({ id: index + 1, method: "tools/call", params })),
  ];
  const child = spawnSync(
    process.execPath,
    [
      ...(options.preload ? ["--import", pathToFileURL(options.preload).href] : []),
      workspaceReaderPath(),
      root,
      JSON.stringify(sourceRoots),
    ],
    {
      input: `${requests.map((request) => JSON.stringify({ jsonrpc: "2.0", ...request })).join("\n")}\n`,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, ...options.env },
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const replies = child.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return {
    stdout: child.stdout,
    results: calls.map((_, index) => {
      const reply = replies.find((line) => line.id === index + 1);
      return reply.result as { isError?: boolean; content: { text: string }[] };
    }),
  };
}

test("workspace reader still reads files and lists directories in the workspace and sources", async () => {
  await withLink(async ({ workspace, protectedRoot }) => {
    await mkdir(join(workspace, "dir"));
    await writeFile(join(workspace, "dir", "plain.txt"), "workspace text");
    const { results } = callReader(workspace, { source: protectedRoot }, [
      { name: "read_file", arguments: { path: "dir/plain.txt" } },
      { name: "list_directory", arguments: { path: "dir" } },
      { name: "read_file", arguments: { path: "source/input.txt" } },
      { name: "list_directory", arguments: { path: "source" } },
    ]);
    for (const result of results) assert.equal(result.isError, undefined, result.content[0].text);
    const [file, listing, source, sourceListing] = results.map((result) =>
      JSON.parse(result.content[0].text),
    );
    assert.equal(file.text, "workspace text");
    assert.equal(file.size, 14);
    assert.deepEqual(listing.entries, [{ name: "plain.txt", type: "file" }]);
    assert.equal(source.text, "protected source");
    assert.deepEqual(sourceListing.entries, [{ name: "input.txt", type: "file" }]);
  });
});

test("workspace reader refuses a hard link to a file outside the workspace", async (context) => {
  await withLink(async ({ workspace, other }) => {
    await writeFile(join(other, "secret.txt"), "outside secret");
    try {
      await link(join(other, "secret.txt"), join(workspace, "hard.txt"));
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM")
        context.skip("hard links are not permitted on this volume");
      throw error;
    }
    const { stdout, results } = callReader(workspace, {}, [
      { name: "read_file", arguments: { path: "hard.txt" } },
    ]);
    assert.equal(results[0].isError, true);
    assert.match(results[0].content[0].text, /multiple hard links/);
    assert.doesNotMatch(stdout, /outside secret/);
  });
});

// Swaps the workspace directory for a symlink to `outside` just before the
// reader's first open/opendir under it: the window between realpath and open.
const swapHook = `
import { renameSync, symlinkSync } from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const { parent, outside } = JSON.parse(process.env.OMP_READER_SWAP);
const key = (path) => (process.platform === "win32" ? String(path).toLowerCase() : String(path));
let swapped = false;
for (const name of ["open", "opendir"]) {
  const original = fsp[name];
  fsp[name] = (path, ...rest) => {
    if (!swapped && key(path).startsWith(key(parent))) {
      swapped = true;
      renameSync(parent, \`\${parent}-moved\`);
      symlinkSync(outside, parent, "dir");
    }
    return original(path, ...rest);
  };
}
syncBuiltinESMExports();
`;

for (const call of [
  { name: "read_file", arguments: { path: "dir/inner/secret.txt" } },
  { name: "list_directory", arguments: { path: "dir/inner" } },
])
  test(`workspace reader refuses ${call.name} when a parent is swapped after the path check`, async () => {
    await withLink(async ({ workspace, other }) => {
      await mkdir(join(workspace, "dir", "inner"), { recursive: true });
      await writeFile(join(workspace, "dir", "inner", "secret.txt"), "workspace text");
      await mkdir(join(other, "inner"));
      await writeFile(join(other, "inner", "secret.txt"), "outside secret");
      await writeFile(join(other, "inner", "outside-only.txt"), "");
      const preload = join(other, "..", "swap-hook.mjs");
      await writeFile(preload, swapHook);
      const parent = await realpath(join(workspace, "dir"));
      const { stdout, results } = callReader(workspace, {}, [call], {
        preload,
        env: { OMP_READER_SWAP: JSON.stringify({ parent, outside: other }) },
      });
      assert.equal(results[0].isError, true, results[0].content[0].text);
      assert.match(results[0].content[0].text, /changed while it was being opened/);
      assert.doesNotMatch(stdout, /outside secret|outside-only/);
    });
  });
