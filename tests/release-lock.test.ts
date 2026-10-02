import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";

const script = join(import.meta.dir, "..", "scripts", "sync-release-lock.ts");

test("release lock sync updates only the public workspace without running project preloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "allagents-release-lock-"));
  const toolRoot = await mkdtemp(join(tmpdir(), "allagents-release-tools-"));
  try {
    await mkdir(join(root, "packages", "oh-my-promptfoo"), { recursive: true });
    await writeFile(join(root, "bunfig.toml"), '[run]\npreload = ["./preload.js"]\n');
    await writeFile(
      join(root, "preload.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(join(root, "preload-ran"))}, "unsafe");\n`,
    );
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.1.0" }));
    await writeFile(
      join(root, "packages", "oh-my-promptfoo", "package.json"),
      JSON.stringify({ name: "@allagents/oh-my-promptfoo", version: "1.1.0" }),
    );
    const lockPath = join(root, "bun.lock");
    await writeFile(
      lockPath,
      `{
  "workspaces": {
    "packages/oh-my-promptfoo": {
      "name": "@allagents/oh-my-promptfoo",
      "version": "1.0.0",
    },
    "packages/workspace-core": {
      "name": "@allagents/workspace-core",
      "version": "1.0.0",
    },
  },
}\n`,
    );
    const run = () =>
      spawnSync(process.execPath, [script, root], { cwd: toolRoot, encoding: "utf8" });
    expect(run().status).toBe(0);
    expect(await Bun.file(join(root, "preload-ran")).exists()).toBe(false);
    const updated = await readFile(lockPath, "utf8");
    const workspaces = parse(updated).workspaces;
    expect(workspaces["packages/oh-my-promptfoo"].version).toBe("1.1.0");
    expect(workspaces["packages/workspace-core"].version).toBe("1.0.0");
    expect(run().status).toBe(0);
    expect(await readFile(lockPath, "utf8")).toBe(updated);

    await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.2.0" }));
    const mismatch = run();
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toContain("Root version 1.2.0 differs from package version 1.1.0");
    expect(await readFile(lockPath, "utf8")).toBe(updated);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(toolRoot, { recursive: true, force: true });
  }
});
