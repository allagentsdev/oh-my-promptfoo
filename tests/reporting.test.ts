import assert from "node:assert/strict";
import { test } from "vitest";
import {
  renderConsoleSummary,
  renderSummary,
  summarizeEvaluation,
} from "../packages/oh-my-promptfoo/src/reporting";
import { estimateCopilotCost, responseCost } from "../packages/oh-my-promptfoo/src/result-cost";

const usage = { prompt: 100, completion: 10, total: 110, numRequests: 1 };
const session = (totalNanoAiu = 1_000_000_000) => ({
  version: 1,
  source: "session.rpc.usage.getMetrics",
  scope: "session",
  unit: "nano-AIU",
  status: "complete",
  totalNanoAiu,
});
const prices = {
  model: "fixture",
  batchSize: 1_000_000,
  default: {
    inputPrice: 100,
    cacheReadPrice: 10,
    cacheWritePrice: 125,
    outputPrice: 200,
    maxPromptTokens: 1000,
  },
  longContext: {
    inputPrice: 200,
    cacheReadPrice: 20,
    cacheWritePrice: 250,
    outputPrice: 400,
    maxPromptTokens: 2000,
  },
};
const assertion = (pass = true) => ({
  pass,
  score: pass ? 1 : 0,
  reason: "PRIVATE_GRADER_REASON",
  assertion: { type: "equals", value: "PRIVATE_EXPECTED", metric: "PRIVATE_METRIC" },
});
const row = (overrides: Record<string, any> = {}) => ({
  success: true,
  score: 1,
  failureReason: 0,
  testIdx: 0,
  promptIdx: 0,
  latencyMs: 10,
  testCase: {
    description: "PRIVATE_DESCRIPTION",
    metadata: { id: "PRIVATE_ID" },
    assert: [{ type: "equals", value: "PRIVATE_EXPECTED" }],
  },
  provider: { id: "PRIVATE_PROVIDER", label: "PRIVATE_LABEL" },
  response: { output: "PRIVATE_ANSWER", metadata: { fileChanges: { content: "PRIVATE_FILE" } } },
  gradingResult: { pass: true, score: 1, componentResults: [assertion()] },
  ...overrides,
});
const document = (rows: any[], stats?: any) => ({
  config: { env: { TOKEN: "PRIVATE_CREDENTIAL" } as Record<string, string> },
  results: {
    results: rows,
    stats: stats ?? {
      successes: rows.filter((item) => item.success).length,
      failures: rows.filter((item) => !item.success && item.failureReason !== 2).length,
      errors: rows.filter((item) => item.failureReason === 2).length,
    },
  },
});

test("console and Markdown show authored score thresholds without overriding native verdicts or leaking raw fields", () => {
  const input = document([
    row({
      testCase: { description: "A required check", threshold: 0.9 },
      score: 0.95,
      success: false,
      failureReason: 1,
    }),
    row({ testIdx: 1, testCase: { description: "No overall threshold" } }),
  ]);
  const report = summarizeEvaluation(input, 100, { suiteNumber: 4, publicLabels: true });
  const markdown = renderSummary(report),
    consoleText = renderConsoleSummary(report);
  assert.ok(markdown.includes("Score / threshold"));
  assert.ok(markdown.includes("❌ FAIL | 1 / 1 | 95% / 90% |"));
  assert.ok(markdown.includes("✅ PASS | 1 / 1 | — |"));
  assert.ok(consoleText.includes("Test 1 · A required check"));
  assert.ok(consoleText.includes("FAIL · 10 ms · score 95% / threshold 90%"));
  assert.ok(consoleText.includes("Agent: unknown; cost: unknown"));
  assert.ok(
    !consoleText.includes("PRIVATE_ANSWER") && !consoleText.includes("PRIVATE_GRADER_REASON"),
  );
  assert.equal(report.status, "fail");
  const privateText = renderConsoleSummary(summarizeEvaluation(input, 100));
  assert.ok(!privateText.includes("A required check") && !privateText.includes("PRIVATE_"));
});

test("console labels cannot emit modern or legacy workflow commands or terminal controls", () => {
  const input = document([
    row({ testCase: { description: "::error::unsafe ##[error] \u001b[31m" } }),
  ]);
  const text = renderConsoleSummary(summarizeEvaluation(input, 0, { publicLabels: true }));
  assert.ok(!text.includes("::error::") && !text.includes("##[error]") && !text.includes("\u001b"));
});

test("reports native verdicts without reapplying thresholds or leaking raw fields", () => {
  const report = summarizeEvaluation(
    document([
      row({
        gradingResult: {
          pass: true,
          score: 0.8,
          componentResults: [assertion(false), assertion()],
        },
      }),
      row({ success: false, failureReason: 1, score: 0.99 }),
    ]),
    100,
  );
  assert.equal(report.status, "fail");
  assert.deepEqual(report.counts, { pass: 1, fail: 1, error: 0, unknown: 0 });
  assert.equal(report.cases[0].assertions[0].status, "fail");
  const rendered = renderSummary(report);
  assert.ok(rendered.includes("| Test 1 | 10 ms | unknown | unknown | ✅ PASS | 1 / 2 |"));
  assert.ok(!JSON.stringify(report).includes("PRIVATE_"));
  assert.ok(!rendered.includes("PRIVATE_"));
  // The explicit native suite policy can allow assertion failures; errors never qualify.
  assert.equal(
    summarizeEvaluation(document([row({ success: false, failureReason: 1 })]), 0).status,
    "pass",
  );
  assert.equal(
    summarizeEvaluation(document([row({ success: false, failureReason: 1 })])).status,
    "fail",
  );
});

test("missing exports, empty coverage, inconsistent stats and process errors cannot pass", () => {
  for (const input of [
    undefined,
    {},
    { results: { results: [] } },
    document([]),
    document([row()], { successes: 2, failures: 0, errors: 0 }),
    document([row({ score: null })]),
  ])
    assert.equal(summarizeEvaluation(input, 0).status, "error");
  assert.equal(summarizeEvaluation(document([row()]), 1).status, "error");
  assert.equal(summarizeEvaluation(document([row()]), null).status, "error");
  assert.equal(
    summarizeEvaluation(document([row({ response: { error: "PRIVATE_FAILURE" } })]), 0).status,
    "error",
  );
});

test("failed graders override a tolerated native row and synthetic zero measurements remain unknown", () => {
  const report = summarizeEvaluation(
    document([
      row({
        gradingResult: {
          pass: true,
          score: 1,
          tokensUsed: { ...usage, cost: 0 },
          componentResults: [
            {
              ...assertion(),
              tokensUsed: { total: 0, prompt: 0, completion: 0, cost: 0 },
              metadata: { graderError: true },
            },
          ],
        },
      }),
    ]),
    0,
  );
  assert.equal(report.status, "error");
  assert.equal(report.cases[0].assertions[0].status, "error");
  assert.equal(report.totals.graderCost.usd, null);
  assert.equal(report.totals.graderUsage.total, null);
});

test("absence of candidate measurements does not use zero-filled row statistics", () => {
  const report = summarizeEvaluation(
    document([row({ cost: 0, tokenUsage: { ...usage, total: 0 } })]),
  );
  assert.equal(report.totals.candidateCost.usd, null);
  assert.equal(report.totals.candidateUsage.total, null);
  const measured = summarizeEvaluation(
    document([row({ response: { cost: 0, tokenUsage: usage } })]),
  );
  assert.equal(measured.totals.candidateCost.usd, 0);
  assert.equal(measured.totals.candidateUsage.total, 110);
  const mixed = summarizeEvaluation(
    document([row({ response: { cost: 0.1, tokenUsage: usage } }), row()]),
  );
  assert.equal(mixed.totals.candidateCost.usd, null);
  assert.equal(mixed.totals.candidateUsage.total, null);
});

test("session and authoritative attempt ledgers reuse package accounting with unknown propagation", () => {
  assert.equal(
    responseCost({ cost: 99, metadata: { copilot: { accounting: session() } } }, "fixture").usd,
    0.01,
  );
  assert.equal(
    responseCost(
      { cost: 99, metadata: { copilot: { accounting: { ...session(), status: "partial" } } } },
      "fixture",
    ).usd,
    null,
  );
  const ledger = {
    version: 1,
    attempts: [
      { cached: false, accounting: session() },
      { cached: true, accounting: session(9000000000) },
    ],
  };
  const reply = {
    cost: 99,
    metadata: { copilot: { accounting: session(8000000000) }, judgeAccounting: ledger },
  };
  assert.equal(responseCost(reply, "fixture").usd, 0.01);
  assert.equal(
    responseCost(
      {
        metadata: {
          judgeAccounting: { ...ledger, attempts: [...ledger.attempts, { cached: false }] },
        },
      },
      "fixture",
    ).usd,
    null,
  );
  assert.equal(
    responseCost(
      { metadata: { judgeAccounting: { ...ledger, copilotAccountingSeen: true } } },
      "fixture",
    ).usd,
    null,
  );
  assert.equal(responseCost({ cached: true }, "fixture").usd, 0);
  assert.equal(
    responseCost(
      {
        metadata: {
          judgeAccounting: { version: 1, attempts: [{ cached: true }, { cached: true }] },
        },
      },
      "fixture",
    ).usd,
    0,
  );
  assert.equal(responseCost({ cost: 0 }, "fixture", true).usd, null);
});

test("Copilot estimates follow recorded tiers, cache writes and model provenance", () => {
  assert.equal(estimateCopilotCost(usage, prices, "fixture"), 0.000145);
  assert.equal(
    estimateCopilotCost(
      { ...usage, completionDetails: { cacheReadInputTokens: 20, cacheCreationInputTokens: 30 } },
      prices,
      "fixture",
    ),
    0.0001095,
  );
  assert.equal(estimateCopilotCost({ ...usage, prompt: 1200 }, prices, "fixture"), 0.00304);
  for (const [tokens, rates, model] of [
    [usage, prices, "different-model"],
    [{ ...usage, completionDetails: "invalid" }, prices, "fixture"],
    [{ ...usage, prompt: 1200, numRequests: 2 }, prices, "fixture"],
    [{ ...usage, completionDetails: { cacheReadInputTokens: 101 } }, prices, "fixture"],
    [usage, { ...prices, batchSize: 0 }, "fixture"],
    [usage, { ...prices, default: { maxPromptTokens: 1000 } }, "fixture"],
  ])
    assert.equal(estimateCopilotCost(tokens, rates, model), undefined);
  const report = summarizeEvaluation(
    document([
      row({
        provider: { id: "copilot:fixture" },
        response: { tokenUsage: usage, metadata: { copilotTokenPrices: prices } },
      }),
    ]),
  );
  assert.equal(report.totals.candidateCost.basis, "estimate");
  assert.ok(renderSummary(report).includes("~$0.000145"));
});

test("batch diagnostic children are shown once and do not duplicate judge spend", () => {
  const children = [assertion(), assertion(false)];
  const batch = {
    ...assertion(false),
    tokensUsed: { ...usage, cost: 0.2 },
    componentResults: children,
    metadata: { judgeAccounting: { version: 1, attempts: [{ cached: false }] } },
  };
  const report = summarizeEvaluation(
    document([
      row({
        gradingResult: {
          pass: false,
          score: 0.5,
          tokensUsed: usage,
          componentResults: [batch, ...children],
        },
      }),
    ]),
  );
  assert.equal(report.cases[0].assertions.length, 3);
  assert.equal(report.totals.graderCost.usd, 0.2);
  assert.equal(report.totals.graderUsage.total, 110);
  const unknown = summarizeEvaluation(
    document([
      row({
        gradingResult: {
          pass: false,
          score: 0.5,
          tokensUsed: usage,
          componentResults: [
            batch,
            ...children,
            { ...assertion(), assertion: { type: "llm-rubric" } },
          ],
        },
      }),
    ]),
  );
  assert.equal(unknown.totals.graderCost.usd, null);
});

test("large summaries are bounded while normalized outcomes stay complete", () => {
  const report = summarizeEvaluation(document(Array.from({ length: 15000 }, () => row())));
  const markdown = renderSummary(report);
  assert.ok(Buffer.byteLength(markdown) < 810000);
  assert.ok(markdown.includes("Summary truncated"));
  assert.equal(report.cases.length, 15000);
});

test("suite and result numbers match the table and details while named checks use their metrics", () => {
  const input = document(
    Array.from({ length: 6 }, (_, index) =>
      row({
        testIdx: index + 20,
        testCase: { description: `Repository task ${index + 1}` },
        provider: { id: "PRIVATE_PROVIDER", label: "Free candidate" },
        gradingResult: {
          pass: true,
          score: 1,
          componentResults: [
            {
              ...assertion(),
              assertion: { type: "equals", metric: "Artifact contract", value: "PRIVATE_EXPECTED" },
            },
          ],
        },
      }),
    ),
  );
  input.config = { ...input.config, description: "Repository skill regression" } as any;
  const report = summarizeEvaluation(input, 0, { suiteNumber: 2, publicLabels: true });
  const markdown = renderSummary(report);
  assert.ok(markdown.startsWith("## Evals — ✅ PASS"));
  assert.ok(markdown.includes("Suite 2 · Repository skill regression"));
  assert.ok(!markdown.includes("Test 2."));
  assert.ok(markdown.includes("| Candidate | Free candidate |"));
  assert.ok(markdown.includes("| Test | Latency | Tokens | Cost | Status | Assertions passed |"));
  assert.ok(
    markdown.includes("| Test 6 · Repository task 6 | 10 ms | unknown | unknown | ✅ PASS |"),
  );
  assert.ok(markdown.includes("<summary>Test 6 · Repository task 6 — ✅ PASS</summary>"));
  assert.ok(markdown.includes("| Artifact contract | equals | ✅ PASS | 100% |"));
  assert.ok(!markdown.includes("/A1"));
  assert.equal(report.cases[5].test, 26);
  assert.equal(report.cases[5].row, 6);
  assert.ok(!JSON.stringify(report).includes("PRIVATE_"));
  input.results.results[5].provider.label = "Other candidate";
  const comparison = renderSummary(
    summarizeEvaluation(input, 0, { suiteNumber: 2, publicLabels: true }),
  );
  assert.ok(comparison.includes("Test 6 · Repository task 6 (Other candidate)"));
  assert.ok(comparison.includes("Test 1 · Repository task 1 (Free candidate)"));
  assert.ok(!comparison.includes("| Candidate |"));
  for (const suiteNumber of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => summarizeEvaluation(input, 0, { suiteNumber }), /Suite number/);
});

test("results show combined reported accounting and distinguish absent thresholds from missing measurements", () => {
  const input = document([
    row({
      response: { cost: 0.02, tokenUsage: { total: 20, prompt: 15, completion: 5 } },
      gradingResult: {
        pass: true,
        score: 1,
        componentResults: [
          {
            ...assertion(),
            assertion: { type: "javascript", metric: "workspace-review" },
            tokensUsed: { total: 10, prompt: 7, completion: 3, numRequests: 1, cost: 0.01 },
            componentResults: [
              {
                ...assertion(),
                assertion: {
                  type: "llm-rubric",
                  metric: "verified-artifact",
                  threshold: 1,
                },
              },
            ],
          },
        ],
      },
    }),
  ]);
  const report = summarizeEvaluation(input, 0, { publicLabels: true });
  const markdown = renderSummary(report);
  assert.ok(markdown.includes("| 10 ms | 30 | $0.03 | ✅ PASS | 1 / 1 |"));
  assert.ok(markdown.includes("| workspace-review | javascript | ✅ PASS | 100% | — |"));
  assert.ok(markdown.includes("| verified-artifact | llm-rubric | ✅ PASS | 100% | 100% |"));
  assert.equal(report.cases[0].assertions[0].threshold, null);
});

test("public labels are bounded, escaped and credential-redacted without publishing private results", () => {
  const credential = "credential-canary-abc123";
  const input = document([
    row({
      testCase: {
        description: `Read | </summary><script>alert(1)</script> [link](url) ${credential}\n${"x".repeat(500)}`,
      },
      provider: { id: "PRIVATE_PROVIDER", label: "https://user:password@example.test" },
      gradingResult: {
        pass: true,
        score: 1,
        componentResults: [
          {
            ...assertion(),
            assertion: { type: "file://PRIVATE_PATH", metric: "Public check" },
          },
        ],
      },
    }),
  ]);
  input.config.env.OPENAI_API_KEY = credential;
  const report = summarizeEvaluation(input, 0, { publicLabels: true });
  const markdown = renderSummary(report);
  assert.ok(!JSON.stringify(report).includes(credential));
  assert.ok(!JSON.stringify(report).includes("PRIVATE_"));
  assert.ok(report.cases[0].label!.length <= 160);
  assert.ok(markdown.includes("&#124;") && markdown.includes("&lt;/summary&gt;"));
  assert.ok(!markdown.includes("<script>") && !markdown.includes("user:password"));
  assert.ok(markdown.includes("Public check | custom"));
});

test("assertion types require public-label consent and credential redaction", () => {
  const credential = "credential-canary-abc123";
  const input = document([
    row({
      gradingResult: {
        pass: true,
        score: 1,
        componentResults: [{ ...assertion(), assertion: { type: credential } }],
      },
    }),
  ]);
  input.config.env.OPENAI_API_KEY = credential;
  for (const publicLabels of [false, true]) {
    const report = summarizeEvaluation(input, 0, { publicLabels });
    assert.equal(report.cases[0].assertions[0].type, "custom");
    assert.ok(!JSON.stringify(report).includes(credential));
    assert.ok(!renderSummary(report).includes(credential));
  }
});

test("only unnamed and duplicate check metrics need a numbered fallback", () => {
  const report = summarizeEvaluation(
    document([
      row({
        gradingResult: {
          pass: true,
          score: 1,
          componentResults: [
            { ...assertion(), assertion: { type: "equals", metric: "correctness" } },
            { ...assertion(), assertion: { type: "contains", metric: "correctness" } },
            { ...assertion(), assertion: { type: "is-json" } },
          ],
        },
      }),
    ]),
    0,
    { publicLabels: true },
  );
  const markdown = renderSummary(report);
  assert.ok(markdown.includes("| correctness (check 1) | equals |"));
  assert.ok(markdown.includes("| correctness (check 2) | contains |"));
  assert.ok(markdown.includes("| Check 3 | is-json |"));
  assert.ok(!markdown.includes("/A"));
});

test("display rounding preserves native scores and never rounds a positive spend to free", () => {
  const report = summarizeEvaluation(
    document([
      row({
        score: 1 / 3,
        latencyMs: 19119,
        response: { cost: 0.0000000001 },
      }),
    ]),
  );
  const markdown = renderSummary(report);
  assert.ok(markdown.includes("33.3%") && markdown.includes("19.1 s"));
  assert.ok(markdown.includes("&lt;$0.00000001"));
  assert.equal(report.cases[0].score, 1 / 3);
  assert.equal(report.cases[0].candidateCost.usd, 0.0000000001);
});
