import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, vi } from "vitest";
import { parse, stringify } from "yaml";
import { runEvaluation } from "../packages/oh-my-promptfoo/src/eval-run";
import { testEntries } from "./global-setup";

const root = resolve(import.meta.dirname, "..");
const provider = `file://${join(import.meta.dirname, "fixtures", "ci-provider.mjs")}`;
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

test("native required values that look like flags keep their original argument positions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-flag-values-"));
  try {
    const config = join(directory, "suite.yaml");
    await writeFile(
      config,
      stringify({
        prompts: ["ready"],
        providers: ["echo"],
        tests: [{ description: "-case", assert: [{ type: "equals", value: "ready" }] }],
      }),
    );
    for (const description of ["--config", "-hello"]) {
      const run = await runEvaluation({
        config,
        outputDirectory: join(directory, "out"),
        args: ["--filter-pattern", "-case", "--description", description, "--no-cache"],
      });
      assert.equal(run.report.status, "pass", await readFile(run.logPath, "utf8"));
      assert.equal(run.report.counts.pass, 1);
      assert.equal(
        (await readJson(run.resultPath)).results.results[0].testCase.description,
        "-case",
      );
    }
    for (const args of [
      ["--no-cache", "--config", config],
      ["--no-cache", "-c", config],
      ["--no-cache", "--output", "elsewhere.json"],
      ["--description"],
    ]) {
      const rejected = await runEvaluation({
        config,
        outputDirectory: join(directory, "out"),
        args,
      });
      assert.equal(rejected.report.status, "error");
      assert.equal(rejected.resultsAvailable, false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("private argument files reach native evaluation without entering Action inputs, env preamble or public output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-private-args-"));
  try {
    const secret = "PRIVATE_ARGUMENT_AND_ANSWER";
    const config = join(directory, "suite.yaml"),
      argsFile = join(directory, "native-args.json");
    await writeFile(
      config,
      stringify({
        prompts: ["{{private_value}}"],
        providers: ["echo"],
        tests: [{ description: "-case", assert: [{ type: "equals", value: secret }] }],
      }),
    );
    await writeFile(
      argsFile,
      JSON.stringify([
        "--var",
        `private_value=${secret}`,
        "--filter-pattern",
        "-case",
        "--no-cache",
      ]),
      { mode: 0o600 },
    );
    const action = parse(await readFile(join(root, "action.yml"), "utf8"));
    const step = action.runs.steps.find((value: any) => value.id === "evaluate");
    const actionRoot = join(directory, "action");
    const dist = join(actionRoot, "packages", "oh-my-promptfoo", "dist");
    await mkdir(resolve(dist, ".."), { recursive: true });
    await symlink(testEntries, dist, process.platform === "win32" ? "junction" : "dir");
    const outputs = join(directory, "outputs"),
      summary = join(directory, "summary");
    const input = {
      config,
      "args-json": "[]",
      "args-file": argsFile,
      "working-directory": directory,
      "output-directory": "out",
    };
    const actionEnv: Record<string, string> = Object.fromEntries(
      Object.entries(step.env).map(([key, expression]) => [
        key,
        String(expression)
          .replace(/\$\{\{ inputs\.([\w-]+) \}\}/g, (_, name: keyof typeof input) => input[name])
          .replace(/\$\{\{ github\.action_path \}\}/g, actionRoot),
      ]),
    );
    // The runner prints these input/env values before the script can mask anything.
    assert.ok(!JSON.stringify({ input, actionEnv }).includes(secret));
    const child = spawnSync("bash", ["-e", "-c", step.run], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, ...actionEnv, GITHUB_OUTPUT: outputs, GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.ok(!(child.stdout + child.stderr + (await readFile(summary, "utf8"))).includes(secret));
    const lines = (await readFile(outputs, "utf8")).trim().split("\n");
    const values: Record<string, string> = {};
    for (let index = 0; index < lines.length; index += 3)
      values[lines[index].split("<<")[0]] = lines[index + 1];
    assert.equal(values["evaluation-status"], "pass");
    assert.equal(
      (await readJson(values["result-path"])).results.results[0].response.output,
      secret,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("native suite pass-rate policy tolerates assertion failures while provider errors still fail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-native-policy-"));
  try {
    const config = join(directory, "suite.yaml");
    const suite = {
      prompts: ["ready"],
      providers: [provider],
      tests: [
        { assert: [{ type: "equals", value: "ready" }] },
        { assert: [{ type: "equals", value: "different" }] },
      ] as any[],
    };
    await writeFile(config, stringify(suite));
    vi.stubEnv("PROMPTFOO_PASS_RATE_THRESHOLD", "50");
    const allowed = await runEvaluation({
      config,
      outputDirectory: join(directory, "out"),
      args: ["--no-cache"],
    });
    assert.equal(allowed.exitCode, 0);
    assert.equal(allowed.report.status, "pass");
    assert.equal(allowed.report.counts.fail, 1);
    assert.equal(allowed.resultsAvailable, true);
    vi.stubEnv("PROMPTFOO_PASS_RATE_THRESHOLD", "0");
    suite.tests.push({ vars: { mode: "error" } });
    await writeFile(config, stringify(suite));
    const error = await runEvaluation({
      config,
      outputDirectory: join(directory, "out"),
      args: ["--no-cache"],
    });
    assert.equal(error.report.status, "error");
    assert.equal(error.report.counts.error, 1);
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
