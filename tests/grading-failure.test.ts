import { test } from "bun:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { llmAssert } from "../packages/oh-my-promptfoo/src/assertions";
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

test("retry execution failures retain the malformed first reply's usage", async () => {
  let attempts = 0;
  const result = await gradeRubric(rubric(), "sent prompt", async () => {
    if (++attempts === 1) return { text: "not JSON", usage: { prompt: 10, completion: 2 } };
    throw new Error("Grader session disconnected");
  });
  assert.equal(attempts, 2);
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
    numRequests: 1,
  });
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

test("unmeasured grading failures keep their existing thrown error behavior", async () => {
  const executionError = new Error("Grader could not start");
  await assert.rejects(
    gradeRubric(rubric(), "sent prompt", async () => {
      throw executionError;
    }),
    (error) => error === executionError,
  );
  await assert.rejects(
    gradeRubric(rubric(), "sent prompt", async () => ({ error: "Grader session failed" })),
    /Grader session failed/,
  );
  let attempts = 0;
  await assert.rejects(
    gradeRubric(rubric(), "sent prompt", async () => {
      attempts++;
      return { text: "not JSON", usage: { prompt: -1, completion: "unknown" } };
    }),
    /malformed JSON/,
  );
  assert.equal(attempts, 2);
});

test("llmAssert reports usage for retry HTTP failures and empty billed replies", async () => {
  const environmentKeys = ["OPENAI_MODEL", "OPENAI_API_KEY", "OPENAI_BASE_URL"] as const;
  const previous = Object.fromEntries(environmentKeys.map((name) => [name, process.env[name]]));
  const replies = [
    {
      status: 200,
      body: { choices: [{ message: { content: `The verdict:\n\`\`\`json\n${verdict}\n\`\`\`` } }] },
    },
    {
      status: 200,
      body: {
        choices: [{ message: { content: "not JSON" } }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      },
    },
    { status: 503, body: {} },
    {
      status: 200,
      body: { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } },
    },
    { status: 503, body: {} },
  ];
  let attempts = 0;
  const server = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    const next = replies[attempts++];
    response.writeHead(next?.status ?? 500, { "content-type": "application/json" });
    response.end(JSON.stringify(next?.body ?? {}));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server port");
    process.env.OPENAI_MODEL = "fake-grader";
    process.env.OPENAI_API_KEY = "local-only";
    process.env.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
    const context = { config: { components } };
    const wrapped = await llmAssert("candidate answer", context);
    assert.equal(wrapped.pass, true);
    assert.equal(attempts, 1);

    const retryFailure = await llmAssert("candidate answer", context);
    assert.equal(retryFailure.pass, false);
    assert.equal(retryFailure.score, 0);
    assert.match(retryFailure.reason, /LLM grading failed with HTTP 503/);
    assert.deepEqual(retryFailure.tokensUsed, {
      prompt: 5,
      completion: 1,
      total: 6,
      cached: 0,
      numRequests: 1,
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

    await assert.rejects(llmAssert("candidate answer", context), /HTTP 503/);
    assert.equal(attempts, 5);
  } finally {
    server.close();
    for (const name of environmentKeys) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
