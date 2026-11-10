import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { reportEvaluation, runEvaluation } from "../packages/oh-my-promptfoo/src/eval-run";
import { testEntries } from "./global-setup";

test("current external reporting preserves process failures, native tolerance and private exports without inference", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp external report "));
  try {
    const config = join(directory, "promptfooconfig.yaml");
    const provider = join(directory, "unmeasured.mjs");
    await writeFile(
      provider,
      "export default class { id(){return 'unmeasured'} async callApi(prompt){return {output:prompt}} }",
    );
    await writeFile(
      config,
      `prompts: [PRIVATE_ANSWER]\nproviders: [file://${provider}]\ntests:\n  - assert:\n      - type: equals\n        value: different\n`,
    );
    const native = await runEvaluation({
      config,
      outputDirectory: join(directory, "native"),
      args: ["--no-cache"],
    });
    assert.equal(native.exitCode, 100);
    const original = await readFile(native.resultPath, "utf8");
    await writeFile(provider, "throw new Error('Reporting must never load this provider');");
    await writeFile(
      config,
      "throw new Error('Reporting must never load providers or execute configs');",
    );
    for (const [exitCode, expected] of [
      [0, "pass"],
      [100, "fail"],
      [1, "error"],
      [null, "error"],
    ] as const) {
      const output = join(directory, `outputs-${exitCode}`);
      const summary = join(directory, `summary-${exitCode}`);
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          resolve(import.meta.dirname, "fixtures/deny-replay-io.mjs"),
          join(testEntries, "cli.js"),
          "report",
          "--results",
          native.resultPath,
          "--exit-code",
          exitCode === null ? "unknown" : String(exitCode),
          "--config",
          config,
          "--output-dir",
          join(directory, `report-${exitCode}`),
          "--github",
        ],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
        },
      );
      assert.equal(child.status, expected === "pass" ? 0 : 1, child.stdout + child.stderr);
      assert.ok((await readFile(output, "utf8")).includes(`\n${expected}\n`));
      const markdown = await readFile(summary, "utf8");
      assert.ok(markdown.includes("| Failed | 1 |") && markdown.includes("unknown"));
      assert.ok(!markdown.includes("Replay") && !markdown.includes("PRIVATE_ANSWER"));
      assert.ok(!(child.stdout + child.stderr).includes("PRIVATE_ANSWER"));
    }
    assert.equal(await readFile(native.resultPath, "utf8"), original);
    const missing = await reportEvaluation(
      join(directory, "missing.json"),
      join(directory, "missing-report"),
      { exitCode: 0 },
    );
    assert.equal(missing.report.status, "error");
    assert.equal(missing.resultsAvailable, false);
    await assert.rejects(
      reportEvaluation(native.resultPath, join(directory, "bad"), { replay: true, exitCode: 0 }),
    );
    await assert.rejects(
      reportEvaluation(native.resultPath, join(directory, "bad-code"), { exitCode: 256 }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
