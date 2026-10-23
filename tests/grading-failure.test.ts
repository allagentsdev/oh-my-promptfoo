import assert from "node:assert/strict";
import { test } from "vitest";
import { llmAssert } from "../packages/oh-my-promptfoo/src/assertions";
import type { JudgeResponse } from "../packages/oh-my-promptfoo/src/judge";
import { FallbackProvider } from "../packages/oh-my-promptfoo/src/providers";
import { gradeRubric, prepareRubric } from "../packages/oh-my-promptfoo/src/rubric-contract";

const components = [{ metric: "accuracy", value: "Ground every claim" }];
const rubric = () => prepareRubric("candidate answer", { config: { components } });
const reason = 'Observed {balanced} braces and a quote: "grounded"';
const verdict = JSON.stringify({
  components: [{ metric: "accuracy", pass: true, score: 1, reason }],
});

const accounting = (totalNanoAiu: number) =>
  ({
    version: 1,
    source: "session.rpc.usage.getMetrics",
    scope: "session",
    unit: "nano-AIU",
    status: "complete",
    totalNanoAiu,
  }) as const;

test("rubric retries preserve ordered accounting on success and every failure reply", async () => {
  for (const final of [
    { text: verdict },
    { text: "not JSON" },
    { text: "" },
    { error: "Grader disconnected" },
  ]) {
    const first = accounting(1_000_000_000);
    const second = accounting(2_000_000_000);
    const result = await gradeRubric(rubric(), "sent prompt", async (attempt) => ({
      ...(attempt === 0 ? { text: "not JSON" } : final),
      metadata: {
        copilot: { accounting: attempt === 0 ? first : second },
        diagnostic: "retained",
      },
      // The reported session totals, not an opaque scalar, establish the unit.
      usage: { cost: 99 },
    }));
    assert.deepEqual(result.metadata.judgeAccounting, {
      version: 1,
      attempts: [
        { cached: false, accounting: first },
        { cached: false, accounting: second },
      ],
    });
    assert.equal(result.tokensUsed?.cost, 0.03);
    assert.equal(result.metadata.diagnostic, "retained");
    assert.equal(result.metadata.graderError, final.text === verdict ? undefined : true);
  }
});

test("rubric accounting retains cached snapshots without charging them or criterion children", async () => {
  const first = accounting(9_000_000_000);
  const second = accounting(0);
  const result = await gradeRubric(rubric(), "sent prompt", async (attempt) => ({
    text: attempt === 0 ? "not JSON" : verdict,
    cached: attempt === 0,
    metadata: { copilot: { accounting: attempt === 0 ? first : second } },
  }));
  assert.deepEqual(result.metadata.judgeAccounting, {
    version: 1,
    attempts: [
      { cached: true, accounting: first },
      { cached: false, accounting: second },
    ],
  });
  assert.equal(result.tokensUsed?.cost, 0);
  assert.ok(result.componentResults.every((child) => !Object.hasOwn(child, "metadata")));
});

test("cached unknown and partial leaves do not invalidate complete executed accounting", async () => {
  for (const cachedMetadata of [
    undefined,
    { copilot: { accounting: { ...accounting(7), status: "partial" } } },
  ]) {
    const measured = accounting(1_000_000_000);
    const result = await gradeRubric(rubric(), "sent prompt", async (attempt) => ({
      text: attempt === 0 ? "not JSON" : verdict,
      cached: attempt === 0,
      metadata: attempt === 0 ? cachedMetadata : { copilot: { accounting: measured } },
    }));
    assert.equal(result.pass, true);
    assert.equal(result.tokensUsed?.cost, 0.01);
    assert.equal(result.metadata.judgeAccounting?.attempts.length, 2);
    assert.equal(result.metadata.judgeAccounting?.attempts[0].cached, true);
  }
});

test("rubric scalar costs require every attempt and one complete accounting unit", async () => {
  for (const metadata of [
    undefined,
    { copilot: { accounting: { ...accounting(2), status: "partial" } } },
    { copilot: { accounting: { ...accounting(2), totalNanoAiu: -1 } } },
    { copilot: { accounting: { ...accounting(2), unit: "USD" } } },
  ]) {
    const result = await gradeRubric(rubric(), "sent prompt", async (attempt) => ({
      text: attempt === 0 ? "not JSON" : verdict,
      metadata: attempt === 0 ? { copilot: { accounting: accounting(1_000_000_000) } } : metadata,
      usage: { cost: 0.01 },
    }));
    assert.equal(result.tokensUsed?.cost, undefined);
    assert.equal(result.metadata.judgeAccounting?.attempts.length, 2);
  }
  const missingNative = await gradeRubric(rubric(), "sent prompt", async (attempt) => ({
    text: attempt === 0 ? "not JSON" : verdict,
    usage: attempt === 0 ? { cost: 0.1 } : undefined,
  }));
  assert.equal(missingNative.tokensUsed?.cost, undefined);
});

test("valid session leaves retain evidence but cannot overflow a complete scalar total", async () => {
  const leaves = [accounting(Number.MAX_SAFE_INTEGER), accounting(1)];
  const result = await gradeRubric(rubric(), "sent prompt", async (attempt) => ({
    text: attempt === 0 ? "not JSON" : verdict,
    metadata: { copilot: { accounting: leaves[attempt] } },
  }));
  assert.equal(result.pass, true);
  assert.equal(result.tokensUsed?.cost, undefined);
  assert.deepEqual(result.metadata.judgeAccounting, {
    version: 1,
    attempts: leaves.map((accounting) => ({ cached: false, accounting })),
  });
});

test("rubric nested accounting is authoritative, sanitized and fails closed on invalid ledgers", async () => {
  const leaf = accounting(1_000_000_000);
  const result = await gradeRubric(rubric(), "sent prompt", async () => ({
    text: verdict,
    metadata: {
      copilot: { accounting: accounting(9_000_000_000) },
      judgeAccounting: {
        version: 1,
        attempts: [{ cached: false, accounting: { ...leaf, prompt: "private" }, raw: "private" }],
      },
    },
  }));
  assert.deepEqual(result.metadata.judgeAccounting, {
    version: 1,
    attempts: [{ cached: false, accounting: leaf }],
  });
  assert.equal(result.tokensUsed?.cost, 0.01);
  for (const judgeAccounting of [
    { version: 2, attempts: [{ cached: false, accounting: leaf }] },
    { version: 1, attempts: [] },
    { version: 1, attempts: [{ cached: "false", accounting: leaf }] },
    {
      version: 1,
      attempts: [{ cached: false, accounting: leaf }],
      copilotAccountingSeen: false,
    },
    {
      version: 1,
      attempts: Array.from({ length: 1025 }, () => ({ cached: false, accounting: leaf })),
    },
  ]) {
    const invalid = await gradeRubric(rubric(), "sent prompt", async () => ({
      text: verdict,
      metadata: { judgeAccounting },
      usage: { cost: 99 },
    }));
    assert.deepEqual(invalid.metadata.judgeAccounting, {
      version: 1,
      attempts: [{ cached: false }],
    });
    assert.equal(invalid.tokensUsed?.cost, undefined);
  }
});

test("rubric grading accepts prose and fenced JSON without a paid retry", async () => {
  for (const text of [
    `The inspection is complete.\n${verdict}\nThat is the final verdict.`,
    `\`\`\`json\n${verdict}\n\`\`\``,
    `Inspection notes {not JSON}.\n\`\`\`json\n${verdict}\n\`\`\`\nDone.`,
  ]) {
    let attempts = 0;
    const result = await gradeRubric(rubric(), "sent prompt", async () => {
      attempts++;
      return { text };
    });
    assert.equal(result.pass, true);
    assert.equal(result.score, 1);
    assert.equal(result.componentResults[0].reason, reason);
    assert.equal(attempts, 1);
  }
});

test("failed verdict retries return the billed usage from both replies", async () => {
  for (const [text, expectedReason] of [
    ["not JSON", /malformed JSON/],
    ['{"components":[]}', /did not score every component/],
  ] as const) {
    let attempts = 0;
    const result = await gradeRubric(rubric(), "sent prompt", async () => ({
      text,
      usage:
        ++attempts === 1
          ? { prompt: 10, completion: 2, cached: 1, cost: 0.25 }
          : { prompt: 20, completion: 3, cached: 2, cost: 0.5 },
    }));
    assert.equal(attempts, 2);
    assert.equal(result.pass, false);
    assert.equal(result.score, 0);
    assert.match(result.reason, expectedReason);
    assert.deepEqual(result.tokensUsed, {
      prompt: 30,
      completion: 5,
      total: 35,
      cached: 3,
      numRequests: 2,
      cost: 0.75,
    });
    assert.deepEqual(result.componentResults, []);
  }
});

test("the malformed-verdict retry is attempt 1, and its failure keeps the first reply's usage", async () => {
  const attempts: number[] = [];
  const result = await gradeRubric(rubric(), "sent prompt", async (attempt) => {
    attempts.push(attempt);
    return attempt === 0
      ? { text: "not JSON", usage: { prompt: 10, completion: 2 } }
      : { error: "Grader session disconnected" };
  });
  assert.deepEqual(attempts, [0, 1]);
  assert.equal(result.pass, false);
  assert.equal(result.score, 0);
  assert.equal(result.reason, "Grader session disconnected");
  // Marked the way Promptfoo's llm-rubric marks a judge failure in its results.
  assert.equal(result.metadata.graderError, true);
  assert.deepEqual(result.tokensUsed, {
    prompt: 10,
    completion: 2,
    total: 12,
    cached: 0,
    numRequests: 2,
  });

  // A judge that throws on the retry is not a judge failure to record but a row error.
  const disconnected = new Error("Grader session disconnected");
  await assert.rejects(
    gradeRubric(rubric(), "sent prompt", async (attempt) => {
      if (attempt === 0) return { text: "not JSON" };
      throw disconnected;
    }),
    (error) => error === disconnected,
  );
});

test("execution error responses preserve billed usage without retrying", async () => {
  let attempts = 0;
  const result = await gradeRubric(rubric(), "sent prompt", async () => {
    attempts++;
    return {
      error: "Agent grading failed: session.error after a billed turn",
      usage: { prompt: 10, completion: 2, total: 12, cached: 3, cost: 0.25 },
    };
  });
  assert.equal(attempts, 1);
  assert.equal(result.pass, false);
  assert.equal(result.score, 0);
  assert.equal(result.reason, "Agent grading failed: session.error after a billed turn");
  assert.deepEqual(result.tokensUsed, {
    prompt: 10,
    completion: 2,
    total: 12,
    cached: 3,
    numRequests: 1,
    cost: 0.25,
  });
});

test("unmeasured judge failures are grader errors that still count their requests", async () => {
  const executionError = new Error("Grader could not start");
  await assert.rejects(
    gradeRubric(rubric(), "sent prompt", async () => {
      throw executionError;
    }),
    (error) => error === executionError,
  );
  const unmeasured = (numRequests: number) => ({
    total: 0,
    prompt: 0,
    completion: 0,
    cached: 0,
    numRequests,
  });
  const failed = await gradeRubric(rubric(), "sent prompt", async () => ({
    error: "Grader session failed",
  }));
  assert.equal(failed.pass, false);
  assert.equal(failed.score, 0);
  assert.equal(failed.reason, "Grader session failed");
  assert.deepEqual(failed.componentResults, []);
  assert.deepEqual(failed.tokensUsed, unmeasured(1));
  assert.equal(failed.metadata.graderError, true);
  const silent = await gradeRubric(rubric(), "sent prompt", async () => ({}));
  assert.equal(silent.reason, "LLM grader returned no response text");
  assert.deepEqual(silent.tokensUsed, unmeasured(1));
  assert.equal(silent.metadata.graderError, true);

  let attempts = 0;
  const malformed = await gradeRubric(rubric(), "sent prompt", async () => {
    attempts++;
    return { text: "not JSON", usage: { prompt: -1, completion: "unknown" } };
  });
  assert.equal(attempts, 2);
  assert.match(malformed.reason, /malformed JSON/);
  assert.deepEqual(malformed.tokensUsed, unmeasured(2));
  assert.equal(malformed.metadata.graderError, true);

  // A reply the response cache served made no request; a provider's own count stands.
  const cached = await gradeRubric(rubric(), "sent prompt", async () => ({
    error: "Cached failure",
    cached: true,
  }));
  assert.deepEqual(cached.tokensUsed, unmeasured(0));
  assert.equal(cached.metadata.graderError, true);
  assert.equal(cached.metadata.cachedResponse, true);
  const counted = await gradeRubric(rubric(), "sent prompt", async () => ({
    error: "All 3 judges failed",
    usage: { numRequests: 3 },
  }));
  assert.deepEqual(counted.tokensUsed, unmeasured(3));
});

test("llmAssert reports usage for HTTP failures and empty billed replies", async () => {
  // Replies shaped as Promptfoo's OpenAI chat provider returns them.
  const unavailable = {
    error: "API error: 503 Service Unavailable\n{}",
    metadata: { http: { status: 503, statusText: "Service Unavailable", headers: {} } },
  };
  const replies: JudgeResponse[] = [
    { output: `The verdict:\n\`\`\`json\n${verdict}\n\`\`\`` },
    { output: "not JSON", tokenUsage: { prompt: 5, completion: 1, numRequests: 1 } },
    unavailable,
    { output: "", tokenUsage: { prompt: 3, completion: 1, numRequests: 1 } },
    unavailable,
  ];
  let attempts = 0;
  const provider = {
    id: () => "openai:chat:fake-grader",
    async callApi(): Promise<JudgeResponse> {
      const next = replies[attempts++];
      if (!next) throw new Error("Unexpected extra judge call");
      return next;
    },
  };
  const context = { config: { components }, test: { options: { provider } } };
  const wrapped = await llmAssert("candidate answer", context);
  assert.equal(wrapped.pass, true);
  assert.equal(attempts, 1);

  const retryFailure = await llmAssert("candidate answer", context);
  assert.equal(retryFailure.pass, false);
  assert.equal(retryFailure.score, 0);
  assert.equal(retryFailure.metadata.graderError, true);
  assert.match(retryFailure.reason, /API error: 503/);
  assert.deepEqual(retryFailure.tokensUsed, {
    prompt: 5,
    completion: 1,
    total: 6,
    cached: 0,
    numRequests: 2,
  });
  assert.equal(attempts, 3);

  const emptyReply = await llmAssert("candidate answer", context);
  assert.equal(emptyReply.pass, false);
  assert.equal(emptyReply.score, 0);
  assert.match(emptyReply.reason, /LLM grader returned no response text/);
  assert.deepEqual(emptyReply.tokensUsed, {
    prompt: 3,
    completion: 1,
    total: 4,
    cached: 0,
    numRequests: 1,
  });
  assert.equal(attempts, 4);

  const unanswered = await llmAssert("candidate answer", context);
  assert.equal(unanswered.metadata.graderError, true);
  assert.match(unanswered.reason, /API error: 503/);
  assert.deepEqual(unanswered.tokensUsed, {
    total: 0,
    prompt: 0,
    completion: 0,
    cached: 0,
    numRequests: 1,
  });
  assert.equal(attempts, 5);
});

test("rubric retains nested overflow accounting when the next attempt throws", async () => {
  const leaf = accounting(1_000_000_000);
  const nested = new FallbackProvider({
    config: {
      cooldownMs: 0,
      providers: Array.from({ length: 2 }, (_, index) => ({
        id: () => `overflow-rubric-${index}`,
        async callApi() {
          return {
            ...(index === 0 ? { error: "API error: 503" } : { output: "not JSON" }),
            tokenUsage: { total: 6000, prompt: 4800, completion: 1200, numRequests: 600 },
            metadata: {
              ...(index === 0 ? { http: { status: 503 } } : {}),
              judgeAccounting: {
                version: 1,
                attempts: Array.from({ length: 600 }, () => ({ cached: false, accounting: leaf })),
              },
            },
          };
        },
      })),
    },
  });
  let calls = 0;
  const provider = {
    id: () => "overflow-rubric-retry",
    async callApi(prompt: string) {
      if (++calls === 1) return nested.callApi(prompt);
      throw new Error("Grader disconnected");
    },
  };
  const result = await llmAssert("candidate answer", { config: { components, provider } });
  assert.equal(result.pass, false);
  assert.equal(result.metadata.graderError, true);
  assert.equal(result.reason, "Grader disconnected");
  assert.equal(result.tokensUsed?.cost, undefined);
  assert.equal(result.tokensUsed?.numRequests, 1201);
  assert.equal(result.tokensUsed?.total, 12_000);
  assert.deepEqual(result.metadata.judgeAccounting?.attempts, [
    { cached: false },
    { cached: false },
  ]);
});

test("a retry that throws retains prior session accounting and an unknown final leaf", async () => {
  const first = accounting(1_000_000_000);
  const result = await gradeRubric(rubric(), "sent prompt", async (attempt) => {
    if (attempt === 0)
      return {
        text: "not JSON",
        usage: { prompt: 10, completion: 2 },
        metadata: { copilot: { accounting: first }, diagnostic: "retained" },
      };
    throw new Error("Grader disconnected");
  });
  assert.equal(result.pass, false);
  assert.equal(result.metadata.graderError, true);
  assert.equal(result.metadata.diagnostic, "retained");
  assert.equal(result.reason, "Grader disconnected");
  assert.deepEqual(result.metadata.judgeAccounting, {
    version: 1,
    attempts: [{ cached: false, accounting: first }, { cached: false }],
  });
  assert.equal(result.tokensUsed?.cost, undefined);
  assert.equal(result.tokensUsed?.numRequests, 2);
  assert.equal(result.tokensUsed?.total, 12);
  const cancelled = new DOMException("Evaluation cancelled", "AbortError");
  await assert.rejects(
    gradeRubric(rubric(), "sent prompt", async (attempt) => {
      if (attempt === 0) return { text: "not JSON", metadata: { copilot: { accounting: first } } };
      throw cancelled;
    }),
    (error) => error === cancelled,
  );
});

test.each([
  { name: "Error", permanent: new Error("API key is not set"), message: "API key is not set" },
  {
    name: "frozen Error",
    permanent: Object.freeze(new Error("API key is not set")),
    message: "API key is not set",
  },
  { name: "primitive", permanent: "API key is not set", message: "API key is not set" },
  { name: "opaque", permanent: Object.create(null) },
  { name: "frozen opaque", permanent: Object.freeze(Object.create(null)) },
])(
  "accounted rubric retries retain native nested fallback usage and the permanent throwing leaf ($name)",
  async ({ permanent, message }) => {
    const measured = accounting(1_000_000_000);
    let nativeCalls = 0;
    let throwingCalls = 0;
    let backupCalls = 0;
    const nested = new FallbackProvider({
      config: {
        cooldownMs: 0,
        providers: [
          {
            id: () => "rubric-native-before-permanent",
            async callApi() {
              nativeCalls++;
              return {
                error: "API error: 503",
                tokenUsage: { total: 10, prompt: 7, completion: 3, cached: 2, numRequests: 1 },
                cost: 0.1,
                metadata: { http: { status: 503 } },
              };
            },
          },
          {
            id: () => "rubric-native-permanent",
            async callApi() {
              throwingCalls++;
              throw permanent;
            },
          },
          {
            id: () => "rubric-native-never",
            async callApi() {
              backupCalls++;
              return { output: verdict };
            },
          },
        ],
      },
    });
    let requests = 0;
    const provider = {
      id: () => "rubric-accounted-then-native-fallback",
      async callApi(prompt: string, context?: object, options?: object) {
        if (++requests === 1)
          return {
            output: "not JSON",
            tokenUsage: { total: 6, prompt: 4, completion: 2, numRequests: 1 },
            metadata: { copilot: { accounting: measured }, diagnostic: "retained" },
          };
        return nested.callApi(prompt, context, options);
      },
    };
    const result = await llmAssert("candidate answer", { config: { components, provider } });
    assert.equal(result.pass, false);
    assert.equal(result.score, 0);
    assert.equal(typeof result.reason, "string");
    assert.ok(result.reason.trim().length > 0);
    if (message !== undefined) assert.equal(result.reason, message);
    assert.equal(result.metadata.graderError, true);
    assert.equal(result.metadata.diagnostic, "retained");
    assert.deepEqual(result.componentResults, []);
    assert.equal(requests, 2);
    assert.equal(nativeCalls, 1);
    assert.equal(throwingCalls, 1);
    assert.equal(backupCalls, 0);
    assert.deepEqual(result.metadata.judgeAccounting, {
      version: 1,
      attempts: [{ cached: false, accounting: measured }, { cached: false }, { cached: false }],
    });
    assert.equal(result.tokensUsed?.cost, undefined);
    assert.deepEqual(result.tokensUsed, {
      total: 16,
      prompt: 11,
      completion: 5,
      cached: 2,
      numRequests: 3,
    });
  },
);

test.each([
  { name: "opaque", permanent: Object.create(null) },
  { name: "frozen opaque", permanent: Object.freeze(Object.create(null)) },
])(
  "accounted rubric retry retains a non-stringifiable direct throw ($name)",
  async ({ permanent }) => {
    const measured = accounting(1_000_000_000);
    let requests = 0;
    const result = await gradeRubric(rubric(), "sent prompt", async (attempt) => {
      requests++;
      if (attempt === 0)
        return {
          text: "not JSON",
          usage: { total: 6, prompt: 4, completion: 2, numRequests: 1 },
          metadata: { copilot: { accounting: measured } },
        };
      throw permanent;
    });
    assert.equal(result.pass, false);
    assert.equal(result.score, 0);
    assert.equal(result.metadata.graderError, true);
    assert.equal(typeof result.reason, "string");
    assert.ok(result.reason.trim().length > 0);
    assert.equal(requests, 2);
    assert.deepEqual(result.metadata.judgeAccounting, {
      version: 1,
      attempts: [{ cached: false, accounting: measured }, { cached: false }],
    });
    assert.equal(result.tokensUsed?.cost, undefined);
    assert.deepEqual(result.tokensUsed, {
      total: 6,
      prompt: 4,
      completion: 2,
      cached: 0,
      numRequests: 2,
    });
  },
);
