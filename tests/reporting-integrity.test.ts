import assert from "node:assert/strict";
import { test } from "vitest";
import { renderSummary, summarizeEvaluation } from "../packages/oh-my-promptfoo/src/reporting";

const { default: checkArtifact } = await import(
  new URL("../packages/oh-my-promptfoo/evals/live/check-artifact.mjs", import.meta.url).href
);

const row = {
  success: true,
  failureReason: 0,
  score: 1,
  testIdx: 0,
  promptIdx: 0,
  response: { output: "answer" },
};

test("known local native assertions establish zero grader spend while missing or custom grading stays unknown", () => {
  const equals = { pass: true, score: 1, assertion: { type: "equals" } };
  const summarize = (gradingResult: unknown) =>
    summarizeEvaluation({
      results: {
        stats: { successes: 1, failures: 0, errors: 0 },
        results: [
          {
            ...row,
            latencyMs: 10,
            response: {
              output: "answer",
              cost: 0.02,
              tokenUsage: { total: 20, prompt: 15, completion: 5 },
            },
            gradingResult,
          },
        ],
      },
    });
  const report = summarize({ pass: true, score: 1, componentResults: [equals] });
  assert.equal(report.totals.graderCost.usd, 0);
  assert.equal(report.totals.graderUsage.total, 0);
  assert.equal(report.totals.graderUsage.requests, 0);
  assert.ok(renderSummary(report).includes("| 10 ms | 20 | $0.02 | ✅ PASS | 1 / 1 |"));
  for (const gradingResult of [
    undefined,
    { pass: true, score: 1, componentResults: [] },
    { componentResults: [{ assertion: { type: "javascript" }, componentResults: [equals] }] },
    {
      componentResults: [
        { metadata: { assertionSet: { type: "assert-set" } }, componentResults: [] },
      ],
    },
  ]) {
    const unknown = summarize(gradingResult);
    assert.equal(unknown.totals.graderCost.usd, null);
    assert.equal(unknown.totals.graderUsage.total, null);
  }
});

test("local skill and artifact checks preserve the workspace grader's reported usage and cost", () => {
  const local = checkArtifact("unused", {
    vars: { artifact: "answer.json", format: "json", expected: { ready: true } },
    providerResponse: {
      metadata: {
        fileChanges: {
          status: "complete",
          changedFiles: {
            "answer.json": {
              kind: "file",
              content: Buffer.from('{"ready":true}').toString("base64"),
            },
          },
        },
      },
    },
  });
  const components = [
    { pass: true, score: 1, assertion: { type: "skill-used" } },
    { ...local, assertion: { type: "javascript" } },
    {
      pass: true,
      score: 1,
      assertion: { type: "javascript" },
      tokensUsed: { total: 9, prompt: 7, completion: 2, numRequests: 1, cost: 0.01 },
      metadata: { judgeAccounting: { version: 1, attempts: [{ cached: false }] } },
    },
  ];
  const summarize = (componentResults: unknown[]) =>
    summarizeEvaluation({
      results: {
        stats: { successes: 1, failures: 0, errors: 0 },
        results: [
          {
            ...row,
            gradingResult: { pass: true, score: 1, componentResults },
          },
        ],
      },
    });
  const report = summarize(components);
  assert.equal(report.totals.graderUsage.total, 9);
  assert.equal(report.totals.graderUsage.requests, 1);
  assert.equal(report.totals.graderCost.usd, 0.01);
  const unmeasured = summarize([
    ...components,
    {
      pass: true,
      score: 1,
      assertion: { type: "javascript" },
    },
  ]);
  assert.equal(unmeasured.totals.graderCost.usd, null);
  assert.equal(unmeasured.totals.graderUsage.total, null);
});

test("contradictory native counters cannot be tolerated by a zero exit", () => {
  assert.equal(
    summarizeEvaluation(
      { results: { results: [row], stats: { successes: 0, failures: 1, errors: 0 } } },
      0,
    ).status,
    "error",
  );
});

test("an incomplete or interrupted run cannot present measured prefix spend as a complete total", () => {
  const measured = {
    ...row,
    latencyMs: 20,
    response: { output: "answer", cost: 0.1, tokenUsage: { total: 5, prompt: 3, completion: 2 } },
  };
  for (const [successes, exitCode] of [
    [2, 0],
    [1, 1],
  ]) {
    const report = summarizeEvaluation(
      { results: { results: [measured], stats: { successes, failures: 0, errors: 0 } } },
      exitCode,
    );
    assert.equal(report.status, "error");
    assert.equal(report.cases[0].candidateCost.usd, 0.1);
    assert.equal(report.cases[0].candidateUsage.total, 5);
    assert.equal(report.totals.candidateCost.usd, null);
    assert.equal(report.totals.graderCost.usd, null);
    assert.equal(report.totals.candidateUsage.total, null);
    assert.equal(report.totals.graderUsage.total, null);
    assert.equal(report.totals.latencyMs, null);
  }
});

test("an answering cache hit does not erase the cost of earlier uncached judge attempts", () => {
  const report = summarizeEvaluation({
    results: {
      stats: { successes: 1, failures: 0, errors: 0 },
      results: [
        {
          ...row,
          gradingResult: {
            pass: true,
            score: 1,
            componentResults: [
              {
                pass: true,
                score: 1,
                tokensUsed: { prompt: 100, completion: 10, total: 110, numRequests: 1, cost: 0.01 },
                metadata: {
                  cachedResponse: true,
                  judgeAccounting: {
                    version: 1,
                    attempts: [
                      {
                        cached: false,
                        accounting: {
                          version: 1,
                          source: "session.rpc.usage.getMetrics",
                          scope: "session",
                          unit: "nano-AIU",
                          status: "complete",
                          totalNanoAiu: 1_000_000_000,
                        },
                      },
                      { cached: true },
                    ],
                  },
                },
              },
            ],
          },
        },
      ],
    },
  });
  assert.equal(report.totals.graderCost.usd, 0.01);
});

test("native assertion-set aggregates do not invent zero usage or discard measured child spend", () => {
  for (const measured of [false, true]) {
    const child = {
      pass: true,
      score: 1,
      assertion: { type: "javascript" },
      ...(measured ? { tokensUsed: { total: 10, prompt: 7, completion: 3, cost: 0.2 } } : {}),
    };
    const set = {
      pass: true,
      score: 1,
      tokensUsed: {
        total: measured ? 10 : 0,
        prompt: measured ? 7 : 0,
        completion: measured ? 3 : 0,
      },
      metadata: { assertionSet: { type: "assert-set", assertionCount: 1 } },
      componentResults: [child],
    };
    const report = summarizeEvaluation({
      results: {
        stats: { successes: 1, failures: 0, errors: 0 },
        results: [
          { ...row, gradingResult: { pass: true, score: 1, componentResults: [set, child] } },
        ],
      },
    });
    assert.equal(report.totals.graderUsage.total, measured ? 10 : null);
    assert.equal(report.totals.graderCost.usd, measured ? 0.2 : null);
  }
});
