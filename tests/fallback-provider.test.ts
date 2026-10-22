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

test("a cancelled evaluation propagates instead of failing over", async () => {
  const aborted = new AbortController();
  aborted.abort(new Error("eval cancelled"));
  const untouched = stub("untouched", ok());
  await expect(
    fallback([untouched]).callApi("p", undefined, { abortSignal: aborted.signal }),
  ).rejects.toThrow("eval cancelled");
  assert.equal(untouched.calls.length, 0);

  const during = new AbortController();
  const primary = stub("cancelled", () => {
    during.abort(new Error("eval cancelled mid-call"));
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });
  const secondary = stub("never", ok());
  await expect(
    fallback([primary, secondary]).callApi("p", undefined, { abortSignal: during.signal }),
  ).rejects.toThrow("eval cancelled mid-call");
  assert.equal(secondary.calls.length, 0);

  const returned = new AbortController();
  const status0 = stub("status0", () => {
    returned.abort(new Error("eval cancelled after reply"));
    return failing(0);
  });
  const after = stub("after", ok());
  await expect(
    fallback([status0, after]).callApi("p", undefined, { abortSignal: returned.signal }),
  ).rejects.toThrow("eval cancelled after reply");
  assert.equal(after.calls.length, 0);
  // The cancelled judge was not put in cooldown: a later run tries it first.
  const again = await fallback([status0, after]).callApi("p");
  assert.equal(status0.calls.length, 2);
  assert.equal(meta(again).attempts[0]?.provider, status0.id());
});

test("a judge's own timeout fails over while the caller's signal is live", async () => {
  const live = new AbortController();
  const timedOut = stub("own-timeout", () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });
  const backup = stub("backup", ok("backup"));
  const response = await fallback([timedOut, backup], { cooldownMs: 0 }).callApi("p", undefined, {
    abortSignal: live.signal,
  });
  assert.equal(response.output, "backup");
});

test("transient errors are classified as Promptfoo classifies them", async () => {
  const brokenPipe = stub("epipe", () => {
    throw Object.assign(new Error("write failed"), { code: "EPIPE" });
  });
  const backup = stub("backup", ok("backup"));
  assert.equal(
    (await fallback([brokenPipe, backup], { cooldownMs: 0 }).callApi("p")).output,
    "backup",
  );

  const certificate = stub("tls", () => {
    throw new Error("write EPROTO: self signed certificate in certificate chain");
  });
  const unused = stub("unused", ok());
  await expect(fallback([certificate, unused]).callApi("p")).rejects.toThrow("self signed");
  assert.equal(unused.calls.length, 0);

  const wrongVersion = stub("tls-reply", { error: "EPROTO wrong version number" });
  const response = await fallback([wrongVersion, unused]).callApi("p");
  assert.equal(response.error, "EPROTO wrong version number");
  assert.equal(unused.calls.length, 0);
});

test("cooldowns are kept per judge identity, not per provider id", async () => {
  // Two live instances that share an id are different judges.
  const shared = unique("same-id");
  const make = (reply: () => Reply) => ({ id: () => shared, callApi: async () => reply() });
  const limited = make(() => failing(429));
  const healthy = make(() => ok("healthy"));
  const first = await fallback([limited, healthy], { cooldownMs: 60_000 }).callApi("p");
  assert.equal(first.output, "healthy");
  const second = await fallback([healthy], { cooldownMs: 60_000 }).callApi("p");
  assert.equal(second.output, "healthy");
  assert.equal(meta(second).attempts.length, 1);
  // The backup's success did not clear the primary's cooldown.
  const third = await fallback([limited, healthy], { cooldownMs: 60_000 }).callApi("p");
  assert.equal(meta(third).attempts.length, 1);

  // The same spec loaded under another environment is another account's judge.
  const judge = join(import.meta.dir, "fixtures", "fallback-judge.mjs");
  const spec = { id: `file://${judge}`, label: unique("env-judge"), config: { fail: 429 } };
  const withEnv = (account: string) =>
    new FallbackProvider({
      config: { providers: [spec, stub("env-backup", ok("backup"))], cooldownMs: 60_000 },
      env: { ACCOUNT: account },
    });
  await withEnv("a").callApi("p");
  const otherAccount = await withEnv("b").callApi("p");
  assert.equal(meta(otherAccount).attempts[0]?.provider, spec.label);
  const sameAccount = await withEnv("a").callApi("p");
  assert.notEqual(meta(sameAccount).attempts[0]?.provider, spec.label);
});
