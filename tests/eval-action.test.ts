import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { parse, stringify } from "yaml";
import {
  reportEvaluation,
  runEvaluation,
  validateNativeArgs,
} from "../packages/oh-my-promptfoo/src/eval-run";
import type { EvaluationProgress } from "../packages/oh-my-promptfoo/src/reporting";
import { testEntries } from "./global-setup";

const root = resolve(import.meta.dirname, "..");
const provider = `file://${join(import.meta.dirname, "fixtures", "ci-provider.mjs")}`;
const fixture = () => mkdtemp(join(tmpdir(), "omp-native-action-"));
const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));

test("native completion events arrive while another case is blocked, preserve authored hooks and never stream raw output", async () => {
  const directory = await fixture();
  try {
    const config = join(directory, "progress.yaml");
    const releaseFile = join(directory, "release");
    const authoredHook = join(directory, "authored.mjs");
    const marker = join(directory, "authored-events");
    const cliHook = join(directory, "authored cli.mjs"),
      cliMarker = join(directory, "cli-events");
    await writeFile(
      authoredHook,
      `import {appendFileSync} from 'node:fs'; export function afterEach(){appendFileSync(${JSON.stringify(marker)},'x');}`,
    );
    await writeFile(
      cliHook,
      `import {appendFileSync} from 'node:fs'; export function afterEach(){appendFileSync(${JSON.stringify(cliMarker)},'y');}`,
    );
    await writeFile(
      config,
      stringify({
        description: "Public progress suite",
        prompts: ["PRIVATE_ANSWER"],
        providers: [provider],
        extensions: [`file://${authoredHook}:afterEach`],
        tests: [
          { metadata: { suite: "excluded" }, vars: { mode: "throw" } },
          {
            description: "A blocked test",
            metadata: { suite: "kept" },
            vars: { mode: "wait-for-progress", releaseFile },
            assert: [{ type: "equals", value: "PRIVATE_ANSWER" }],
          },
          {
            description: "An immediate pass",
            metadata: { suite: "kept" },
            vars: { mode: "send-noise" },
            assert: [{ type: "equals", value: "PRIVATE_ANSWER" }],
          },
          {
            description: "An assertion failure",
            metadata: { suite: "kept" },
            assert: [{ type: "equals", value: "different" }],
          },
          { description: "A provider error", metadata: { suite: "kept" }, vars: { mode: "error" } },
        ],
      }),
    );
    const events: EvaluationProgress[] = [];
    const run = await runEvaluation({
      config,
      outputDirectory: join(directory, "out"),
      args: [
        "--filter-metadata",
        "suite=kept",
        "--max-concurrency",
        "2",
        "--no-cache",
        "--extension",
        `file://${cliHook}:afterEach`,
      ],
      onProgress(event) {
        events.push(event);
        // A row deliberately cannot finish until a live completion reaches the parent.
        if (events.length === 1) writeFileSync(releaseFile, "released");
      },
    });
    assert.equal(events.length, 4);
    assert.equal(events[0].test, 2);
    assert.ok(
      events.some((e) => e.status === "pass") &&
        events.some((e) => e.status === "fail") &&
        events.some((e) => e.status === "error"),
    );
    assert.ok(events.every((e) => e.column === 1));
    assert.ok(
      !JSON.stringify(events).includes("PRIVATE_") &&
        !JSON.stringify(events).includes("description"),
    );
    assert.equal(await readFile(marker, "utf8"), "xxxx");
    assert.equal(await readFile(cliMarker, "utf8"), "yyyy");
    assert.equal(run.report.status, "error");
    assert.deepEqual(run.report.counts, { pass: 2, fail: 1, error: 1, unknown: 0 });
    assert.ok((await readFile(run.resultPath, "utf8")).includes("PRIVATE_ANSWER"));
    assert.ok((await readFile(run.logPath, "utf8")).length > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("a failed progress callback waits for native process shutdown before returning retained error reports", async () => {
  const directory = await fixture();
  try {
    const config = join(directory, "shutdown.yaml");
    const hook = join(directory, "shutdown.mjs");
    const marker = join(directory, "stopped");
    await writeFile(
      hook,
      `import {writeFileSync} from 'node:fs'; export function beforeAll(){process.removeAllListeners('SIGTERM');process.once('SIGTERM',()=>setTimeout(()=>{writeFileSync(${JSON.stringify(marker)},'stopped');process.exit(0);},200));}`,
    );
    await writeFile(
      config,
      stringify({
        prompts: ["private"],
        providers: [provider],
        extensions: [`file://${hook}:beforeAll`],
        tests: [
          { assert: [{ type: "equals", value: "private" }] },
          {
            vars: { mode: "wait-for-progress", releaseFile: join(directory, "never") },
            assert: [{ type: "equals", value: "private" }],
          },
        ],
      }),
    );
    let calls = 0;
    const run = await runEvaluation({
      config,
      outputDirectory: join(directory, "out"),
      args: ["--max-concurrency", "2", "--no-cache"],
      onProgress() {
        calls++;
        throw new Error("Progress callback failed");
      },
    });
    assert.equal(calls, 1);
    assert.equal(await readFile(marker, "utf8"), "stopped");
    assert.equal(run.report.status, "error");
    assert.ok(existsSync(run.logPath) && existsSync(run.reportPath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("native comparison assertions remain pending in live progress until the final export decides their verdict", async () => {
  const directory = await fixture();
  try {
    const config = join(directory, "comparison.yaml");
    await writeFile(
      config,
      stringify({
        prompts: ["good", "other"],
        providers: [provider],
        tests: [
          {
            assert: [
              {
                type: "javascript",
                value:
                  "output === 'good' ? {pass:true,score:1,reason:'fixture high'} : {pass:true,score:0.5,reason:'fixture low'}",
              },
              { type: "max-score" },
            ],
          },
        ],
      }),
    );
    const events: EvaluationProgress[] = [];
    const run = await runEvaluation({
      config,
      outputDirectory: join(directory, "out"),
      args: ["--no-cache"],
      onProgress: (event) => events.push(event),
    });
    assert.equal(events.length, 2);
    assert.ok(events.every((event) => event.status === "pending"));
    assert.equal(run.report.counts.pass, 1);
    assert.equal(run.report.counts.fail, 1);
    assert.equal(run.report.status, "fail");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("Action setup resolves its own manifest and Node pin from a different caller checkout", async () => {
  const directory = await fixture();
  try {
    const action = parse(await readFile(join(root, "action.yml"), "utf8"));
    const step = action.runs.steps.find((item: any) => item.id === "toolchain");
    const output = join(directory, "toolchain-outputs");
    const child = spawnSync("bash", ["-e", "-c", step.run], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_WORKSPACE: directory,
        GITHUB_OUTPUT: output,
        OMP_ACTION_PATH: root,
      },
    });
    assert.equal(child.status, 0, child.stderr);
    const values = Object.fromEntries(
      (await readFile(output, "utf8"))
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
    assert.equal((await json(resolve(directory, values.manifest))).packageManager, "pnpm@10.34.7");
    assert.equal(
      (await readFile(resolve(directory, values["node-version-file"]), "utf8")).trim(),
      "22.22.1",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native argument boundaries reserve config, output and execution ownership", () => {
  validateNativeArgs([
    "--filter-metadata",
    "kind=a b",
    "--filter-metadata",
    "kind=c",
    "--var",
    "literal=$(touch secret)",
  ]);
  for (const args of [
    null,
    "--filter-sample 1",
    [1],
    ["--config=x"],
    ["-cother.yaml"],
    ["-oother.json"],
    ["--output", "elsewhere"],
    ["--share"],
    ["--resume"],
    ["--retry-errors"],
    ["--watch"],
    ["--"],
    ["--help"],
  ])
    assert.throws(() => validateNativeArgs(args));
});

test("the authored local release suite reports zero model usage and restarts test numbering within its card", async () => {
  const directory = await fixture();
  try {
    const run = await runEvaluation({
      config: join(root, "examples/ci/release.yaml"),
      outputDirectory: directory,
      suiteNumber: 9,
      publicLabels: true,
      args: [
        "--filter-metadata",
        "suite=required",
        "--filter-metadata",
        "language=latin",
        "--no-cache",
      ],
    });
    assert.equal(run.report.status, "pass");
    assert.equal(run.report.counts.pass, 4);
    for (const item of [run.report.totals, ...run.report.cases]) {
      assert.equal(item.candidateCost.usd, 0);
      assert.equal(item.candidateUsage.total, 0);
      assert.equal(item.candidateUsage.requests, 0);
      assert.equal(item.graderCost.usd, 0);
    }
    const markdown = await readFile(run.summaryPath, "utf8");
    assert.ok(markdown.includes("Suite 9 · Required name-normalization release regression"));
    assert.ok(markdown.includes("Local text normalizer \\(no model\\)"));
    assert.ok(markdown.includes("| Test 1 · Preserve a single name |"));
    assert.ok(markdown.includes("<summary>Test 4 · Empty input stays empty"));
    assert.ok(!markdown.includes("Test 9."));
    assert.ok(!markdown.includes("| unknown") && !markdown.includes("unknown |"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("offline CLI reports redact config-only and ambient credentials from persisted public labels", async () => {
  const directory = await fixture();
  try {
    const configured = "config-only-credential-canary";
    const ambient = "ambient-only-credential-canary";
    const nested = "nested-credential-canary";
    const description = `Public task ${configured} ${ambient} ${nested}`;
    const native = join(directory, "native.json");
    const content = JSON.stringify({
      config: {
        description,
        env: { OPENAI_API_KEY: configured },
        providers: [{ config: { delegate: { env: { CUSTOM_AUTH: nested } } } }],
      },
      results: {
        stats: { successes: 1, failures: 0, errors: 0 },
        results: [
          {
            success: true,
            score: 1,
            failureReason: 0,
            testIdx: 0,
            promptIdx: 0,
            testCase: { description },
            provider: { label: description },
            response: { output: "PRIVATE_ANSWER" },
            gradingResult: {
              pass: true,
              score: 1,
              componentResults: [
                {
                  pass: true,
                  score: 1,
                  reason: "PRIVATE_REASON",
                  assertion: { type: configured, metric: description },
                },
              ],
            },
          },
        ],
      },
    });
    await writeFile(native, content);
    const env: NodeJS.ProcessEnv = { ...process.env, OMP_AMBIENT_API_KEY: ambient };
    delete env.OPENAI_API_KEY;
    for (const publicLabels of ["false", "true"]) {
      const child = spawnSync(
        process.execPath,
        [
          join(testEntries, "cli.js"),
          "report",
          "--results",
          native,
          "--output-dir",
          join(directory, `report-${publicLabels}`),
          "--public-labels",
          publicLabels,
        ],
        { encoding: "utf8", env, timeout: 30_000 },
      );
      assert.equal(child.status, 0, child.stdout + child.stderr);
      const paths = JSON.parse(child.stdout.trim().split("\n").at(-1)!);
      const report = await readFile(paths.reportPath, "utf8");
      const markdown = await readFile(paths.summaryPath, "utf8");
      for (const output of [child.stdout, child.stderr, report, markdown])
        for (const value of [configured, ambient, nested, "PRIVATE_ANSWER", "PRIVATE_REASON"])
          assert.ok(!output.includes(value));
      assert.equal(JSON.parse(report).totals.candidateCost.usd, null);
      if (publicLabels === "true") assert.ok(markdown.includes("Public task"));
    }
    assert.equal(await readFile(native, "utf8"), content);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real native CSV selection preserves repeated filters, regex, range, seeded samples and literal values", async () => {
  const directory = await fixture();
  try {
    const csv =
      "input,__description,__metadata:suite,__metadata:region,__expected\n" +
      [
        "one,kept case one,regression,au,contains:one",
        "two,kept case two,regression,au,contains:two",
        "three,excluded unit case,unit,au,contains:three",
        "four,excluded region case,regression,us,contains:four",
      ].join("\n");
    await writeFile(join(directory, "cases.csv"), csv);
    await writeFile(
      join(directory, "suite.yaml"),
      stringify({
        prompts: ["{{input}} {{literal}}"],
        providers: [
          { id: provider, label: "baseline" },
          { id: provider, label: "candidate" },
        ],
        tests: "file://cases.csv",
      }),
    );
    const marker = join(directory, "must-not-exist");
    const literal = `spaces $(touch ${marker}); "quoted"`;
    const args = [
      "--filter-metadata",
      "suite=unit,regression",
      "--filter-metadata",
      "suite=regression",
      "--filter-metadata",
      "region=au",
      "--filter-pattern",
      "kept case",
      "--filter-range",
      "0:2",
      "--filter-sample",
      "1",
      "--filter-sample-seed",
      "42",
      "--var",
      `literal=${literal}`,
      "--no-cache",
    ];
    const selected: string[] = [];
    for (const label of ["baseline", "baseline", "candidate"]) {
      const run = await runEvaluation({
        config: "suite.yaml",
        workingDirectory: directory,
        outputDirectory: "out",
        args: [...args, "--filter-providers", `^${label}$`],
        suiteNumber: 3,
        publicLabels: true,
      });
      assert.equal(run.report.status, "pass", await readFile(run.logPath, "utf8"));
      assert.equal(run.report.counts.pass, 1);
      assert.equal(run.report.suite?.number, 3);
      assert.ok(run.report.cases[0].label?.startsWith("kept case"));
      const summary = await readFile(run.summaryPath, "utf8");
      assert.ok(summary.includes("Test 1 · kept case") && !summary.includes("excluded"));
      const rows = (await json(run.resultPath)).results.results;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].provider.label, label);
      assert.ok(rows[0].response.output.includes(literal));
      selected.push(rows[0].testCase.description);
      assert.equal(run.report.totals.candidateCost.usd, null);
      assert.equal(run.report.totals.graderCost.usd, 0);
      assert.equal(run.report.totals.graderUsage.requests, 0);
    }
    assert.ok(selected.every((value) => value === selected[0] && value.startsWith("kept case")));
    assert.equal(existsSync(marker), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("real native failures/errors retain exports, and reporting/missing coverage never become a passing gate", async () => {
  const directory = await fixture();
  try {
    const config = join(directory, "suite.yaml");
    await writeFile(
      config,
      stringify({
        prompts: ["PRIVATE_ANSWER"],
        providers: [provider],
        tests: [
          { vars: { mode: "pass" }, assert: [{ type: "equals", value: "PRIVATE_ANSWER" }] },
          { vars: { mode: "fail" }, assert: [{ type: "equals", value: "different" }] },
          { vars: { mode: "error" } },
          { vars: { mode: "throw" } },
        ],
      }),
    );
    const run = await runEvaluation({
      config,
      outputDirectory: join(directory, "out"),
      args: ["--no-cache"],
    });
    assert.equal(run.report.status, "error");
    assert.deepEqual(run.report.counts, { pass: 1, fail: 1, error: 2, unknown: 0 });
    assert.equal(run.resultsAvailable, true);
    assert.ok((await readFile(run.resultPath, "utf8")).includes("PRIVATE_ANSWER"));
    assert.ok(!(await readFile(run.summaryPath, "utf8")).includes("PRIVATE_"));
    const reread = await reportEvaluation(run.resultPath, join(directory, "report"));
    assert.equal(reread.report.status, "error");
    const empty = await runEvaluation({
      config,
      outputDirectory: join(directory, "out"),
      args: ["--filter-pattern", "no match"],
    });
    assert.equal(empty.report.status, "error");
    assert.notEqual(empty.resultPath, run.resultPath);
    const missing = await runEvaluation({
      config: join(directory, "missing.yaml"),
      outputDirectory: join(directory, "out"),
    });
    assert.equal(missing.report.status, "error");
    assert.equal(missing.resultsAvailable, false);
    assert.ok(existsSync(missing.summaryPath));
    const invalid = await runEvaluation({
      config,
      outputDirectory: join(directory, "out"),
      args: ["--not-a-native-switch"],
    });
    assert.equal(invalid.report.status, "error");
    assert.ok(existsSync(invalid.logPath));
    const assertionOnly = await runEvaluation({
      config,
      outputDirectory: join(directory, "out"),
      args: ["--filter-range", "1:2", "--no-cache"],
    });
    assert.equal(assertionOnly.exitCode, 100);
    assert.equal(assertionOnly.report.status, "fail");
    assert.equal(assertionOnly.resultsAvailable, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("the actual Action shell step runs native CLI, sets outputs on failure and publishes only sanitized summary", async () => {
  const directory = await fixture();
  try {
    // Use exactly the same bundled CLI as the shipped Action; the global setup
    // builds it separately so tests never depend on a pre-existing dist directory.
    const action = parse(await readFile(join(root, "action.yml"), "utf8"));
    const step = action.runs.steps.find((item: any) => item.id === "evaluate");
    const actionRoot = join(directory, "action with spaces");
    const dist = join(actionRoot, "packages", "oh-my-promptfoo", "dist");
    await mkdir(resolve(dist, ".."), { recursive: true });
    await symlink(testEntries, dist, process.platform === "win32" ? "junction" : "dir");
    const config = join(directory, "native suite.yaml");
    await writeFile(
      config,
      stringify({
        prompts: ["PRIVATE_ANSWER"],
        providers: [provider],
        sharing: true,
        description: "Public Action regression",
        outputPath: join(directory, "must-not-write.json"),
        tests: [
          {
            description: "Reject a wrong answer",
            assert: [{ type: "equals", value: "not the answer" }],
          },
        ],
      }),
    );
    const outputs = join(directory, "outputs"),
      summary = join(directory, "summary");
    const result = spawnSync("bash", ["-e", "-c", step.run], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        OMP_ACTION_PATH: actionRoot,
        OMP_CONFIG: config,
        OMP_ARGS: '["--no-cache"]',
        OMP_WORKING_DIRECTORY: directory,
        OMP_OUTPUT_DIRECTORY: "private outputs",
        OMP_SUITE_NUMBER: "7",
        OMP_PUBLIC_LABELS: "true",
        GITHUB_OUTPUT: outputs,
        GITHUB_STEP_SUMMARY: summary,
        LOG_LEVEL: "debug",
        PROMPTFOO_DISABLE_TELEMETRY: "1",
        PROMPTFOO_DISABLE_UPDATE: "1",
      },
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /Suite 7 · Completed 1 · native test 1, column 1 · FAIL/);
    assert.match(result.stdout, /Test 1 · Reject a wrong answer · FAIL/);
    assert.match(result.stdout, /Grader: 0 tokens · 0 requests; cost: \$0\.00/);
    assert.ok(!result.stdout.includes("PRIVATE_") && !result.stderr.includes("PRIVATE_"));
    const values: Record<string, string> = {};
    const lines = (await readFile(outputs, "utf8")).trim().split("\n");
    for (let index = 0; index < lines.length; index += 3)
      values[lines[index].split("<<")[0]] = lines[index + 1];
    assert.equal(values["evaluation-status"], "fail");
    assert.equal(values["evaluation-exit-code"], "100");
    assert.equal(values["results-available"], "true");
    assert.ok(existsSync(values["result-path"]));
    assert.ok(existsSync(values["log-path"]));
    assert.ok((await readFile(values["result-path"], "utf8")).includes("PRIVATE_ANSWER"));
    assert.equal(existsSync(join(directory, "must-not-write.json")), false);
    const markdown = await readFile(summary, "utf8");
    assert.ok(markdown.includes("| Failed | 1 |") && markdown.includes("unknown"));
    assert.ok(markdown.includes("Suite 7 · Public Action regression"));
    assert.equal((markdown.match(/Test 1 · Reject a wrong answer/g) ?? []).length, 2);
    const local = await reportEvaluation(values["result-path"], join(directory, "local-report"), {
      suiteNumber: 8,
      publicLabels: true,
    });
    assert.ok(
      (await readFile(local.summaryPath, "utf8")).includes("Test 1 · Reject a wrong answer"),
    );
    assert.ok(!markdown.includes("PRIVATE_") && !markdown.includes("http"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("real package grader failures stay errors even when native score policy tolerates the failed assertion", async () => {
  const directory = await fixture();
  try {
    const config = join(directory, "grader.yaml");
    await writeFile(
      config,
      stringify({
        prompts: ["PRIVATE_ANSWER"],
        providers: ["echo"],
        defaultTest: { options: { provider: { id: provider, config: { mode: "grader-error" } } } },
        tests: [
          {
            threshold: 0,
            assert: [
              { type: "contains", value: "PRIVATE_ANSWER" },
              {
                type: "javascript",
                value: `file://${join(testEntries, "assertions.js")}:llmAssert`,
                config: { components: [{ metric: "accuracy", value: "Is accurate" }] },
              },
            ],
          },
        ],
      }),
    );
    const run = await runEvaluation({
      config,
      outputDirectory: join(directory, "out"),
      args: ["--no-cache"],
    });
    assert.equal(run.resultsAvailable, true, await readFile(run.logPath, "utf8"));
    const native = (await json(run.resultPath)).results.results[0];
    assert.equal(native.success, true);
    assert.equal(run.report.status, "error");
    assert.equal(run.report.totals.graderCost.usd, null);
    assert.equal(run.report.totals.graderUsage.total, null);
    assert.ok(run.report.cases[0].assertions.some((item) => item.status === "error"));
    assert.ok(!(await readFile(run.summaryPath, "utf8")).includes("PRIVATE_"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
