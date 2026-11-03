import assert from "node:assert/strict";
import { test } from "vitest";
import { summarizeEvaluation } from "../packages/oh-my-promptfoo/src/reporting";

const row = {
  success: true,
  failureReason: 0,
  score: 1,
  testIdx: 0,
  promptIdx: 0,
  response: { output: "answer" },
};

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
