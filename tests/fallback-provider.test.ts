import { expect, setSystemTime, test } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { assertions } from "promptfoo";
import { FallbackProvider } from "../packages/oh-my-promptfoo/src/providers";

type Reply = {
  output?: unknown;
  error?: string;
  cached?: boolean;
  cost?: number;
  tokenUsage?: Record<string, number>;
  metadata?: Record<string, unknown>;
};

type FallbackMetadata = {
  answeredBy?: string;
  attempts: {
    provider: string;
    status?: number;
    error?: string;
    cached: boolean;
    latencyMs: number;
  }[];
};

let counter = 0;
const unique = (name: string) => `${name}-${process.pid}-${++counter}`;

/** A stub judge; `reply` is a reply, a thrower, or a per-call function. */
function stub(name: string, reply: Reply | (() => Reply | Promise<Reply>), label?: string) {
  const calls: { prompt: string; context?: object; options?: object }[] = [];
  const id = unique(name);
  return {
    calls,
    label,
    id: () => id,
    async callApi(prompt: string, context?: object, options?: object) {
      calls.push({ prompt, context, options });
      return typeof reply === "function" ? reply() : reply;
    },
  };
}

const failing = (status: number, extra: Record<string, unknown> = {}): Reply => ({
  error: `API error: ${status}`,
  metadata: { http: { status, statusText: "x", ...extra } },
});
const ok = (output = "ok"): Reply => ({
  output,
  tokenUsage: { total: 3, prompt: 2, completion: 1 },
});

function fallback(providers: unknown[], extra: Record<string, unknown> = {}) {
  return new FallbackProvider({ config: { providers, ...extra } });
}

function meta(response: { metadata?: Record<string, unknown> }): FallbackMetadata {
  return response.metadata?.fallback as FallbackMetadata;
}

for (const status of [408, 429, 500, 503, 0]) {
  test(`fails over on HTTP status ${status}`, async () => {
    const first = stub("status", failing(status));
    const second = stub("second", ok("from second"));
    const response = await fallback([first, second], { cooldownMs: 0 }).callApi("p");
    assert.equal(response.output, "from second");
    assert.equal(response.error, undefined);
    assert.equal(first.calls.length, 1);
    assert.equal(meta(response).attempts[0]?.status, status);
  });
}

for (const message of ["Request timed out", "read ECONNRESET"]) {
  test(`fails over on status-less transient error "${message}"`, async () => {
    const first = stub("transient", { error: message });
    const second = stub("second", ok());
    const response = await fallback([first, second], { cooldownMs: 0 }).callApi("p");
    assert.equal(response.output, "ok");
    assert.equal(meta(response).attempts[0]?.error, message);
  });
}

test("fails over when a judge throws a transient error", async () => {
  const first = stub("throws", () => {
    throw new Error("socket hang up");
  });
  const second = stub("second", ok());
  const response = await fallback([first, second], { cooldownMs: 0 }).callApi("p");
  assert.equal(response.output, "ok");
  assert.equal(meta(response).attempts[0]?.error, "socket hang up");
});

test("returns the first success without calling later judges", async () => {
  const first = stub("first", ok("first"));
  const second = stub("second", ok("second"));
  const response = await fallback([first, second]).callApi("p");
  assert.equal(response.output, "first");
  assert.equal(second.calls.length, 0);
});

for (const status of [400, 401, 404]) {
  test(`stops on HTTP status ${status} and returns that error`, async () => {
    const first = stub("client", failing(status));
    const second = stub("second", ok());
    const response = await fallback([first, second]).callApi("p");
    assert.equal(response.error, `API error: ${status}`);
    assert.equal(second.calls.length, 0);
    assert.equal(meta(response).answeredBy, first.id());
  });
}

test("stops on a status-less non-transient error", async () => {
  const first = stub("bad", { error: "Invalid JSON in response" });
  const second = stub("second", ok());
  const response = await fallback([first, second]).callApi("p");
  assert.equal(response.error, "Invalid JSON in response");
  assert.equal(second.calls.length, 0);
});

test("re-throws a non-transient thrown error", async () => {
  const first = stub("nokey", () => {
    throw new Error("API key is not set");
  });
  const second = stub("second", ok());
  await expect(fallback([first, second]).callApi("p")).rejects.toThrow("API key is not set");
  assert.equal(second.calls.length, 0);
});

test("reports every judge when all fail", async () => {
  const first = stub("a", failing(503), "Judge A");
  const second = stub("b", { error: "Request timed out" });
  const response = await fallback([first, second], { cooldownMs: 0 }).callApi("p");
  assert.ok(response.error?.startsWith("All 2 judges failed:"), response.error);
  assert.ok(response.error?.includes("Judge A: API error: 503"));
  assert.ok(response.error?.includes(`${second.id()}: Request timed out`));
  assert.equal(meta(response).attempts.length, 2);
});

test("skips a judge cooling down after a retryable failure", async () => {
  let fail = true;
  const first = stub("cool", () => (fail ? failing(429) : ok("first")));
  const second = stub("second", ok("second"));
  await fallback([first, second], { cooldownMs: 60_000 }).callApi("p");
  fail = false;
  const response = await fallback([first, second], { cooldownMs: 60_000 }).callApi("p");
  assert.equal(response.output, "second");
  assert.equal(first.calls.length, 1);
});

test("cooldownMs 0 without Retry-After does not skip", async () => {
  let fail = true;
  const first = stub("nocool", () => (fail ? failing(500) : ok("first")));
  const second = stub("second", ok("second"));
  await fallback([first, second], { cooldownMs: 0 }).callApi("p");
  fail = false;
  const response = await fallback([first, second], { cooldownMs: 0 }).callApi("p");
  assert.equal(response.output, "first");
});

const retryAfter: [string, () => Reply][] = [
  ["retry-after seconds", () => failing(429, { headers: { "Retry-After": "60" } })],
  ["retry-after-ms", () => failing(429, { headers: { "retry-after-ms": "60000" } })],
  [
    "retry-after HTTP date",
    () =>
      failing(503, {
        headers: { "retry-after": new Date(Date.now() + 120_000).toUTCString() },
      }),
  ],
  [
    "metadata.headers",
    () => ({ error: "rate limit", metadata: { headers: { "retry-after": "60" } } }),
  ],
  ["message retry after N", () => ({ error: "Rate limited, retry after 60 seconds" })],
];

for (const [name, reply] of retryAfter) {
  test(`${name} lengthens the cooldown beyond cooldownMs`, async () => {
    let fail = true;
    const first = stub("retryafter", () => (fail ? reply() : ok("first")));
    const second = stub("second", ok("second"));
    await fallback([first, second], { cooldownMs: 0 }).callApi("p");
    fail = false;
    const response = await fallback([first, second], { cooldownMs: 0 }).callApi("p");
    assert.equal(response.output, "second");
    assert.equal(first.calls.length, 1);
  });
}

test("short cooldown expires and the judge is tried again", async () => {
  let fail = true;
  const first = stub("expire", () => (fail ? failing(500) : ok("first")));
  const second = stub("second", ok("second"));
  await fallback([first, second], { cooldownMs: 20 }).callApi("p");
  fail = false;
  setSystemTime(new Date(Date.now() + 1_000));
  try {
    const response = await fallback([first, second], { cooldownMs: 20 }).callApi("p");
    assert.equal(response.output, "first");
  } finally {
    setSystemTime();
  }
});

test("when every judge is cooling, tries the one whose cooldown ends first", async () => {
  let fail = true;
  const first = stub("long", () =>
    fail ? failing(429, { headers: { "retry-after": "120" } }) : ok("first"),
  );
  const second = stub("short", () =>
    fail ? failing(429, { headers: { "retry-after": "60" } }) : ok("second"),
  );
  const all = await fallback([first, second], { cooldownMs: 0 }).callApi("p");
  assert.ok(all.error?.startsWith("All 2 judges failed:"));
  fail = false;
  const response = await fallback([first, second], { cooldownMs: 0 }).callApi("p");
  assert.equal(response.output, "second");
  assert.equal(first.calls.length, 1);
  assert.equal(meta(response).attempts.length, 1);
});

test("success clears a judge's cooldown", async () => {
  let firstFails = true;
  let secondFails = true;
  const first = stub("clear", () => (firstFails ? failing(503) : ok("first")));
  const second = stub("other", () => (secondFails ? failing(503) : ok("second")));
  // Both cool for a minute; the next call tries `first` (equal-or-earlier end), which succeeds.
  await fallback([first, second], { cooldownMs: 60_000 }).callApi("p");
  firstFails = false;
  const recovered = await fallback([first], { cooldownMs: 60_000 }).callApi("p");
  assert.equal(recovered.output, "first");
  secondFails = false;
  // `first` no longer cools, so it answers ahead of `second` (still cooling).
  const response = await fallback([first, second], { cooldownMs: 60_000 }).callApi("p");
  assert.equal(response.output, "first");
  assert.equal(meta(response).attempts.length, 1);
});

test("sums usage and cost across attempts and records attempts", async () => {
  const first = stub("usage-a", {
    error: "API error: 500",
    cost: 0.01,
    tokenUsage: { total: 10, prompt: 8, completion: 2, cached: 0 },
    metadata: { http: { status: 500 } },
  });
  const second = stub("usage-b", failing(502));
  const third = stub(
    "usage-c",
    {
      output: "done",
      cached: true,
      cost: 0.02,
      tokenUsage: { total: 5, prompt: 4, completion: 1, cached: 5 },
      metadata: { own: "kept" },
    },
    "Third Judge",
  );
  const response = await fallback([first, second, third], { cooldownMs: 0 }).callApi("p");
  assert.deepEqual(response.tokenUsage, {
    total: 15,
    prompt: 12,
    completion: 3,
    cached: 5,
    numRequests: 2,
  });
  assert.ok(Math.abs((response.cost ?? 0) - 0.03) < 1e-9);
  assert.equal(response.metadata?.own, "kept");
  const fallbackMeta = meta(response);
  assert.equal(fallbackMeta.answeredBy, "Third Judge");
  assert.deepEqual(
    fallbackMeta.attempts.map(({ latencyMs, ...rest }) => {
      assert.equal(typeof latencyMs, "number");
      return rest;
    }),
    [
      { provider: first.id(), status: 500, error: "API error: 500", cached: false },
      { provider: second.id(), status: 502, error: "API error: 502", cached: false },
      { provider: "Third Judge", cached: true },
    ],
  );
});

test("validates its config", () => {
  assert.throws(() => new FallbackProvider({}), /config\.providers/);
  assert.throws(() => new FallbackProvider({ config: { providers: [] } }), /config\.providers/);
  const providers = [stub("v", ok())];
  assert.throws(
    () => new FallbackProvider({ config: { providers, cooldownMs: -1 } }),
    /cooldownMs/,
  );
  assert.throws(
    () => new FallbackProvider({ config: { providers, cooldownMs: 1.5 } }),
    /cooldownMs/,
  );
  assert.equal(new FallbackProvider({ config: { providers } }).handlesOwnRetries, true);
});

test("loads relative file:// judges against config.basePath", async () => {
  const label = unique("Fixture Judge");
  const provider = new FallbackProvider({
    config: {
      basePath: join(import.meta.dir, "fixtures"),
      providers: [{ id: "file://fallback-judge.mjs", label, config: { output: "from fixture" } }],
    },
  });
  const response = await provider.callApi("p");
  assert.equal(response.error, undefined);
  assert.equal(response.output, "from fixture");
  assert.equal(response.metadata?.from, "fixture");
  assert.equal(meta(response).answeredBy, label);
});

test("passes context and options through unchanged", async () => {
  const first = stub("ctx-a", failing(500));
  const second = stub("ctx-b", ok());
  const context = { prompt: { raw: "p", label: "x" }, vars: { a: 1 }, bustCache: true };
  const options = { includeLogProbs: true };
  await fallback([first, second], { cooldownMs: 0 }).callApi("the prompt", context, options);
  for (const judge of [first, second]) {
    assert.equal(judge.calls[0]?.prompt, "the prompt");
    assert.equal(judge.calls[0]?.context, context);
    assert.equal(judge.calls[0]?.options, options);
  }
});

test("native llm-rubric grades through FallbackProvider", async () => {
  const first = stub("rubric-a", {
    ...failing(500),
    tokenUsage: { total: 4, prompt: 4, completion: 0 },
  });
  const second = stub(
    "rubric-b",
    {
      output: JSON.stringify({ pass: true, score: 1, reason: "Polite greeting" }),
      tokenUsage: { total: 10, prompt: 7, completion: 3 },
    },
    "Backup Judge",
  );
  const provider = new FallbackProvider({ config: { providers: [first, second], cooldownMs: 0 } });
  const result = await assertions.runAssertion({
    assertion: { type: "llm-rubric", value: "The reply greets the user politely" },
    test: { vars: {}, options: { provider } },
    providerResponse: { output: "Hello, nice to meet you!" },
  });
  assert.equal(result.pass, true, result.reason);
  assert.equal(result.reason, "Polite greeting");
  assert.equal(second.calls.length, 1);
  const fallbackMeta = (result.metadata as Record<string, unknown> | undefined)?.fallback as
    | FallbackMetadata
    | undefined;
  assert.equal(fallbackMeta?.answeredBy, "Backup Judge");
  assert.equal(fallbackMeta?.attempts.length, 2);
  assert.equal(result.tokensUsed?.total, 14);
  assert.equal(result.tokensUsed?.prompt, 11);
  assert.equal(result.tokensUsed?.completion, 3);
});
