import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { afterEach, beforeAll, test, vi } from "vitest";
import type {
  CopilotEndpoint,
  CopilotEndpointClient,
  CopilotModel,
} from "../packages/oh-my-promptfoo/src/copilot-endpoint";
import {
  type CopilotResponsesDependencies,
  createCopilotResponsesProvider,
  type NativeResponsesProvider,
} from "../packages/oh-my-promptfoo/src/copilot-responses";
import { CopilotResponsesProvider } from "../packages/oh-my-promptfoo/src/providers";

type LoadApiProvider = (
  id: string,
  context: { options: object },
) => Promise<NativeResponsesProvider>;
let loadApiProvider: LoadApiProvider;
beforeAll(async () => {
  // No cached replies or external services, set before Promptfoo reads them.
  process.env.PROMPTFOO_CACHE_ENABLED = "false";
  process.env.PROMPTFOO_DISABLE_TELEMETRY = "1";
  process.env.PROMPTFOO_DISABLE_UPDATE = "1";
  ({ loadApiProvider } = (await import("promptfoo")) as unknown as {
    loadApiProvider: LoadApiProvider;
  });
});

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});

const model = "gpt-6-sol";
const judge = {
  config: { model, reasoning_effort: "low", response_format: { type: "json_object" } },
} as const;
const verdict = '{"pass":true,"score":1,"reason":"Loopback verdict"}';

interface Observation {
  path?: string;
  headers: IncomingHttpHeaders;
  body: Record<string, any>;
}

function reply(response: ServerResponse) {
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      id: "loopback-response",
      object: "response",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: verdict, annotations: [] }],
        },
      ],
      usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 },
    }),
  );
}

async function loopback(
  handle: (request: Observation, response: ServerResponse) => void = (_request, response) =>
    reply(response),
) {
  const requests: Observation[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const observation = {
      path: request.url,
      headers: request.headers,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    requests.push(observation);
    handle(observation, response);
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  cleanups.push(
    () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(done);
      }),
  );
  const { port } = server.address() as AddressInfo;
  return { requests, baseUrl: `http://127.0.0.1:${port}/sdk/v1?fixture=discovered` };
}

type Discover = (model: string, discovery: number) => Promise<CopilotEndpoint>;

/** Two providers over one fake SDK worker and Promptfoo's real native provider. */
function consumers(
  endpoint: Discover,
  extra: CopilotResponsesDependencies = {},
  models?: () => Promise<CopilotModel[]>,
  options: object = judge,
) {
  const evidence = {
    bootstraps: 0,
    discoveries: 0,
    constructions: 0,
    closes: 0,
    disposals: [] as number[],
  };
  const Provider = createCopilotResponsesProvider({
    createEndpointClient(): CopilotEndpointClient {
      evidence.bootstraps++;
      return {
        async endpoint(selected?: string) {
          evidence.discoveries++;
          return endpoint(selected!, evidence.discoveries);
        },
        models: models ?? (async () => []),
        async close() {
          evidence.closes++;
        },
      };
    },
    async loadProvider(id, context) {
      evidence.constructions++;
      const generation = evidence.constructions;
      const provider = await loadApiProvider(id, context);
      const cleanup = provider.cleanup?.bind(provider);
      provider.cleanup = async () => {
        evidence.disposals.push(generation);
        await cleanup?.();
      };
      return provider;
    },
    ...extra,
  });
  const first = new Provider(options);
  const second = new Provider(options);
  cleanups.push(async () => {
    await first.cleanup();
    await second.cleanup();
  });
  return { Provider, first, second, evidence };
}

function ambientOpenAi() {
  const values = {
    OPENAI_MODEL: "azure-generation-deployment",
    OPENAI_API_KEY: "ambient-azure-key",
    OPENAI_BASE_URL: "http://invalid-ambient-azure.invalid",
    OPENAI_API_HOST: "invalid-ambient-azure.invalid",
    OPENAI_ORGANIZATION: "ambient-organization",
  };
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
  return values;
}

test("instances coalesce authentication without exposing credentials or inheriting ambient OpenAI config", async () => {
  const ambient = ambientOpenAi();
  const http = await loopback();
  const secrets = ["fixture-primary-key", "fixture-additional-token", "fixture-private-header"];
  const f = consumers(async (selected) => ({
    type: "openai",
    wireApi: "responses",
    baseUrl: http.baseUrl,
    apiKey: secrets[0],
    headers: {
      "X-SDK-Required": secrets[2],
      "OpenAI-Organization": "sdk-organization",
      "X-Absent": undefined,
    },
    sessionToken: { token: secrets[1]!, header: "X-Session-Token", model: selected },
  }));
  const responses = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      (index % 2 ? f.first : f.second).callApi(`Grade local candidate ${index}`),
    ),
  );
  assert.equal(f.evidence.bootstraps, 1);
  assert.equal(f.evidence.discoveries, 1, "Unknown expiry must not invent a refresh");
  assert.equal(f.evidence.constructions, 1);
  assert.equal(http.requests.length, 8, "Authentication reuse must never reuse replies");
  for (const result of responses) {
    assert.equal(JSON.parse(result.output as string).pass, true);
    assert.equal(result.tokenUsage?.total, 9, "The native provider retains usage accounting");
  }
  for (const request of http.requests) {
    assert.equal(request.path, "/sdk/v1/responses?fixture=discovered");
    assert.equal(request.headers.authorization, `Bearer ${secrets[0]}`);
    assert.equal(request.headers["x-session-token"], secrets[1]);
    assert.equal(request.headers["x-sdk-required"], secrets[2]);
    assert.equal(request.headers["openai-organization"], "sdk-organization");
    assert.equal(request.headers["api-key"], undefined);
    assert.equal(request.body.model, model);
    assert.equal(request.body.reasoning.effort, "low");
    assert.equal(request.body.text.format.type, "json_object");
    assert.equal(request.body.store, false);
  }
  for (const provider of [f.first, f.second]) {
    assert.equal(provider.id(), `copilot:responses:${model}`);
    const serialized = [
      JSON.stringify(provider),
      JSON.stringify(provider.config),
      inspect(provider, { showHidden: true, depth: 10 }),
      JSON.stringify({ ...provider }),
    ].join("\n");
    for (const secret of [...secrets, ...Object.values(ambient)])
      assert.equal(
        serialized.includes(secret),
        false,
        "Credentials and ambient config stay private",
      );
    assert.equal(
      Reflect.ownKeys(provider).length,
      0,
      "Native providers and snapshots are not fields",
    );
  }
});

test("replies carry the model's reported token prices and still answer without them", async () => {
  ambientOpenAi();
  const http = await loopback();
  const endpoint = async () => ({ type: "openai", baseUrl: http.baseUrl, headers: {} });
  const tokenPrices = {
    inputPrice: 200,
    cacheReadPrice: 20,
    cacheWritePrice: 250,
    outputPrice: 1000,
    maxPromptTokens: 272_000,
    batchSize: 1_000_000,
    label: "private-price-text",
    longContext: {
      inputPrice: 400,
      cacheReadPrice: 40,
      cacheWritePrice: 500,
      outputPrice: 1500,
      maxPromptTokens: 872_000,
    },
  };
  const priced = consumers(endpoint, {}, async () => [
    { id: "claude-opus-5.5", billing: { tokenPrices: { ...tokenPrices, outputPrice: 2000 } } },
    { id: model, billing: { tokenPrices } },
  ]);
  const result = await priced.first.callApi("Grade local candidate");
  assert.equal(JSON.parse(result.output as string).pass, true);
  assert.equal("cost" in result, false, "OpenAI list price is not Copilot billing");
  assert.deepEqual(result.metadata?.copilotTokenPrices, {
    model,
    batchSize: 1_000_000,
    default: {
      inputPrice: 200,
      cacheReadPrice: 20,
      cacheWritePrice: 250,
      outputPrice: 1000,
      maxPromptTokens: 272_000,
    },
    longContext: {
      inputPrice: 400,
      cacheReadPrice: 40,
      cacheWritePrice: 500,
      outputPrice: 1500,
      maxPromptTokens: 872_000,
    },
  });
  for (const models of [
    async () => {
      throw new Error("model list unavailable");
    },
    async () => [{ id: model }],
  ]) {
    const unpriced = consumers(endpoint, {}, models);
    const answered = await unpriced.second.callApi("Grade local candidate");
    assert.equal(JSON.parse(answered.output as string).pass, true);
    assert.equal(answered.metadata?.copilotTokenPrices, undefined);
  }
});

test("instances with distinct request settings share one SDK worker but keep their own settings", async () => {
  ambientOpenAi();
  const http = await loopback();
  const evidence = { bootstraps: 0, discoveries: [] as string[] };
  const tokenPrices = { inputPrice: 200, outputPrice: 1000, batchSize: 1_000_000 };
  const Provider = createCopilotResponsesProvider({
    createEndpointClient() {
      evidence.bootstraps++;
      return {
        async endpoint(selected?: string) {
          evidence.discoveries.push(selected!);
          return { type: "openai", baseUrl: http.baseUrl, headers: {} };
        },
        async models() {
          return [
            { id: model, billing: { tokenPrices } },
            { id: "gpt-5.6-sol", billing: { tokenPrices } },
          ];
        },
        async close() {},
      };
    },
    loadProvider: (id, context) => loadApiProvider(id, context),
  });
  const grader = new Provider(judge);
  const candidate = new Provider({ config: { model: "gpt-5.6-sol", reasoning_effort: "medium" } });
  cleanups.push(async () => {
    await grader.cleanup();
    await candidate.cleanup();
  });
  const [graded, answer] = await Promise.all([
    grader.callApi("Grade this"),
    candidate.callApi("Answer this"),
  ]);
  assert.equal(evidence.bootstraps, 1, "Both instances reuse one SDK worker");
  assert.deepEqual(evidence.discoveries.sort(), ["gpt-5.6-sol", model]);
  const bodies = Object.fromEntries(
    http.requests.map((request) => [request.body.model, request.body]),
  );
  assert.equal(bodies[model]!.reasoning.effort, "low");
  assert.equal(bodies[model]!.text.format.type, "json_object");
  assert.equal(bodies["gpt-5.6-sol"]!.reasoning.effort, "medium");
  assert.notEqual(bodies["gpt-5.6-sol"]!.text?.format?.type, "json_object");
  assert.equal(candidate.id(), "copilot:responses:gpt-5.6-sol");
  for (const [result, expected] of [
    [graded, model],
    [answer, "gpt-5.6-sol"],
  ] as const)
    assert.deepEqual(result.metadata?.copilotTokenPrices, {
      model: expected,
      batchSize: 1_000_000,
      default: { inputPrice: 200, outputPrice: 1000 },
    });
});

test("config accepts only an explicit model, a reasoning effort and a JSON-object format", () => {
  const Provider = createCopilotResponsesProvider({
    createEndpointClient() {
      throw new Error("Construction must not connect");
    },
  });
  const accepted = new Provider({
    config: {
      model,
      reasoning_effort: "high",
      response_format: { type: "json_object" },
      basePath: "/suite",
    },
  } as object);
  assert.deepEqual(accepted.toJSON(), {
    id: `copilot:responses:${model}`,
    config: { model, reasoning_effort: "high", response_format: { type: "json_object" } },
  });
  for (const config of [
    {},
    { model: "" },
    { model: " gpt-5.6-sol" },
    { model: "gpt-5.6-sol", reasoning_effort: "extreme" },
    { model: "gpt-5.6-sol", response_format: { type: "json_schema" } },
    { model: "gpt-5.6-sol", response_format: { type: "json_object", schema: {} } },
    { model: "gpt-5.6-sol", apiBaseUrl: "http://elsewhere.invalid" },
    { model: "gpt-5.6-sol", apiKey: "redirected" },
    { model: "gpt-5.6-sol", headers: { authorization: "redirected" } },
  ])
    assert.throws(() => new Provider({ config } as object));
  assert.throws(() => new Provider());
});

test("expiry refresh is coalesced and does not mutate credentials used by an in-flight request", async () => {
  ambientOpenAi();
  let received!: () => void;
  const firstRequest = new Promise<void>((done) => {
    received = done;
  });
  let held: ServerResponse | undefined;
  const http = await loopback((_request, response) => {
    if (!held) {
      held = response;
      received();
    } else reply(response);
  });
  let clock = Date.now();
  const initial = clock;
  const f = consumers(
    async (selected, discovery) => ({
      type: "openai",
      baseUrl: http.baseUrl,
      apiKey: discovery === 1 ? "first-primary-key" : undefined,
      headers: { "X-SDK-Required": `generation-${discovery}` },
      sessionToken: {
        token: `session-${discovery}`,
        header: "X-Session-Token",
        model: selected,
        expiresAt: new Date(initial + discovery * 60_000).toISOString(),
      },
    }),
    { now: () => clock },
  );
  const original = f.first.callApi("First candidate");
  await firstRequest;
  clock += 56_000;
  await Promise.all([f.second.callApi("Second candidate"), f.first.callApi("Third candidate")]);
  assert.equal(f.evidence.bootstraps, 1);
  assert.equal(f.evidence.discoveries, 2);
  assert.equal(f.evidence.constructions, 2);
  assert.deepEqual(f.evidence.disposals, [], "The prior provider lives until its request settles");
  assert.equal(http.requests[0]!.headers.authorization, "Bearer first-primary-key");
  assert.equal(http.requests[0]!.headers["x-session-token"], "session-1");
  for (const request of http.requests.slice(1)) {
    assert.equal(
      request.headers.authorization,
      undefined,
      "A missing SDK apiKey must not fall back to OPENAI_API_KEY",
    );
    assert.equal(request.headers["x-session-token"], "session-2");
    assert.equal(request.headers["x-sdk-required"], "generation-2");
  }
  reply(held!);
  await original;
  assert.deepEqual(f.evidence.disposals, [1]);
  await f.first.cleanup();
  assert.equal(f.evidence.closes, 0, "One instance cannot close the worker another still owns");
  await f.second.cleanup();
  await f.second.cleanup();
  assert.deepEqual(f.evidence.disposals, [1, 2]);
  assert.equal(f.evidence.closes, 1);
});

test("model-bound, invalid or expired credentials never reach inference, including after a refresh", async () => {
  const http = await loopback();
  let clock = Date.now();
  let token = {
    token: "valid-initial",
    header: "X-Session-Token",
    model,
    expiresAt: new Date(clock + 60_000).toISOString(),
  };
  const f = consumers(
    async () => ({ type: "openai", baseUrl: http.baseUrl, headers: {}, sessionToken: token }),
    { now: () => clock },
  );
  await f.first.callApi("Initial valid request");
  clock += 56_000;
  for (const invalid of [
    {
      ...token,
      token: "wrong-model-secret",
      model: "another-model",
      expiresAt: new Date(clock + 60_000).toISOString(),
    },
    { ...token, token: "invalid-expiry-secret", expiresAt: "not-a-date" },
    { ...token, token: "expired-secret", expiresAt: new Date(clock - 1).toISOString() },
  ]) {
    token = invalid;
    await assert.rejects(
      Promise.all([f.first.callApi("Must not answer"), f.second.callApi("Must not answer")]),
      /different model|invalid expiry|expires too soon/,
    );
  }
  assert.equal(
    http.requests.length,
    1,
    "A rejected refresh cannot silently reuse stale credentials",
  );
  assert.equal(f.evidence.bootstraps, 1);
  assert.equal(f.evidence.discoveries, 4);
  assert.equal(f.evidence.constructions, 1);
});

test("a failed endpoint discovery closes its client and the next request bootstraps again", async () => {
  const http = await loopback();
  const f = consumers(async (_selected, discovery) => {
    if (discovery === 1) throw new Error("transient discovery failure");
    return {
      type: "openai",
      baseUrl: http.baseUrl,
      headers: {},
      sessionToken: {
        token: "valid-after-retry",
        header: "X-Session-Token",
        model,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      },
    };
  });
  await assert.rejects(f.first.callApi("First request fails"), /transient discovery failure/);
  assert.equal(f.evidence.closes, 1, "The failed client must be closed, not cached");
  const recovered = await f.second.callApi("Later request recovers");
  assert.equal(recovered.error, undefined);
  assert.equal(http.requests.length, 1);
  assert.equal(f.evidence.bootstraps, 2);
  assert.equal(f.evidence.discoveries, 2);
});

test("cancellation leaves sibling requests and the shared client alive; final cleanup drains calls", async () => {
  let bothReceived!: () => void;
  const arrivals = new Promise<void>((done) => {
    bothReceived = done;
  });
  const held = new Map<string, ServerResponse>();
  const http = await loopback((request, response) => {
    held.set(
      JSON.stringify(request.body.input).includes("Keep this request") ? "sibling" : "cancelled",
      response,
    );
    if (held.size === 2) bothReceived();
  });
  const f = consumers(async () => ({
    type: "openai",
    baseUrl: http.baseUrl,
    headers: {},
    apiKey: "abort-fixture-key",
  }));
  const controller = new AbortController();
  const cancelled = f.first.callApi("Cancel this request", undefined, {
    abortSignal: controller.signal,
  });
  const rejected = assert.rejects(cancelled, /cancelled request/);
  const sibling = f.second.callApi("Keep this request");
  await arrivals;
  controller.abort(new Error("cancelled request"));
  await rejected;
  assert.equal(f.evidence.closes, 0);
  await f.first.cleanup();
  const closed = f.second.cleanup();
  assert.equal(f.evidence.closes, 0, "Cleanup must not close discovery while a sibling is running");
  reply(held.get("sibling")!);
  assert.equal(JSON.parse((await sibling).output as string).pass, true);
  await closed;
  assert.equal(f.evidence.closes, 1);
  assert.deepEqual(f.evidence.disposals, [1]);
  await assert.rejects(f.second.callApi("Already closed"), /closed/);
});

test("constructing and serializing the exported provider is connection-free", async () => {
  vi.stubEnv("GH_TOKEN", "");
  const first = new CopilotResponsesProvider({ config: { model } });
  const second = new CopilotResponsesProvider({ config: { model } });
  assert.equal(first.id(), second.id());
  assert.deepEqual(JSON.parse(JSON.stringify(first)), {
    id: `copilot:responses:${model}`,
    config: { model },
  });
  await first.cleanup();
  await second.cleanup();
});

test("the exported provider rejects a call without GH_TOKEN instead of using stored logins", async () => {
  vi.stubEnv("GH_TOKEN", "");
  const provider = new CopilotResponsesProvider({ config: { model } });
  cleanups.push(() => provider.cleanup());
  await assert.rejects(provider.callApi("Answer this"), /GH_TOKEN/);
});
