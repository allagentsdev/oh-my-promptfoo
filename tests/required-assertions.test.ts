import { assertions, evaluate } from "promptfoo";
import { expect, test } from "vitest";
import { withAssertions } from "../packages/oh-my-promptfoo/src/assertion-integration.js";

type Run = Parameters<typeof assertions.runAssertions>[0];
async function run(input: unknown, output = "yes", latencyMs?: number) {
  const configured = withAssertions({ defaultTest: input }).defaultTest as Run["test"];
  return assertions.runAssertions({
    test: configured,
    assertScoringFunction: configured.assertScoringFunction as Run["assertScoringFunction"],
    providerResponse: { output },
    latencyMs,
  });
}
test("required failures veto thresholds while passing gates do not inflate remaining weighted scores", async () => {
  for (const [output, expected] of [
    ["wrong", 0],
    ["yes", 0.65],
  ] as const) {
    const result = await run(
      {
        threshold: 0.1,
        assert: [
          { type: "equals", value: "yes", required: true, metric: "gate", weight: 20 },
          { type: "javascript", value: "0.8", metric: "quality-a", weight: 1 },
          { type: "javascript", value: "0.6", metric: "quality-b", weight: 3 },
        ],
      },
      output,
    );
    expect(result.score).toBeCloseTo(expected);
    expect(result.pass).toBe(output === "yes");
    expect(result.namedScores).toEqual({
      gate: output === "yes" ? 1 : 0,
      "quality-a": 0.8,
      "quality-b": 0.6,
    });
    if (!result.pass) expect(result.reason).toMatch(/Required assertion veto/);
  }
});
test("function-valued required assertions retain their original config", async () => {
  for (const output of ["yes", "no"]) {
    const result = await run(
      {
        assert: [
          {
            type: "javascript",
            required: true,
            config: { expected: "yes" },
            value: (value: string, context: { config: { expected: string } }) =>
              value === context.config.expected,
          },
        ],
      },
      output,
    );
    expect(result).toMatchObject({ pass: output === "yes", score: output === "yes" ? 1 : 0 });
  }
});
test("latency gates retain evaluator-measured latency rather than redispatching without it", async () => {
  for (const latencyMs of [5, 50]) {
    expect(
      await run(
        {
          threshold: 0,
          assert: [
            { type: "latency", threshold: 10, required: true },
            { type: "javascript", value: "0.4" },
          ],
        },
        "yes",
        latencyMs,
      ),
    ).toMatchObject({ pass: latencyMs <= 10, score: latencyMs <= 10 ? 0.4 : 0 });
  }
});
test("native trace assertions keep their populated trace", async () => {
  const assertion = withAssertions({
    defaultTest: { assert: [{ type: "trace-error-spans", value: 0, required: true }] },
  }).defaultTest.assert[0] as Parameters<typeof assertions.runAssertion>[0]["assertion"];
  const result = await assertions.runAssertion({
    assertion,
    test: {},
    providerResponse: { output: "yes" },
    traceId: "a".repeat(32),
    traceData: { traceId: "a".repeat(32), evaluationId: "eval", testCaseId: "case", spans: [] },
  });
  expect(result).toMatchObject({ pass: true, score: 1 });
});
test("case thresholds cannot turn a failing required assertion set into a passing gate", async () => {
  const result = await run({
    threshold: 0.1,
    assert: [
      {
        type: "assert-set",
        required: true,
        threshold: 0.8,
        assert: [{ type: "javascript", value: "0.7" }],
      },
    ],
  });
  expect(result).toMatchObject({ pass: false, score: 0 });
  expect(result.reason).toMatch(/Required assertion veto/);
});
test("nested set gates neither inflate scores nor disappear behind set thresholds", async () => {
  for (const output of ["yes", "no"]) {
    const result = await run(
      {
        threshold: 0.1,
        assert: [
          {
            type: "assert-set",
            threshold: 0.1,
            weight: 2,
            assert: [
              { type: "equals", value: "yes", required: true },
              { type: "javascript", value: "0.4", metric: "quality" },
            ],
          },
        ],
      },
      output,
    );
    expect(result).toMatchObject({
      pass: output === "yes",
      score: output === "yes" ? 0.4 : 0,
      namedScores: { quality: 0.4 },
    });
  }
});
test("unmarked assertions retain native aggregation without a custom scorer", async () => {
  const config = withAssertions({
    defaultTest: {
      threshold: 0.5,
      assert: [
        { type: "javascript", value: "0.8", weight: 1 },
        { type: "javascript", value: "0.4", weight: 3 },
      ],
    },
  });
  expect(await run(config.defaultTest)).toMatchObject({ pass: true, score: 0.5 });
});
test("scenario-level custom scorers cannot override required vetoes", () => {
  expect(() =>
    withAssertions({
      defaultTest: { assert: [{ type: "equals", value: "yes", required: true }] },
      scenarios: [
        {
          config: [
            { assertScoringFunction: () => ({ pass: true, score: 1, reason: "ignore failures" }) },
          ],
          tests: [{}],
        },
      ],
    }),
  ).toThrow(/remove the old scorer/);
});
test("required max-score retains native cross-output routing and the winner's non-gate score", async () => {
  const config = withAssertions({
    writeLatestResults: false,
    prompts: ["task"],
    providers: [
      { id: () => "higher", callApi: async () => ({ output: "0.8" }) },
      { id: () => "lower", callApi: async () => ({ output: "0.4" }) },
    ],
    defaultTest: {
      assert: [
        { type: "javascript", value: "Number(output)", metric: "quality" },
        { type: "max-score", required: true },
      ],
    },
    tests: [{ vars: {} }],
  });
  const record = await evaluate(config as Parameters<typeof evaluate>[0], {
    cache: false,
    maxConcurrency: 1,
  });
  const summary = await record.toEvaluateSummary();
  const rows = summary.results.sort((a, b) => b.score - a.score);
  expect(rows.map((row) => ({ success: row.success, score: row.score }))).toEqual([
    { success: true, score: 0.8 },
    { success: false, score: 0 },
  ]);
  expect(rows.map((row) => row.namedScores.quality)).toEqual([0.8, 0.4]);
});
