import { test } from "bun:test";
import assert from "node:assert/strict";
import { llmAssert } from "../packages/oh-my-promptfoo/src/assertions";
import type { JudgeResponse } from "../packages/oh-my-promptfoo/src/judge";
import { gradeRubric, prepareRubric } from "../packages/oh-my-promptfoo/src/rubric-contract";

const components = [{ metric: "accuracy", value: "Ground every claim" }];
const rubric = () => prepareRubric("candidate answer", { config: { components } });
const reason = 'Observed {balanced} braces and a quote: "grounded"';
const verdict = JSON.stringify({
  components: [{ metric: "accuracy", pass: true, score: 1, reason }],
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
  assert.deepEqual(result.metadata, { graderError: true });
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
  assert.deepEqual(
    await gradeRubric(rubric(), "sent prompt", async () => ({ error: "Grader session failed" })),
    {
      pass: false,
      score: 0,
      reason: "Grader session failed",
      namedScores: {},
      namedScoreWeights: {},
      componentResults: [],
      tokensUsed: unmeasured(1),
      metadata: { graderError: true },
    },
  );
  const silent = await gradeRubric(rubric(), "sent prompt", async () => ({}));
  assert.equal(silent.reason, "LLM grader returned no response text");
  assert.deepEqual(silent.tokensUsed, unmeasured(1));
  assert.deepEqual(silent.metadata, { graderError: true });

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
  assert.deepEqual(cached.metadata, { graderError: true, cachedResponse: true });
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
