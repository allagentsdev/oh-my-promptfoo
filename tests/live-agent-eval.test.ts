import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { parse, stringify } from "yaml";

const { default: checkArtifact } = await import(
  new URL("../packages/oh-my-promptfoo/evals/live/check-artifact.mjs", import.meta.url).href
);
const { checkLiveAgentEval, liveConfig, requireFreeModel } = await import(
  new URL("../scripts/check-live-agent-eval.mjs", import.meta.url).href
);

const model = "cohere/north-mini-code:free";
const entry = {
  id: model,
  pricing: { prompt: "0", completion: "0" },
  supported_parameters: ["tools"],
};

test("live preflight accepts the actual pinned free candidate and grader without sending credentials", async () => {
  let requests = 0;
  const models = await checkLiveAgentEval({
    env: { OPENROUTER_API_KEY: "private-fixture-key" },
    fetcher: async (url: string, options: RequestInit) => {
      requests++;
      assert.equal(url, "https://openrouter.ai/api/v1/models");
      assert.equal(JSON.stringify(options).includes("private-fixture-key"), false);
      return Response.json({ data: [entry] });
    },
  });
  assert.deepEqual(models, [model]);
  assert.equal(requests, 1);
});

test("live preflight rejects paid, missing, unpriced or non-tool models", () => {
  assert.doesNotThrow(() => requireFreeModel(model, [entry]));
  for (const candidate of [
    { ...entry, id: "paid/model" },
    { ...entry, pricing: { prompt: "0.1", completion: "0" } },
    { ...entry, pricing: { prompt: "0", completion: "" } },
    { ...entry, pricing: { prompt: "0", completion: "0", request: "1" } },
    { ...entry, supported_parameters: [] },
  ])
    assert.throws(() => requireFreeModel(candidate.id, [candidate]));
  assert.throws(() => requireFreeModel(model, []));
});

test("live preflight blocks absent secrets, catalog errors and a paid grader", async () => {
  const env = { OPENROUTER_API_KEY: "private-fixture-key" };
  await assert.rejects(checkLiveAgentEval({ env: {} }), /OPENROUTER_API_KEY/);
  await assert.rejects(
    checkLiveAgentEval({ env, fetcher: async () => new Response(null, { status: 503 }) }),
    /availability/,
  );
  const directory = await mkdtemp(join(tmpdir(), "omp-live-preflight-"));
  try {
    const config = parse(await readFile(liveConfig, "utf8"));
    config.defaultTest.assert.at(-1).config.grader.config.model = "paid/model";
    const configPath = join(directory, "suite.yaml");
    await writeFile(configPath, stringify(config));
    await assert.rejects(
      checkLiveAgentEval({
        env,
        configPath,
        fetcher: async () => Response.json({ data: [entry] }),
      }),
      /free model/,
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
