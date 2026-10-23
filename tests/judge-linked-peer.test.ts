import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, vi } from "vitest";
import { llmAssert } from "../packages/oh-my-promptfoo/src/assertions";
import { installRoot, loadJudge } from "../packages/oh-my-promptfoo/src/judge";
import type * as Protocol from "../packages/oh-my-promptfoo/src/protocol.ts";

// A linked Promptfoo (`npm link`, pnpm `link:`) resolves to its own checkout, outside any
// node_modules, so no install root can be read from its path.
const linked = vi.hoisted(() => ({ entry: "" }));
vi.mock("../packages/oh-my-promptfoo/src/protocol.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof Protocol>();
  return {
    ...actual,
    resolvePeer: (basePath: string, name: string) =>
      name === "promptfoo" && linked.entry ? linked.entry : actual.resolvePeer(basePath, name),
  };
});

const fixture = join(import.meta.dirname, "fixtures", "judge-provider.mjs");
// The criteria the fixture judge scores by default.
const components = [
  { metric: "accuracy", value: "Ground every claim" },
  { metric: "clarity", value: "Explain plainly" },
];

test("a linked Promptfoo peer still loads judges, resolving relative ids from the working directory", async () => {
  const temp = await mkdtemp(join(realpathSync(tmpdir()), "judge-linked-"));
  const previous = process.cwd();
  try {
    // The linked checkout's entry re-exports this repository's Promptfoo.
    const checkout = join(temp, "checkout", "promptfoo");
    await mkdir(checkout, { recursive: true });
    const real = join(import.meta.dirname, "..", "node_modules", "promptfoo", "dist", "src");
    linked.entry = join(checkout, "index.js");
    await writeFile(
      linked.entry,
      `export * from ${JSON.stringify(pathToFileURL(realpathSync(join(real, "index.js"))).href)};\n`,
    );
    await writeFile(join(checkout, "package.json"), JSON.stringify({ type: "module" }));
    assert.equal(installRoot(linked.entry), undefined);

    // The project Promptfoo runs from, with a judge package and a relative judge file.
    const project = join(temp, "project");
    const judgePackage = join(project, "node_modules", "linked-judge");
    await mkdir(judgePackage, { recursive: true });
    await writeFile(
      join(judgePackage, "package.json"),
      JSON.stringify({ name: "linked-judge", type: "module", exports: "./index.mjs" }),
    );
    await writeFile(
      join(judgePackage, "index.mjs"),
      "export { default as JudgeFixture } from './judge-provider.mjs';\n",
    );
    await copyFile(fixture, join(judgePackage, "judge-provider.mjs"));
    await copyFile(fixture, join(project, "judge.mjs"));
    process.chdir(project);

    const grade = (provider: unknown) =>
      llmAssert("answer", { config: { components }, test: { options: { provider } } });
    for (const id of [
      `file://${fixture}`,
      "package:linked-judge:JudgeFixture",
      "file://judge.mjs",
    ]) {
      const graded = await grade(id);
      assert.equal(graded.pass, true, id);
      // No base path is invented: Promptfoo's loader applies its own default.
      const { config } = graded.metadata.fixture as { config: unknown };
      assert.deepEqual(config, {}, id);
    }
    // An explicit base path still applies.
    const own = await loadJudge("file://judge-provider.mjs", {
      basePath: join(import.meta.dirname, "fixtures"),
    });
    assert.equal(own.id(), "file://judge-provider.mjs");
  } finally {
    process.chdir(previous);
    await rm(temp, { recursive: true, force: true });
  }
});
