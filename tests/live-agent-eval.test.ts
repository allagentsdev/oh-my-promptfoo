import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { parse, stringify } from "yaml";
import { runEvaluation } from "../packages/oh-my-promptfoo/src/eval-run";

const { default: checkArtifact } = await import(
  new URL("../packages/oh-my-promptfoo/evals/live/check-artifact.mjs", import.meta.url).href
);
const { checkLiveAgentEval, liveConfig, requireAvailableModel } = await import(
  new URL("../scripts/check-live-agent-eval.mjs", import.meta.url).href
);

const model = "deepseek/deepseek-v4.1-flash";
const env = { OPENROUTER_API_KEY: "private-fixture-key", OPENROUTER_MODEL: model };
const entry = {
  id: model,
  supported_parameters: ["tools"],
};

test("native evaluation keeps the authored six tasks and expected argument arrays intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp-live-cardinality-"));
  try {
    const config = parse(await readFile(liveConfig, "utf8"));
    // Exercise native case expansion without making agent or grader requests.
    config.providers = ["echo"];
    config.defaultTest.assert = [
      {
        type: "javascript",
        value:
          "Array.isArray(context.vars.expected) === context.vars.artifact.endsWith('args.json')",
      },
    ];
    const configPath = join(directory, "suite.yaml");
    await writeFile(configPath, stringify(config));
    const run = await runEvaluation({
      config: configPath,
      outputDirectory: join(directory, "results"),
      args: ["--no-cache", "--max-concurrency", "1"],
    });
    assert.equal(run.report.status, "pass");
    assert.equal(run.report.cases.length, 6);
    const native = JSON.parse(await readFile(run.resultPath, "utf8"));
    assert.deepEqual(
      native.results.results.map((row: any) => row.testCase.vars.expected),
      config.tests.map((row: any) => row.vars.expected),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test("live preflight accepts the configured candidate and grader without sending credentials", async () => {
  let requests = 0;
  for (const selected of [model, "google/gemma-4-31b-it:free"]) {
    const models = await checkLiveAgentEval({
      env: { ...env, OPENROUTER_MODEL: selected },
      fetcher: async (url: string, options: RequestInit) => {
        requests++;
        assert.equal(url, "https://openrouter.ai/api/v1/models");
        assert.equal(JSON.stringify(options).includes("private-fixture-key"), false);
        return Response.json({ data: [{ ...entry, id: selected }] });
      },
    });
    assert.deepEqual(models, [selected]);
  }
  assert.equal(requests, 2);
});

test("live preflight accepts paid models and rejects missing or non-tool models", () => {
  assert.doesNotThrow(() => requireAvailableModel(model, [entry]));
  assert.throws(() => requireAvailableModel(model, [{ ...entry, supported_parameters: [] }]));
  assert.throws(() => requireAvailableModel(model, []));
  assert.throws(() => requireAvailableModel("", [entry]));
});

test("live preflight blocks absent settings, catalog errors, unsupported models and a mismatched grader", async () => {
  await assert.rejects(checkLiveAgentEval({ env: {} }), /OPENROUTER_API_KEY/);
  await assert.rejects(
    checkLiveAgentEval({ env: { OPENROUTER_API_KEY: "private-fixture-key" } }),
    /OPENROUTER_MODEL/,
  );
  await assert.rejects(
    checkLiveAgentEval({ env, fetcher: async () => new Response(null, { status: 503 }) }),
    /availability/,
  );
  const unsupported = "fixture/not-in-pinned-sdk";
  await assert.rejects(
    checkLiveAgentEval({
      env: { ...env, OPENROUTER_MODEL: unsupported },
      fetcher: async () => Response.json({ data: [{ ...entry, id: unsupported }] }),
    }),
    /pinned Pi SDK/,
  );
  const directory = await mkdtemp(join(tmpdir(), "omp-live-preflight-"));
  try {
    const config = parse(await readFile(liveConfig, "utf8"));
    config.defaultTest.assert.at(-1).config.grader.config.model = "different/model";
    const configPath = join(directory, "suite.yaml");
    await writeFile(configPath, stringify(config));
    await assert.rejects(
      checkLiveAgentEval({
        env,
        configPath,
        fetcher: async () => Response.json({ data: [entry] }),
      }),
      /both use the OPENROUTER_MODEL variable/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("authored artifact checks accept correct files and reject wrong content, narration and incomplete capture", async () => {
  const config = parse(await readFile(liveConfig, "utf8"));
  for (const { vars } of config.tests) {
    const content =
      vars.format === "json" ? JSON.stringify(vars.expected) : stringify(vars.expected);
    const context = {
      vars,
      providerResponse: {
        metadata: {
          fileChanges: {
            status: "complete",
            changedFiles: {
              [vars.artifact]: { kind: "file", content: Buffer.from(content).toString("base64") },
            },
          },
        },
      },
    };
    assert.equal(checkArtifact("I did it", context).pass, true);
    context.providerResponse.metadata.fileChanges.changedFiles[vars.artifact].content =
      Buffer.from('{"wrong":true}').toString("base64");
    assert.equal(checkArtifact(content, context).pass, false);
    context.providerResponse.metadata.fileChanges.changedFiles[vars.artifact].content =
      Buffer.from(content).toString("base64");
    context.providerResponse.metadata.fileChanges.status = "incomplete";
    assert.equal(checkArtifact(content, context).pass, false);
    assert.equal(checkArtifact(content, { vars }).pass, false);
  }
});

test("invoice review grades captured findings, rejects false positives and preserves the three authored cases", async () => {
  const suiteUrl = new URL(
    "../packages/oh-my-promptfoo/evals/code-review/promptfooconfig.yaml",
    import.meta.url,
  );
  const config = parse(await readFile(suiteUrl, "utf8"));
  const { default: check } = await import(
    new URL("../packages/oh-my-promptfoo/evals/code-review/check-findings.mjs", import.meta.url)
      .href
  );
  for (const { vars } of config.tests) {
    const findings = vars.expectedFindings.map((item: any) => ({
      ...item,
      summary: "The access rule is incomplete",
      reproduction: "An unauthorized user can read an invoice",
      fix: "Require tenant equality and the billing role",
    }));
    const context = {
      vars,
      providerResponse: {
        metadata: {
          fileChanges: {
            status: "complete",
            deletedFiles: [] as string[],
            changedFiles: {
              "review.json": {
                kind: "file",
                content: Buffer.from(JSON.stringify({ findings })).toString("base64"),
              },
            },
          },
        },
      },
    };
    assert.equal(check("Narration is not evidence", context).pass, true);
    context.providerResponse.metadata.fileChanges.deletedFiles.push("source/other-fixture.mjs");
    assert.equal(check("I left the source unchanged", context).pass, false);
    context.providerResponse.metadata.fileChanges.deletedFiles.length = 0;
    context.providerResponse.metadata.fileChanges.changedFiles["review.json"].content = Buffer.from(
      JSON.stringify({
        findings: [
          {
            line: 99,
            severity: "low",
            summary: "A claimed defect",
            reproduction: "A concrete but unrelated example",
            fix: "A proposed change",
          },
        ],
      }),
    ).toString("base64");
    assert.equal(check("Looks good", context).pass, false);
    if (vars.expectedFindings.length === 0) {
      context.providerResponse.metadata.fileChanges.changedFiles["review.json"].content =
        Buffer.from(
          JSON.stringify({
            findings: [
              {
                line: 2,
                severity: "high",
                summary: "Missing tenant check",
                reproduction: "An invoice in another tenant is readable",
                fix: "Require tenant equality",
              },
            ],
          }),
        ).toString("base64");
      assert.equal(check("A plausible false positive", context).pass, false);
    }
    assert.equal(check("I wrote a review", { vars }).pass, false);
  }
  assert.deepEqual(
    await checkLiveAgentEval({
      configPath: suiteUrl,
      env,
      fetcher: async () => Response.json({ data: [entry] }),
    }),
    [model],
  );
  const directory = await mkdtemp(join(tmpdir(), "omp-review-cardinality-"));
  try {
    config.providers = ["echo"];
    config.defaultTest.assert = [
      { type: "javascript", value: "Array.isArray(context.vars.expectedFindings)" },
    ];
    config.prompts = ["Offline case expansion"];
    const path = join(directory, "suite.yaml");
    await writeFile(path, stringify(config));
    const run = await runEvaluation({
      config: path,
      outputDirectory: join(directory, "out"),
      args: ["--no-cache"],
    });
    assert.equal(run.report.status, "pass");
    assert.equal(run.report.cases.length, 3);
    const rows = JSON.parse(await readFile(run.resultPath, "utf8")).results.results;
    assert.deepEqual(
      rows.map((item: any) => item.testCase.vars.expectedFindings),
      config.tests.map((item: any) => item.vars.expectedFindings),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
