import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { stringify } from "yaml";
import { reportEvaluation, runEvaluation } from "../packages/oh-my-promptfoo/src/eval-run";
import { testEntries } from "./global-setup";

const fence = resolve(import.meta.dirname, "fixtures/deny-replay-io.mjs");
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));

test("replay uses recorded native outcomes and measurements without loading a config or making model/process/network calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp replay "));
  try {
    const provider = join(directory, "provider.mjs");
    await writeFile(
      provider,
      "export default class {id(){return 'recorded-local'} async callApi(prompt){return {output:prompt,cost:0.25,tokenUsage:{prompt:10,completion:5,total:15,numRequests:1}}}}",
    );
    const config = join(directory, "promptfooconfig.yaml");
    await writeFile(
      config,
      stringify({
        description: "Recorded public suite",
        prompts: ["PRIVATE_ANSWER"],
        providers: [`file://${provider}`],
        tests: [
          {
            description: "Recorded case",
            threshold: 1,
            assert: [{ type: "equals", value: "PRIVATE_ANSWER" }],
          },
        ],
      }),
    );
    const captured = await runEvaluation({
      config,
      outputDirectory: join(directory, "capture"),
      args: ["--no-cache"],
      publicLabels: true,
    });
    assert.equal(captured.report.status, "pass");
    const original = await readFile(captured.resultPath, "utf8");
    await writeFile(provider, "throw new Error('A provider must never load during replay');");
    await writeFile(config, "throw new Error('A config must never execute during replay');");
    const outputs = join(directory, "outputs"),
      summary = join(directory, "github.md");
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        fence,
        join(testEntries, "cli.js"),
        "report",
        "--replay",
        "--results",
        captured.resultPath,
        "--config",
        config,
        "--output-dir",
        join(directory, "replayed"),
        "--public-labels",
        "true",
        "--github",
      ],
      {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, GITHUB_OUTPUT: outputs, GITHUB_STEP_SUMMARY: summary },
      },
    );
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.ok(
      child.stdout.includes("Replay: recorded evaluation") && !child.stdout.includes("Completed 1"),
    );
    assert.ok(!(child.stdout + child.stderr).includes("PRIVATE_ANSWER"));
    const lines = (await readFile(outputs, "utf8")).trim().split("\n");
    const values: Record<string, string> = {};
    for (let i = 0; i < lines.length; i += 3) values[lines[i].split("<<")[0]] = lines[i + 1];
    assert.equal(values.replayed, "true");
    assert.equal(values["evaluation-status"], "pass");
    assert.equal(values["evaluation-exit-code"], "unknown");
    assert.equal(values["result-path"], captured.resultPath);
    const report = await json(values["report-path"]);
    assert.equal(report.replayed, true);
    delete report.replayed;
    assert.deepEqual(report, captured.report);
    const markdown = await readFile(summary, "utf8");
    assert.ok(markdown.includes("Replay — recorded evaluation") && markdown.includes("$0.2500"));
    assert.ok(!markdown.includes("PRIVATE_ANSWER"));
    assert.equal(await readFile(captured.resultPath, "utf8"), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("recorded assertion failures, provider/grader errors, missing results and zero coverage keep failing while unknown spend stays unknown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp replay gates "));
  try {
    const config = join(directory, "suite.yaml");
    await writeFile(
      config,
      stringify({
        prompts: ["ready"],
        providers: ["echo"],
        tests: [{ assert: [{ type: "equals", value: "wrong" }] }],
      }),
    );
    const captured = await runEvaluation({
      config,
      outputDirectory: join(directory, "capture"),
      args: ["--no-cache"],
    });
    assert.equal(captured.report.status, "fail");
    const document = await json(captured.resultPath);
    const variants = [
      document,
      structuredClone(document),
      structuredClone(document),
      { results: { results: [], stats: { successes: 0, failures: 0, errors: 0 } } },
      {},
    ];
    variants[1].results.results[0].response = { error: "PRIVATE_PROVIDER_ERROR" };
    variants[1].results.results[0].failureReason = 2;
    variants[1].results.stats = { successes: 0, failures: 0, errors: 1 };
    variants[2].results.results[0].gradingResult.metadata = { graderError: true };
    for (let i = 0; i < variants.length; i++) {
      const result = join(directory, `${i}.json`);
      await writeFile(result, JSON.stringify(variants[i]));
      const run = await reportEvaluation(result, join(directory, `out-${i}`), { replay: true });
      assert.equal(run.report.replayed, true);
      assert.equal(run.report.status, i === 0 ? "fail" : "error");
      if (i > 0) assert.equal(run.report.totals.graderCost.usd, null);
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          fence,
          join(testEntries, "cli.js"),
          "report",
          "--replay",
          "--results",
          result,
          "--output-dir",
          join(directory, `cli-${i}`),
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      assert.equal(child.status, 1);
      assert.ok(!child.stdout.includes("PRIVATE_PROVIDER_ERROR"));
    }
    const missing = await reportEvaluation(
      join(directory, "missing.json"),
      join(directory, "missing"),
      { replay: true },
    );
    assert.equal(missing.report.status, "error");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
