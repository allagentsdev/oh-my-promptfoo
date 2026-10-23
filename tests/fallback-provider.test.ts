import assert from "node:assert/strict";
import { join } from "node:path";
import { assertions } from "promptfoo";
import { expect, test, vi } from "vitest";
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
  permanentError?: true;
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

const accounting = (totalNanoAiu: number) =>
  ({
    version: 1,
    source: "session.rpc.usage.getMetrics",
    scope: "session",
    unit: "nano-AIU",
    status: "complete",
    totalNanoAiu,
  }) as const;

test("exhausted fallback preserves each session snapshot and its failure diagnostics", async () => {
  const first = accounting(1_000_000_000);
  const second = {
    ...accounting(2_000_000_000),
    status: "partial",
    reason: "execution_incomplete",
  };
  const response = await fallback(
    [
      stub("first", {
        ...failing(503),
        metadata: { http: { status: 503 }, copilot: { accounting: first } },
      }),
      stub("second", { error: "Request timed out", metadata: { copilot: { accounting: second } } }),
    ],
    { cooldownMs: 0 },
  ).callApi("p");
  assert.match(response.error!, /All 2 judges failed/);
  assert.deepEqual(response.metadata?.judgeAccounting, {
    version: 1,
    attempts: [
      { cached: false, accounting: first },
      { cached: false, accounting: second },
    ],
  });
  assert.equal(meta(response).attempts.length, 2);
  assert.equal(response.cost, undefined);
});

test("fallback scalar cost requires complete same-unit accounting for every executed leaf", async () => {
  const first = accounting(1_000_000_000);
  const second = accounting(2_000_000_000);
  const measured = () =>
    stub("measured", {
      ...failing(503),
      cost: 99,
      metadata: { http: { status: 503 }, copilot: { accounting: first } },
    });
  const complete = await fallback(
    [
      measured(),
      stub("complete", {
        ...ok(),
        cost: 99,
        metadata: { copilot: { accounting: second } },
      }),
    ],
    { cooldownMs: 0 },
  ).callApi("p");
  assert.equal(complete.cost, 0.03);
  for (const last of [
    { ...ok(), cost: 0.2 },
    ok(),
    {
      ...ok(),
      cost: 99,
      metadata: { copilot: { accounting: { ...second, status: "unavailable" } } },
    },
    { ...ok(), cost: 99, metadata: { copilot: { accounting: { ...second, totalNanoAiu: -1 } } } },
  ]) {
    const response = await fallback([measured(), stub("last", last)], { cooldownMs: 0 }).callApi(
      "p",
    );
    assert.equal(response.cost, undefined);
  }
  const missingNative = await fallback(
    [stub("native-cost", { ...failing(503), cost: 0.1 }), stub("native-missing", ok())],
    { cooldownMs: 0 },
  ).callApi("p");
  assert.equal(missingNative.cost, undefined);
});

test("nested fallback accounting flattens leaves once and excludes cached snapshots", async () => {
  const first = accounting(8_000_000_000);
  const second = accounting(1_000_000_000);
  const nested = fallback(
    [
      stub("cached-failure", {
        ...failing(503),
        cached: true,
        metadata: { http: { status: 503 }, copilot: { accounting: first } },
      }),
      stub("complete", { ...ok(), metadata: { copilot: { accounting: second } } }),
    ],
    { cooldownMs: 0 },
  );
  const response = await fallback([nested], { cooldownMs: 0 }).callApi("p");
  assert.equal(response.cost, 0.01);
  assert.deepEqual(response.metadata?.judgeAccounting, {
    version: 1,
    attempts: [
      { cached: true, accounting: first },
      { cached: false, accounting: second },
    ],
  });
  assert.equal(meta(response).attempts.length, 1);
});

test("fallback transient throws remain unknown leaf attempts and block complete cost", async () => {
  const first = stub("throwing", () => {
    throw new Error("socket hang up");
  });
  const second = accounting(1_000_000_000);
  const response = await fallback(
    [first, stub("measured", { ...ok(), metadata: { copilot: { accounting: second } } })],
    { cooldownMs: 0 },
  ).callApi("p");
  assert.equal(response.output, "ok");
  assert.deepEqual(response.metadata?.judgeAccounting, {
    version: 1,
    attempts: [{ cached: false }, { cached: false, accounting: second }],
  });
  assert.equal(response.cost, undefined);
});

test("fallback ledger growth fails closed rather than reporting a truncated total", async () => {
  const leaf = accounting(1_000_000_000);
  const providers = Array.from({ length: 2 }, (_, index) =>
    stub(`large-${index}`, {
      ...(index === 0 ? failing(503) : ok()),
      metadata: {
        ...(index === 0 ? { http: { status: 503 } } : {}),
        judgeAccounting: {
          version: 1,
          attempts: Array.from({ length: 600 }, () => ({ cached: false, accounting: leaf })),
        },
      },
    }),
  );
  const response = await fallback(providers, { cooldownMs: 0 }).callApi("p");
  assert.equal(response.output, "ok");
  assert.deepEqual(response.metadata?.judgeAccounting, {
    version: 1,
    attempts: [{ cached: false }],
    copilotAccountingSeen: true,
  });
  assert.equal(response.cost, undefined);
});

for (const failure of ["call", "load"] as const) {
  test(`nested fallback retains an overflowed Copilot failure after a permanent ${failure} throw`, async () => {
    const leaf = accounting(1_000_000_000);
    const measured = Array.from({ length: 2 }, (_, index) =>
      stub(`overflow-failure-${index}`, {
        ...failing(503),
        cost: 99,
        tokenUsage: { total: 6000, prompt: 4800, completion: 1200, cached: 60, numRequests: 600 },
        metadata: {
          http: { status: 503 },
          judgeAccounting: {
            version: 1,
            attempts: Array.from({ length: 600 }, () => ({ cached: false, accounting: leaf })),
          },
        },
      }),
    );
    const permanent = new Error("API key is not set");
    const throwing = stub("overflow-permanent", () => {
      throw permanent;
    });
    const untouched = stub("overflow-untouched", ok());
    const inner = fallback(measured, { cooldownMs: 0 });
    const response = await fallback([inner, failure === "call" ? throwing : 42, untouched], {
      cooldownMs: 0,
    }).callApi("p");
    assert.match(response.error!, failure === "call" ? /API key is not set/ : /A judge must be/);
    assert.equal(response.output, undefined);
    assert.equal(meta(response).permanentError, true);
    assert.equal(meta(response).attempts.length, 2);
    assert.equal(untouched.calls.length, 0);
    assert.deepEqual(response.metadata?.judgeAccounting, {
      version: 1,
      attempts: [{ cached: false }, { cached: false }],
      copilotAccountingSeen: true,
    });
    assert.equal(response.cost, undefined);
    assert.deepEqual(response.tokenUsage, {
      total: 12_000,
      prompt: 9600,
      completion: 2400,
      cached: 120,
      numRequests: 1201,
    });
  });
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

test.each([
  { name: "Error", permanent: new Error("API key is not set") },
  { name: "frozen Error", permanent: Object.freeze(new Error("API key is not set")) },
  { name: "primitive", permanent: "API key is not set" },
  { name: "opaque", permanent: Object.create(null) },
  { name: "frozen opaque", permanent: Object.freeze(Object.create(null)) },
])("re-throws a non-transient thrown error ($name)", async ({ permanent }) => {
  const first = stub("nokey", () => {
    throw permanent;
  });
  const second = stub("second", ok());
  await assert.rejects(fallback([first, second]).callApi("p"), (error) => error === permanent);
  await assert.rejects(
    fallback([stub("native-503", failing(503)), first, second], { cooldownMs: 0 }).callApi("p"),
    (error) => error === permanent,
  );
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
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 1_000);
  try {
    const response = await fallback([first, second], { cooldownMs: 20 }).callApi("p");
    assert.equal(response.output, "first");
  } finally {
    vi.useRealTimers();
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

test("sums complete native usage and cost across attempts and records diagnostics", async () => {
  const first = stub("usage-a", {
    error: "API error: 500",
    cost: 0.01,
    tokenUsage: { total: 10, prompt: 8, completion: 2, cached: 0 },
    metadata: { http: { status: 500 } },
  });
  const second = stub("usage-b", { ...failing(502), cost: 0 });
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
  assert.equal(response.cost, 0.01);
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
      basePath: join(import.meta.dirname, "fixtures"),
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
  const judge = join(import.meta.dirname, "fixtures", "fallback-judge.mjs");
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

test("the same relative judge in another suite's directory cools separately", async () => {
  const spec = { id: "file://judge.mjs", label: unique("relative-judge") };
  const suite = (directory: string) =>
    new FallbackProvider({
      config: {
        providers: [spec, stub("suite-backup", ok("backup"))],
        cooldownMs: 60_000,
        basePath: join(import.meta.dirname, "fixtures", directory),
      },
    });
  const limited = await suite("basepath-failing").callApi("p");
  assert.equal(limited.output, "backup");
  const other = await suite("basepath-answering").callApi("p");
  assert.equal(other.output, "answered from its own suite");
  assert.equal(meta(other).answeredBy, spec.label);
  const again = await suite("basepath-failing").callApi("p");
  assert.equal(meta(again).attempts.length, 1);
  assert.equal(again.output, "backup");
});

test("nested fallback retains accounted permanent throws without trying any backup", async () => {
  const measured = accounting(1_000_000_000);
  const first = () =>
    stub("accounted", {
      ...failing(503),
      metadata: {
        http: { status: 503 },
        copilot: { accounting: measured },
        diagnostic: "retained",
      },
    });
  const throwing = stub("permanent", () => {
    throw new Error("API key is not set");
  });
  const untouched = stub("untouched", ok());
  const outerBackup = stub("outer-backup", ok());
  const middleBackup = stub("middle-backup", ok());
  const inner = fallback([first(), throwing, untouched], { cooldownMs: 0 });
  const middle = fallback([inner, middleBackup], { cooldownMs: 0 });
  const response = await fallback([middle, outerBackup], { cooldownMs: 0 }).callApi("p");
  assert.equal(response.error, "API key is not set");
  assert.equal(untouched.calls.length, 0);
  assert.equal(middleBackup.calls.length, 0);
  assert.equal(outerBackup.calls.length, 0);
  assert.equal(meta(response).permanentError, true);
  assert.equal(response.metadata?.http, undefined);
  assert.equal(response.metadata?.diagnostic, "retained");
  assert.deepEqual(response.metadata?.judgeAccounting, {
    version: 1,
    attempts: [{ cached: false, accounting: measured }, { cached: false }],
  });
  assert.equal(response.cost, undefined);
  assert.equal(response.tokenUsage?.numRequests, 2);
  const abort = new AbortController();
  const cancelled = new Error("Evaluation cancelled");
  const cancelling = stub("cancelled", () => {
    abort.abort(cancelled);
    throw cancelled;
  });
  await assert.rejects(
    fallback([first(), cancelling], { cooldownMs: 0 }).callApi("p", undefined, {
      abortSignal: abort.signal,
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
  "outer Copilot accounting retains native inner fallback leaves before a permanent throw ($name)",
  async ({ permanent, message }) => {
    const measured = accounting(1_000_000_000);
    const first = stub("outer-accounted", {
      ...failing(503),
      tokenUsage: { total: 6, prompt: 4, completion: 2, numRequests: 1 },
      metadata: { http: { status: 503 }, copilot: { accounting: measured } },
    });
    const native = stub("inner-native", {
      ...failing(503),
      cost: 0.1,
      tokenUsage: { total: 10, prompt: 7, completion: 3, cached: 2, numRequests: 1 },
    });
    const throwing = stub("inner-permanent", () => {
      throw permanent;
    });
    const innerBackup = stub("inner-never", ok());
    const outerBackup = stub("outer-never", ok());
    const inner = fallback([native, throwing, innerBackup], { cooldownMs: 0 });
    const response = await fallback([first, inner, outerBackup], { cooldownMs: 0 }).callApi("p");
    assert.equal(typeof response.error, "string");
    assert.ok(response.error!.trim().length > 0);
    if (message !== undefined) assert.equal(response.error, message);
    assert.equal(meta(response).permanentError, true);
    assert.equal(innerBackup.calls.length, 0);
    assert.equal(outerBackup.calls.length, 0);
    assert.deepEqual(response.metadata?.judgeAccounting, {
      version: 1,
      attempts: [{ cached: false, accounting: measured }, { cached: false }, { cached: false }],
    });
    assert.equal(response.cost, undefined);
    assert.deepEqual(response.tokenUsage, {
      total: 16,
      prompt: 11,
      completion: 5,
      cached: 2,
      numRequests: 3,
    });
    await assert.rejects(inner.callApi("p"), (error) => error === permanent);
  },
);

test("concurrent nested fallback failures keep invocation-local evidence for a shared frozen Error", async () => {
  const permanent = Object.freeze(new Error("API key is not set"));
  let arrivals = 0;
  let release!: () => void;
  const bothStarted = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = (nanoAiu: number, nativePrompt: number) => {
    const measured = accounting(nanoAiu);
    const native = stub("concurrent-native", async () => {
      if (++arrivals === 2) release();
      await bothStarted;
      return {
        ...failing(503),
        tokenUsage: {
          total: nativePrompt + 2,
          prompt: nativePrompt,
          completion: 2,
          numRequests: 1,
        },
      };
    });
    const throwing = stub("concurrent-permanent", () => {
      throw permanent;
    });
    const inner = fallback([native, throwing], { cooldownMs: 0 });
    const first = stub("concurrent-accounted", {
      ...failing(503),
      tokenUsage: { total: 6, prompt: 4, completion: 2, numRequests: 1 },
      metadata: { http: { status: 503 }, copilot: { accounting: measured } },
    });
    return fallback([first, inner], { cooldownMs: 0 }).callApi("p");
  };
  const [first, second] = await Promise.all([run(1_000_000_000, 8), run(2_000_000_000, 18)]);
  for (const [response, nanoAiu, total, prompt] of [
    [first, 1_000_000_000, 16, 12],
    [second, 2_000_000_000, 26, 22],
  ] as const) {
    assert.equal(response.error, "API key is not set");
    assert.equal(response.cost, undefined);
    assert.deepEqual(response.metadata?.judgeAccounting, {
      version: 1,
      attempts: [
        { cached: false, accounting: accounting(nanoAiu) },
        { cached: false },
        { cached: false },
      ],
    });
    assert.deepEqual(response.tokenUsage, {
      total,
      prompt,
      completion: 4,
      cached: 0,
      numRequests: 3,
    });
  }
});

test("nested native fallback AbortError preserves cancellation after outer Copilot accounting", async () => {
  const measured = accounting(1_000_000_000);
  const cancelled = new DOMException("Evaluation cancelled", "AbortError");
  const throwing = stub("inner-aborted", () => {
    throw cancelled;
  });
  const innerBackup = stub("inner-abort-never", ok());
  const outerBackup = stub("outer-abort-never", ok());
  const inner = fallback([stub("inner-before-abort", failing(503)), throwing, innerBackup], {
    cooldownMs: 0,
  });
  const first = stub("outer-before-abort", {
    ...failing(503),
    metadata: { http: { status: 503 }, copilot: { accounting: measured } },
  });
  await assert.rejects(
    fallback([first, inner, outerBackup], { cooldownMs: 0 }).callApi("p"),
    (error) => error === cancelled,
  );
  assert.equal(innerBackup.calls.length, 0);
  assert.equal(outerBackup.calls.length, 0);
});

test("exhausted fallback retains complete reported totals without summing event or provider costs", async () => {
  const leaves = [accounting(1_000_000_000), accounting(2_000_000_000)];
  const response = await fallback(
    leaves.map((accounting, index) =>
      stub(`complete-failure-${index}`, {
        ...failing(503),
        cost: 99,
        metadata: {
          http: { status: 503 },
          copilot: { accounting, premiumRequestUsage: { reportedCost: 99 } },
        },
      }),
    ),
    { cooldownMs: 0 },
  ).callApi("p");
  assert.match(response.error!, /All 2 judges failed/);
  assert.equal(response.cost, 0.03);
  assert.deepEqual(response.metadata?.judgeAccounting, {
    version: 1,
    attempts: leaves.map((accounting) => ({ cached: false, accounting })),
  });
});

test("nested fallback ignores cached unknown or partial coverage when live leaves are complete", async () => {
  for (const cachedMetadata of [
    undefined,
    { copilot: { accounting: { ...accounting(7), status: "partial" } } },
  ]) {
    const live = accounting(1_000_000_000);
    const cached = stub("cached", {
      error: "Request timed out",
      cached: true,
      metadata: cachedMetadata,
    });
    const measured = stub("measured", { ...ok(), metadata: { copilot: { accounting: live } } });
    const nested = fallback([cached, measured], { cooldownMs: 0 });
    const response = await fallback([nested], { cooldownMs: 0 }).callApi("p");
    assert.equal(response.cost, 0.01);
    const result = response.metadata?.judgeAccounting;
    assert.ok(
      result &&
        typeof result === "object" &&
        "attempts" in result &&
        Array.isArray(result.attempts),
    );
    assert.equal(result.attempts.length, 2);
  }
});

test("nested fallback preserves permanent loading errors containing 503", async () => {
  const measured = accounting(1_000_000_000);
  const first = stub("accounted-load", {
    ...failing(503),
    metadata: { http: { status: 503 }, copilot: { accounting: measured } },
  });
  const untouched = stub("untouched-load", ok());
  const outerBackup = stub("outer-load-backup", ok());
  const middleBackup = stub("middle-load-backup", ok());
  const inner = fallback([first, 503, untouched], { cooldownMs: 0 });
  const middle = fallback([inner, middleBackup], { cooldownMs: 0 });
  const response = await fallback([middle, outerBackup], { cooldownMs: 0 }).callApi("p");
  assert.match(response.error!, /A judge must be/);
  assert.match(response.error!, /503/);
  assert.equal(meta(response).permanentError, true);
  assert.equal(response.metadata?.http, undefined);
  assert.equal(middleBackup.calls.length, 0);
  assert.equal(outerBackup.calls.length, 0);
  assert.equal(untouched.calls.length, 0);
  assert.deepEqual(response.metadata?.judgeAccounting, {
    version: 1,
    attempts: [{ cached: false, accounting: measured }, { cached: false }],
  });
  assert.equal(response.cost, undefined);
  assert.equal(response.tokenUsage?.numRequests, 2);
  await assert.rejects(fallback([42, untouched]).callApi("p"), /A judge must be/);
});
