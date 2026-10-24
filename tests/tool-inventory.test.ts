import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import * as assertions from "../packages/oh-my-promptfoo/src/assertions";
import { Agent, CopilotSdk } from "../packages/oh-my-promptfoo/src/providers";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function sdkProvider(prepare?: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(realpathSync.native(tmpdir()), "tool-inventory-"));
  roots.push(root);
  const sdk = join(root, "node_modules", "@github", "copilot-sdk");
  await mkdir(sdk, { recursive: true });
  await writeFile(
    join(sdk, "package.json"),
    JSON.stringify({ type: "module", exports: "./index.js" }),
  );
  await writeFile(
    join(sdk, "index.js"),
    await readFile(new URL("./fixtures/copilot-sdk.mjs", import.meta.url), "utf8"),
  );
  await prepare?.(root);
  return new CopilotSdk({
    config: {
      basePath: root,
      working_dir: ".",
      timeoutMs: 10_000,
      env: { INVENTORY_TEST_TOKEN: "inventory-secret-value" },
    },
  });
}
const start = (id: string, name = "read", args: unknown = {}, timestamp?: string) => ({
  type: "tool.execution_start",
  ...(timestamp ? { timestamp } : {}),
  data: { toolCallId: id, toolName: name, arguments: args },
});
const end = (id: string, success = true, timestamp?: string) => ({
  type: "tool.execution_complete",
  ...(timestamp ? { timestamp } : {}),
  data: { toolCallId: id, success },
});
const lifecycle = (type: "started" | "completed" | "failed", id: string, data = {}) => ({
  type: `subagent.${type}`,
  data: { toolCallId: id, ...data },
});
async function response(scenario: object) {
  const provider = await sdkProvider();
  try {
    return await provider.callApi(`inventory:${JSON.stringify(scenario)}`);
  } finally {
    await provider.cleanup();
  }
}
function childStart(id: string, parent: string, agentId?: string) {
  const event = start(id);
  return {
    ...event,
    ...(agentId ? { agentId } : {}),
    data: { ...event.data, parentToolCallId: parent },
  };
}
function childEnd(id: string, parent: string) {
  const event = end(id);
  return { ...event, data: { ...event.data, parentToolCallId: parent } };
}
function inventory(result: Awaited<ReturnType<typeof response>>) {
  const metadata = result.metadata as { toolInventory: assertions.ToolInventory };
  return metadata.toolInventory;
}
function grade(
  result: Awaited<ReturnType<typeof response>>,
  entity: "tool-called" | "tool-not-called" | "skill-not-loaded",
  config: unknown = { name: "forbidden" },
) {
  return assertions[entity](result.output, { providerResponse: result, config });
}
function allFailClosed(result: Awaited<ReturnType<typeof response>>) {
  for (const entity of ["tool-called", "tool-not-called", "skill-not-loaded"] as const)
    expect(grade(result, entity)).toMatchObject({
      pass: false,
      score: 0,
      metadata: { graderError: true },
    });
}

describe("adapter-owned complete tool inventory", () => {
  test("zero-call clean streams prove absence, not occurrence", async () => {
    const result = await response({});
    expect(result.error).toBeUndefined();
    expect(inventory(result)).toEqual({
      schemaVersion: 1,
      status: "complete",
      incompleteReasons: [],
      calls: [],
      skillInventory: "sdk",
      loadedSkills: [],
    });
    expect(grade(result, "tool-not-called").pass).toBe(true);
    expect(grade(result, "tool-called").pass).toBe(false);
    expect(grade(result, "skill-not-loaded").pass).toBe(true);
    expect(
      grade(result, "tool-not-called", { name: "forbidden", before: { name: "missing-anchor" } }),
    ).toMatchObject({ pass: false, metadata: { graderError: true } });
  });
  test("missing tool arguments cannot certify argument-sensitive absence", async () => {
    const result = await response({
      events: [
        { type: "tool.execution_start", data: { toolCallId: "unknown-args", toolName: "bash" } },
        end("unknown-args"),
      ],
    });
    expect(result.error).toBeUndefined();
    expect(inventory(result)).toMatchObject({
      status: "incomplete",
      incompleteReasons: expect.arrayContaining(["missing-tool-arguments"]),
      calls: [{ id: "unknown-args", name: "bash", arguments: null, success: true }],
    });
    expect(
      grade(result, "tool-not-called", {
        name: "bash",
        argumentsMatch: { path: "/command", regex: "git pull" },
      }),
    ).toMatchObject({ pass: false, score: 0, metadata: { graderError: true } });
    allFailClosed(result);
  });
  test("explicit null arguments remain reported evidence rather than missing evidence", async () => {
    const result = await response({ events: [start("null", "read", null), end("null")] });
    expect(result.error).toBeUndefined();
    expect(inventory(result)).toMatchObject({
      status: "complete",
      calls: [{ arguments: null, argumentsTruncated: false, success: true }],
    });
    expect(
      grade(result, "tool-called", { name: "read", argumentsMatch: { path: "", regex: "^null$" } })
        .pass,
    ).toBe(true);
  });
  test("unknown URL userinfo is structurally redacted and cannot prove absence", async () => {
    const endpoints = [
      {
        url: "https://url-only-token@example.invalid/private?keep=yes",
        redacted: "https://[REDACTED]@example.invalid/private?keep=yes",
        secrets: ["url-only-token"],
      },
      {
        url: "HTTPS://upper-user:upper-password@example.invalid/private?keep=yes",
        redacted: "HTTPS://[REDACTED]@example.invalid/private?keep=yes",
        secrets: ["upper-user", "upper-password"],
      },
      {
        url: "hTtP://first-user:first-password@second-user:second-password@example.invalid/private?keep=yes",
        redacted: "hTtP://[REDACTED]@example.invalid/private?keep=yes",
        secrets: ["first-user", "first-password", "second-user", "second-password"],
      },
    ];
    for (const endpoint of endpoints) {
      const result = await response({
        events: [start("url", "fetch", { endpoint: endpoint.url }), end("url")],
      });
      expect(result.error).toBeUndefined();
      expect(inventory(result).calls[0]?.arguments).toEqual({ endpoint: endpoint.redacted });
      expect(inventory(result).incompleteReasons).toContain("tool-evidence-redacted");
      for (const secret of endpoint.secrets) expect(JSON.stringify(result)).not.toContain(secret);
      allFailClosed(result);
    }
  });
  test("HTTP paths and queries without authority userinfo retain their literal text", async () => {
    const endpoint = "HTTPS://example.invalid/private@team?contact=user@site#fragment@tail";
    const result = await response({ events: [start("url", "fetch", { endpoint }), end("url")] });
    expect(inventory(result)).toMatchObject({
      status: "complete",
      calls: [{ arguments: { endpoint } }],
    });
  });
  test("failed attempts remain calls with stable SDK timestamps", async () => {
    const result = await response({
      events: [
        start("failed", "bash", { command: "git pull" }, "2026-01-01T00:00:00.000Z"),
        end("failed", false, "2026-01-01T00:00:01.000Z"),
      ],
    });
    expect(inventory(result)).toMatchObject({
      status: "complete",
      calls: [
        {
          id: "failed",
          name: "bash",
          arguments: { command: "git pull" },
          argumentsTruncated: false,
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:00:01.000Z",
          success: false,
        },
      ],
    });
    expect(
      grade(result, "tool-called", {
        name: "bash",
        argumentsMatch: { path: "command", regex: "git\\s+pull" },
      }).pass,
    ).toBe(true);
    expect(grade(result, "tool-not-called", { name: "bash" }).pass).toBe(false);
  });
  test("subagent events retain runtime name and stable MCP identities", async () => {
    const first = start("sub", "display_search", { query: "needle" });
    Object.assign(first, { agentId: "subagent-1" });
    Object.assign(first.data, {
      mcpConfigServerName: "github",
      mcpServerName: "GitHub Display",
      mcpToolName: "search",
    });
    Object.assign(first.data, { parentToolCallId: "parent" });
    const result = await response({
      events: [
        lifecycle("started", "parent"),
        first,
        { ...end("sub"), agentId: "subagent-1" },
        lifecycle("completed", "parent"),
      ],
    });
    expect(inventory(result)).toMatchObject({
      status: "complete",
      calls: [
        {
          id: "sub",
          name: "display_search",
          mcpServer: "github",
          mcpTool: "search",
          success: true,
        },
      ],
    });
    expect(
      grade(result, "tool-called", {
        name: { regex: "^display_", flags: "i" },
        mcpServer: "github",
        argumentsMatch: { path: "/query", regex: "needle" },
      }).pass,
    ).toBe(true);
    expect(grade(result, "tool-not-called", { mcpServer: "other" }).pass).toBe(true);
  });
  test("arguments are redacted before retention and capped explicitly", async () => {
    const clean = await response({
      events: [
        start("secret", "bash", {
          value: "inventory-secret-value",
          endpoint: "https://user:password@example.invalid/path",
        }),
        end("secret"),
      ],
    });
    expect(inventory(clean).calls[0]?.arguments).toEqual({
      value: "[REDACTED]",
      endpoint: "https://[REDACTED]@example.invalid/path",
    });
    expect(inventory(clean).incompleteReasons).toContain("tool-evidence-redacted");
    expect(
      grade(clean, "tool-not-called", {
        name: "bash",
        argumentsMatch: { path: "/value", regex: "inventory-secret-value" },
      }),
    ).toMatchObject({ pass: false, metadata: { graderError: true } });
    allFailClosed(clean);
    const large = await response({
      events: [start("large", "bash", { value: "x".repeat(20_000) }), end("large")],
    });
    expect(inventory(large)).toMatchObject({
      status: "incomplete",
      incompleteReasons: expect.arrayContaining(["tool-arguments-truncated"]),
      calls: [{ argumentsTruncated: true, success: true }],
    });
    expect(
      Buffer.byteLength(JSON.stringify(inventory(large).calls[0]?.arguments)),
    ).toBeLessThanOrEqual(8192);
    allFailClosed(large);
  });
  test.each<[string, object, string]>([
    ["missing completion", { events: [start("open")] }, "missing-tool-completion"],
    ["orphan completion", { events: [end("orphan")] }, "unmatched-tool-completion"],
    [
      "duplicate start",
      { events: [start("duplicate"), start("duplicate"), end("duplicate")] },
      "duplicate-tool-identity",
    ],
    [
      "duplicate completion",
      { events: [start("duplicate"), end("duplicate"), end("duplicate")] },
      "unmatched-tool-completion",
    ],
    [
      "missing success",
      {
        events: [
          start("unknown"),
          { type: "tool.execution_complete", data: { toolCallId: "unknown" } },
        ],
      },
      "missing-tool-success",
    ],
    [
      "malformed start",
      { events: [{ type: "tool.execution_start", data: { toolCallId: "bad" } }] },
      "malformed-tool-event",
    ],
    [
      "backwards completion",
      {
        events: [
          start("clock", "read", {}, "2026-01-01T00:00:01Z"),
          end("clock", true, "2026-01-01T00:00:00Z"),
        ],
      },
      "tool-timestamp-order",
    ],
    ["session failure", { sessionError: true }, "execution-incomplete"],
    ["send failure", { executionError: true }, "execution-incomplete"],
    ["event count overflow", { repeat: 100_001, repeatKind: "events" }, "event-stream-bound"],
    ["event byte overflow", { eventBytes: 17 * 1024 * 1024 }, "event-stream-bound"],
    ["record overflow", { repeat: 1025 }, "tool-call-limit"],
    ["retained byte overflow", { repeat: 450, argumentBytes: 7900 }, "tool-inventory-byte-limit"],
  ])("%s never certifies absence", async (_label, scenario, reason) => {
    const result = await response(scenario);
    expect(inventory(result).status).toBe("incomplete");
    expect(inventory(result).incompleteReasons).toContain(reason);
    expect(inventory(result).calls.length).toBeLessThanOrEqual(1024);
    expect(Buffer.byteLength(JSON.stringify(inventory(result)))).toBeLessThanOrEqual(
      4 * 1024 * 1024,
    );
    allFailClosed(result);
  });
  test.each(["throw", "hang", "malformed", "unsupported"])(
    "SDK skill inventory %s cannot prove absence",
    async (skillState) => {
      const result = await response({ skillState });
      expect(inventory(result).status).toBe("incomplete");
      expect(inventory(result).skillInventory).toBe(
        skillState === "unsupported" ? "read-tool-only" : "failed",
      );
      allFailClosed(result);
    },
  );
  test.each(
    [
      [null],
      [{}],
      [{ name: "" }],
      [{ name: "x".repeat(513) }],
      Array.from({ length: 1025 }, (_, i) => ({ name: `skill-${i}` })),
    ].map((skills) => ({ skills })),
  )("malformed or unbounded SDK names fail closed %#", async ({ skills }) => {
    const result = await response({ skills });
    expect(inventory(result).skillInventory).toBe("failed");
    allFailClosed(result);
  });
  test("SDK names remain authoritative when legacy body verification discards records", async () => {
    const result = await response({
      skills: [
        { name: "loaded-but-unverified", path: "/outside/SKILL.md", content: "unverified body" },
        { name: "second" },
      ],
    });
    expect(result.metadata).toMatchObject({
      skillCalls: [],
      toolInventory: { status: "complete", loadedSkills: ["loaded-but-unverified", "second"] },
    });
    expect(grade(result, "skill-not-loaded", { name: "loaded-but-unverified" }).pass).toBe(false);
    expect(grade(result, "skill-not-loaded", { name: { regex: "^second$" } }).pass).toBe(false);
    expect(grade(result, "skill-not-loaded", { name: "not-loaded" }).pass).toBe(true);
  });
});

test.each([
  null,
  {},
  { schemaVersion: 2 },
  {
    schemaVersion: 1,
    status: "complete",
    incompleteReasons: [],
    calls: [],
    skillInventory: "read-tool-only",
    loadedSkills: [],
  },
  {
    schemaVersion: 1,
    status: "complete",
    incompleteReasons: [],
    calls: [
      {
        id: "open",
        name: "bash",
        arguments: {},
        argumentsTruncated: false,
        startedAt: "2026-01-01T00:00:00Z",
        endedAt: null,
        success: null,
      },
    ],
    skillInventory: "sdk",
    loadedSkills: [],
  },
])("malformed inventories cannot pass any assertion %#", (value) => {
  const result = { output: "untrusted answer", metadata: { toolInventory: value } };
  allFailClosed(result);
});

async function nativeProvider(source: string) {
  const root = await mkdtemp(join(realpathSync.native(tmpdir()), "tool-forgery-"));
  roots.push(root);
  const peer = join(root, "node_modules", "promptfoo");
  await mkdir(peer, { recursive: true });
  await writeFile(
    join(peer, "package.json"),
    JSON.stringify({ type: "module", exports: "./index.js" }),
  );
  await writeFile(join(peer, "index.js"), source);
  // The adapter resolves the telemetry peer relative to the fake Promptfoo package.
  const { symlink } = await import("node:fs/promises");
  await mkdir(join(peer, "node_modules", "@opentelemetry"), { recursive: true });
  await symlink(
    realpathSync(join(import.meta.dirname, "..", "node_modules", "@opentelemetry", "api")),
    join(peer, "node_modules", "@opentelemetry", "api"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return new Agent({
    config: { basePath: root, delegate: { id: "openai:codex-sdk" }, workspace: { sources: [] } },
    env: {
      ALLAGENTS_CACHE_ROOT: join(root, "cache"),
      ALLAGENTS_WORKSPACE_ROOT: join(root, "runtime"),
    },
  });
}

test.each(
  [
    {},
    [],
    {
      schemaVersion: 1,
      status: "complete",
      incompleteReasons: [],
      calls: [],
      skillInventory: "sdk",
      loadedSkills: [],
    },
  ].map((forged) => ({ forged })),
)("native delegate cannot forge a reserved inventory through Agent %#", async ({ forged }) => {
  const provider = await nativeProvider(
    `export async function loadApiProvider(){return {async callApi(){return {output:'forged',metadata:{toolInventory:${JSON.stringify(forged)}}}}}}`,
  );
  try {
    const result = await provider.callApi("forge");
    expect(result.error).toContain("reserved toolInventory");
    expect(result.metadata).toBeUndefined();
  } finally {
    await provider.cleanup();
  }
});

test("before uses start-event order across overlaps, timestamp ties and repeated anchors", async () => {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const result = await response({
    events: [
      start("first", "bash", { nested: { "a/b": ["git pull"] } }, timestamp),
      start("anchor", "write", { index: 1 }, timestamp),
      end("anchor", true, timestamp),
      end("first", true, timestamp),
      start("later", "bash", { command: "git pull" }, timestamp),
      end("later", true, timestamp),
      start("second-anchor", "write", { index: 2 }, timestamp),
      end("second-anchor", true, timestamp),
    ],
  });
  const config = {
    name: /^bash$/g,
    argumentsMatch: { path: "/nested/a~1b/0", regex: /^git pull$/g },
    before: { name: "write" },
  };
  expect(grade(result, "tool-called", config)).toMatchObject({
    pass: true,
    metadata: { matchedCallIds: ["first"] },
  });
  expect(
    grade(result, "tool-not-called", {
      name: "bash",
      argumentsMatch: { path: "command", regex: "git pull" },
      before: { name: "write" },
    }).pass,
  ).toBe(true);
  expect(grade(result, "tool-called", { name: "write", before: { name: "bash" } }).pass).toBe(
    false,
  );
  expect(
    grade(result, "tool-called", {
      name: /^bash$/g,
      before: { name: "write", argumentsMatch: { path: "/index", regex: "^2$" } },
    }),
  ).toMatchObject({ pass: true, metadata: { matchedCallIds: ["first", "later"] } });
  for (const entity of ["tool-called", "tool-not-called"] as const)
    expect(grade(result, entity, { name: "bash", before: { name: "missing" } })).toMatchObject({
      pass: false,
      metadata: { graderError: true },
    });
});

test("selectors use exact names, safe own-property paths and JSON scalar/object regexes", async () => {
  const result = await response({
    events: [
      start("call", "Read", { nested: [{ value: 42 }], object: { enabled: true } }),
      end("call"),
    ],
  });
  expect(grade(result, "tool-not-called", { name: "read" }).pass).toBe(true);
  expect(
    grade(result, "tool-called", {
      name: { regex: "^read$", flags: "i" },
      argumentsMatch: { path: "$.nested.0.value", regex: "^42$" },
    }).pass,
  ).toBe(true);
  expect(
    grade(result, "tool-called", { argumentsMatch: { path: "object", regex: '"enabled":true' } })
      .pass,
  ).toBe(true);
  expect(
    grade(result, "tool-not-called", { argumentsMatch: { path: "__proto__", regex: ".*" } }).pass,
  ).toBe(true);
  expect(grade(result, "tool-called", {}).pass).toBe(true);
  for (const config of [
    { name: { regex: "[" } },
    { extra: true },
    { mcpServer: 1 },
    { argumentsMatch: { path: "a..b", regex: ".*" } },
    { argumentsMatch: { path: "/a~2", regex: ".*" } },
    { before: { before: { name: "read" } } },
  ])
    expect(grade(result, "tool-not-called", config)).toMatchObject({
      pass: false,
      metadata: { graderError: true },
    });
});

test("native peer raw tool summaries remain observed and explicitly uncertifiable", async () => {
  const provider = await nativeProvider(
    `export async function loadApiProvider(){return {async callApi(){return {output:'observed',metadata:{toolCalls:[{id:'claude',name:'Read',input:{path:'README.md'},output:'content',is_error:false}]},raw:JSON.stringify({items:[{id:'shell',type:'command_execution',command:'git status',status:'completed',exit_code:0},{id:'mcp',type:'mcp_tool_call',server:'github',tool:'search',arguments:{query:'needle'}}]})}}}}`,
  );
  try {
    const result = await provider.callApi("observe");
    expect(result.error).toBeUndefined();
    expect(inventory(result)).toMatchObject({
      status: "incomplete",
      incompleteReasons: expect.arrayContaining(["delegate-does-not-expose-tool-stream"]),
      calls: [
        {
          id: "claude",
          name: "Read",
          arguments: { path: "README.md" },
          startedAt: null,
          endedAt: null,
          success: true,
        },
        {
          id: "shell",
          name: "command_execution",
          arguments: { command: "git status" },
          startedAt: null,
          endedAt: null,
          success: true,
        },
        {
          id: "mcp",
          name: "search",
          mcpServer: "github",
          mcpTool: "search",
          arguments: { query: "needle" },
          startedAt: null,
          endedAt: null,
          success: null,
        },
      ],
    });
    allFailClosed(result);
  } finally {
    await provider.cleanup();
  }
});

test.each<[string, object, string]>([
  [
    "pending background child",
    { events: [lifecycle("started", "background", { executionMode: "background" })] },
    "pending-subagents-at-shutdown",
  ],
  [
    "orphan lifecycle",
    { events: [lifecycle("completed", "missing")] },
    "unmatched-subagent-completion",
  ],
  [
    "failed child",
    { events: [lifecycle("started", "failed"), lifecycle("failed", "failed")] },
    "subagent-execution-incomplete",
  ],
  [
    "cancelled child",
    {
      events: [
        lifecycle("started", "cancelled"),
        lifecycle("completed", "cancelled", { cancelled: true }),
      ],
    },
    "subagent-execution-incomplete",
  ],
  [
    "untracked child",
    {
      events: [
        { ...start("sub"), agentId: "child" },
        { ...end("sub"), agentId: "child" },
      ],
    },
    "subagent-lifecycle-unavailable",
  ],
  [
    "missing summarized child tool",
    {
      events: [
        lifecycle("started", "child"),
        lifecycle("completed", "child", { totalToolCalls: 1 }),
      ],
    },
    "missing-subagent-tool-events",
  ],
  [
    "duplicate child lifecycle",
    {
      events: [
        lifecycle("started", "child"),
        lifecycle("started", "child"),
        lifecycle("completed", "child"),
      ],
    },
    "malformed-subagent-lifecycle",
  ],
  [
    "malformed child cancellation",
    {
      events: [
        lifecycle("started", "child"),
        lifecycle("completed", "child", { cancelled: "yes" }),
      ],
    },
    "malformed-subagent-lifecycle",
  ],
  [
    "malformed child envelope",
    {
      events: [
        lifecycle("started", "child"),
        { ...start("sub"), agentId: 1 },
        end("sub"),
        lifecycle("completed", "child"),
      ],
    },
    "malformed-subagent-lifecycle",
  ],
  [
    "disconnect activity",
    { disconnectEvents: [start("late"), end("late")] },
    "post-idle-agent-activity",
  ],
  [
    "post-idle activity",
    { afterIdleEvents: [start("late"), end("late")] },
    "post-idle-agent-activity",
  ],
  [
    "late skill",
    { disconnectEvents: [{ type: "skill.invoked", data: { name: "late" } }] },
    "post-idle-agent-activity",
  ],
  ["stop failure", { stopErrors: true }, "client-shutdown-failed"],
  ["disconnect failure", { cleanupError: true }, "execution-incomplete"],
  ["unsafe argument JSON", { unsafeArguments: true }, "tool-arguments-unserializable"],
  [
    "aborted idle",
    { events: [{ type: "session.idle", data: { aborted: true } }] },
    "session-idle-aborted",
  ],
])("%s cannot certify a clean full stream", async (_label, scenario, reason) => {
  const result = await response(scenario);
  expect(inventory(result).incompleteReasons).toContain(reason);
  allFailClosed(result);
  if (_label === "disconnect activity" || _label === "post-idle activity")
    expect(inventory(result).calls).toEqual([
      expect.objectContaining({ id: "late", success: true }),
    ]);
});

test("native observations use final tool attributes, exclude model spans and retain unfinished starts", async () => {
  const provider = await nativeProvider(`import {trace} from '@opentelemetry/api';
export async function loadApiProvider(){return {async callApi(){
  const tracer=trace.getTracer('native-inventory-fixture');
  const model=tracer.startSpan('model',{attributes:{'gen_ai.operation.name':'chat','gen_ai.tool.name':'described-not-invoked'}});model.end();
  const tool=tracer.startSpan('native runtime display',{startTime:new Date('2026-01-01T00:00:00Z')});
  tool.setAttributes({'gen_ai.tool.name':'native-read','gen_ai.tool.call.id':'native-id','gen_ai.tool.mcp.server':'github','gen_ai.tool.mcp.tool':'read','tool.input':JSON.stringify({path:'final-argument'})});
  tool.setStatus({code:1});tool.end(new Date('2026-01-01T00:00:01Z'));
  tracer.startSpan('pending tool',{startTime:new Date('2026-01-01T00:00:02Z'),attributes:{'gen_ai.tool.name':'pending','gen_ai.tool.call.id':'pending-id'}});
  return {output:'observed',metadata:{toolCalls:[{id:'native-id',name:'native-read',input:{path:'summary-must-not-replace-trace'},output:'ok',is_error:false}]}};
}}}`);
  try {
    const result = await provider.callApi("observe");
    expect(result.error).toBeUndefined();
    expect(inventory(result).calls).toEqual([
      expect.objectContaining({
        id: "native-id",
        name: "native-read",
        mcpServer: "github",
        mcpTool: "read",
        arguments: { path: "final-argument" },
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:00:01.000Z",
        success: true,
      }),
      expect.objectContaining({
        id: "pending-id",
        name: "pending",
        startedAt: "2026-01-01T00:00:02.000Z",
        endedAt: null,
        success: null,
      }),
    ]);
    allFailClosed(result);
  } finally {
    await provider.cleanup();
  }
});

test.each(['"'.repeat(20_000), "🙂".repeat(10_000)])(
  "argument previews remain bounded after JSON escaping %#",
  async (value) => {
    const result = await response({ events: [start("large", "read", { value }), end("large")] });
    expect(result.error).toBeUndefined();
    expect(inventory(result).calls[0]?.argumentsTruncated).toBe(true);
    expect(
      Buffer.byteLength(JSON.stringify(inventory(result).calls[0]?.arguments)),
    ).toBeLessThanOrEqual(8192);
    allFailClosed(result);
  },
);

test("malformed certificates and absent metadata always fail closed", () => {
  const call = {
    id: "one",
    name: "read",
    arguments: {},
    argumentsTruncated: false,
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:00:01Z",
    success: true,
  };
  const base = {
    schemaVersion: 1,
    status: "complete",
    incompleteReasons: [],
    calls: [call],
    skillInventory: "sdk",
    loadedSkills: [],
  };
  const malformed = [
    { ...base, incompleteReasons: ["missing"] },
    { ...base, status: "incomplete" },
    { ...base, calls: [call, call] },
    { ...base, calls: Array.from({ length: 1025 }, (_, id) => ({ ...call, id: String(id) })) },
    { ...base, calls: [{ ...call, argumentsTruncated: true }] },
    { ...base, calls: [{ ...call, startedAt: "not-a-timestamp" }] },
    { ...base, calls: [{ ...call, endedAt: "2025-01-01T00:00:00Z" }] },
    { ...base, calls: [{ ...call, arguments: () => "unsafe" }] },
    { ...base, skillInventory: "failed", loadedSkills: ["unknown"] },
    { ...base, loadedSkills: [{}] },
    { ...base, loadedSkills: undefined },
  ];
  allFailClosed({ output: "no metadata" });
  for (const value of malformed)
    allFailClosed({ output: "untrusted", metadata: { toolInventory: value } });
});

test("native raw observations preserve every exposed tool category even when an event ID is missing", async () => {
  const items = [
    { type: "command_execution", command: "pwd", status: "completed", exit_code: 0 },
    { id: "file", type: "file_change", changes: [] },
    { id: "web", type: "web_search", query: "needle" },
    {
      id: "mcp",
      type: "mcp_tool_call",
      server: "github",
      tool: "search",
      arguments: { query: "needle" },
    },
    {
      id: "collab",
      type: "collaboration_tool_call",
      tool: "spawn_agent",
      target_thread_id: "child",
    },
    { id: "spawn", type: "spawn_agent", role: "worker" },
    { id: "send", type: "send_input", target_thread_id: "child", input: "inspect" },
    { id: "wait", type: "agent_wait" },
    { id: "plan", type: "todo_list", items: [] },
  ];
  const provider = await nativeProvider(
    `export async function loadApiProvider(){return {async callApi(){return {output:'observed',raw:${JSON.stringify(JSON.stringify({ items }))}}}}}`,
  );
  try {
    const result = await provider.callApi("observe");
    expect(result.error).toBeUndefined();
    expect(inventory(result).calls.map((call) => call.name)).toEqual([
      "command_execution",
      "file_change",
      "web_search",
      "search",
      "spawn_agent",
      "spawn_agent",
      "send_input",
      "agent_wait",
      "todo_list",
    ]);
    expect(inventory(result).calls[0]).toMatchObject({
      id: "native-summary:codex:1",
      arguments: { command: "pwd" },
      startedAt: null,
      endedAt: null,
      success: true,
    });
    expect(inventory(result).incompleteReasons).toContain("native-tool-identity-unavailable");
    allFailClosed(result);
  } finally {
    await provider.cleanup();
  }
});

test("redacted SDK skill names cannot silently prove absence", async () => {
  const result = await response({ skills: [{ name: "inventory-secret-value" }] });
  expect(inventory(result).loadedSkills).toEqual(["[REDACTED]"]);
  expect(inventory(result).incompleteReasons).toContain("skill-evidence-redacted");
  expect(grade(result, "skill-not-loaded", { name: "inventory-secret-value" })).toMatchObject({
    pass: false,
    metadata: { graderError: true },
  });
  expect(JSON.stringify(result)).not.toContain("inventory-secret-value");
});

test("redacted runtime names cannot silently prove a named tool was absent", async () => {
  const result = await response({
    events: [start("secret-name", "inventory-secret-value"), end("secret-name")],
  });
  expect(inventory(result).calls[0]?.name).toBe("[REDACTED]");
  expect(grade(result, "tool-not-called", { name: "inventory-secret-value" })).toMatchObject({
    pass: false,
    metadata: { graderError: true },
  });
  expect(JSON.stringify(result)).not.toContain("inventory-secret-value");
});

test.each<[string, object, string]>([
  [
    "one child cannot cover another child's reported deficit",
    {
      events: [
        lifecycle("started", "a"),
        childStart("a-read", "a"),
        childEnd("a-read", "a"),
        lifecycle("completed", "a"),
        lifecycle("started", "b"),
        lifecycle("completed", "b", { totalToolCalls: 1 }),
      ],
    },
    "missing-subagent-tool-events",
  ],
  [
    "a later child cannot cover an earlier child's reported deficit",
    {
      events: [
        lifecycle("started", "a"),
        lifecycle("completed", "a", { totalToolCalls: 1 }),
        lifecycle("started", "b"),
        childStart("b-read", "b"),
        childEnd("b-read", "b"),
        lifecycle("completed", "b"),
      ],
    },
    "missing-subagent-tool-events",
  ],
  [
    "tracked child cannot certify an untracked sibling",
    {
      events: [
        lifecycle("started", "a"),
        lifecycle("completed", "a"),
        childStart("b-read", "b"),
        childEnd("b-read", "b"),
      ],
    },
    "subagent-lifecycle-unavailable",
  ],
  [
    "unknown agent-only sibling cannot borrow another lifecycle",
    {
      events: [
        lifecycle("started", "a"),
        lifecycle("completed", "a"),
        { ...start("orphan"), agentId: "b" },
        { ...end("orphan"), agentId: "b" },
      ],
    },
    "subagent-lifecycle-unavailable",
  ],
  [
    "agent mapping cannot change lifecycle",
    {
      events: [
        lifecycle("started", "a"),
        lifecycle("started", "b"),
        childStart("a-read", "a", "child"),
        childEnd("a-read", "a"),
        childStart("b-read", "b", "child"),
        childEnd("b-read", "b"),
        lifecycle("completed", "a"),
        lifecycle("completed", "b"),
      ],
    },
    "subagent-lifecycle-unavailable",
  ],
  [
    "completed child cannot keep invoking tools",
    {
      events: [
        lifecycle("started", "a"),
        lifecycle("completed", "a"),
        childStart("late", "a"),
        childEnd("late", "a"),
      ],
    },
    "subagent-lifecycle-unavailable",
  ],
])("%s", async (_label, scenario, reason) => {
  const result = await response(scenario);
  expect(result.error).toBeUndefined();
  expect(inventory(result).incompleteReasons).toContain(reason);
  allFailClosed(result);
});

test("each child reconciles its own optional count and mapped agent-only completions", async () => {
  const result = await response({
    events: [
      lifecycle("started", "a"),
      lifecycle("started", "b"),
      childStart("a-read", "a", "agent-a"),
      childStart("b-read", "b", "agent-b"),
      { ...end("b-read"), agentId: "agent-b" },
      { ...end("a-read"), agentId: "agent-a" },
      lifecycle("completed", "a", { totalToolCalls: 1 }),
      lifecycle("completed", "b"),
    ],
  });
  expect(result.error).toBeUndefined();
  expect(inventory(result)).toMatchObject({
    status: "complete",
    calls: [
      { id: "a-read", success: true },
      { id: "b-read", success: true },
    ],
  });
  expect(grade(result, "tool-not-called").pass).toBe(true);
});

test.each<[string, object, string]>([
  ["returned promise without observed idle", { missingIdle: true }, "missing-session-idle"],
  [
    "autopilot idle is not the completed call boundary",
    { idleData: { mode: "autopilot" } },
    "missing-session-idle",
  ],
  [
    "child-only idle is not a root idle",
    { missingIdle: true, events: [{ type: "session.idle", agentId: "child", data: {} }] },
    "missing-session-idle",
  ],
  [
    "abort before clean idle stays incomplete",
    { events: [{ type: "abort", data: { reason: "user" } }] },
    "session-aborted",
  ],
  [
    "abort after promise resolution stays incomplete",
    { skillRpcEvents: [{ type: "abort", data: { reason: "user" } }] },
    "session-aborted",
  ],
  [
    "error shutdown before clean idle stays incomplete",
    { events: [{ type: "session.shutdown", data: { shutdownType: "error" } }] },
    "session-shutdown-error",
  ],
  [
    "error shutdown after promise resolution stays incomplete",
    { skillRpcEvents: [{ type: "session.shutdown", data: { shutdownType: "error" } }] },
    "session-shutdown-error",
  ],
])("%s", async (_label, scenario, reason) => {
  const result = await response(scenario);
  expect(result.error).toBeUndefined();
  expect(inventory(result).incompleteReasons).toContain(reason);
  allFailClosed(result);
});

test("a malformed unrelated SDK name preserves separately verified positive skill evidence", async () => {
  let skillPath = "";
  const provider = await sdkProvider(async (root) => {
    const directory = join(root, ".agents", "skills", "verified");
    await mkdir(directory, { recursive: true });
    skillPath = join(directory, "SKILL.md");
    await writeFile(
      skillPath,
      "---\nname: verified\ndescription: Fixture skill\n---\nVerified skill body.\n",
    );
  });
  try {
    const result = await provider.callApi(
      `inventory:${JSON.stringify({
        skills: [
          { name: "verified", path: skillPath, content: "Verified skill body.", invokedAtTurn: 1 },
          { name: {}, path: "/unrelated/SKILL.md", content: "invalid name" },
        ],
      })}`,
    );
    expect(result.error).toBeUndefined();
    expect(result.metadata).toMatchObject({
      skillCalls: [{ name: "verified", path: skillPath, source: "sdk-skill-loader" }],
    });
    expect(inventory(result).skillInventory).toBe("failed");
    allFailClosed(result);
  } finally {
    await provider.cleanup();
  }
});

test("lifecycle child identity certifies a clean zero-tool child", async () => {
  const result = await response({
    events: [
      { ...lifecycle("started", "parent-tool"), agentId: "child-instance" },
      {
        ...lifecycle("completed", "parent-tool", { totalToolCalls: 0 }),
        agentId: "child-instance",
      },
    ],
  });
  expect(result.error).toBeUndefined();
  expect(inventory(result)).toMatchObject({ status: "complete", calls: [] });
  expect(grade(result, "tool-not-called").pass).toBe(true);
  expect(grade(result, "skill-not-loaded").pass).toBe(true);
});

test("lifecycle child identity attributes agentId-only tool streams", async () => {
  const result = await response({
    events: [
      { ...lifecycle("started", "parent-tool"), agentId: "child-instance" },
      { ...start("child-read"), agentId: "child-instance" },
      { ...end("child-read"), agentId: "child-instance" },
      {
        ...lifecycle("completed", "parent-tool", { totalToolCalls: 1 }),
        agentId: "child-instance",
      },
    ],
  });
  expect(result.error).toBeUndefined();
  expect(inventory(result)).toMatchObject({
    status: "complete",
    calls: [{ id: "child-read", success: true }],
  });
  expect(grade(result, "tool-called", { name: "read" }).pass).toBe(true);
});

test("lifecycle sibling identity mismatch cannot certify absence", async () => {
  const result = await response({
    events: [
      { ...lifecycle("started", "a"), agentId: "agent-a" },
      { ...lifecycle("started", "b"), agentId: "agent-b" },
      childStart("a-read", "a", "agent-a"),
      childEnd("a-read", "a"),
      childStart("b-read", "b", "agent-b"),
      childEnd("b-read", "b"),
      { ...lifecycle("completed", "a", { totalToolCalls: 1 }), agentId: "agent-b" },
      { ...lifecycle("completed", "b", { totalToolCalls: 1 }), agentId: "agent-b" },
    ],
  });
  expect(result.error).toBeUndefined();
  expect(inventory(result)).toMatchObject({
    status: "incomplete",
    incompleteReasons: expect.arrayContaining([
      "subagent-lifecycle-identity-mismatch",
      "pending-subagents-at-shutdown",
    ]),
  });
  allFailClosed(result);
});

test.each(["completed", "failed"] as const)(
  "lifecycle terminal %s cannot replace the child's explicit identity",
  async (type) => {
    const result = await response({
      events: [
        { ...lifecycle("started", "parent"), agentId: "actual-child" },
        { ...lifecycle(type, "parent", { totalToolCalls: 0 }), agentId: "different-child" },
      ],
    });
    expect(inventory(result).incompleteReasons).toContain("subagent-lifecycle-identity-mismatch");
    expect(inventory(result).incompleteReasons).toContain("pending-subagents-at-shutdown");
    allFailClosed(result);
  },
);

test("lifecycle child identity may first be reported on the matching completion", async () => {
  const result = await response({
    events: [
      lifecycle("started", "parent"),
      { ...lifecycle("completed", "parent", { totalToolCalls: 0 }), agentId: "child" },
    ],
  });
  expect(result.error).toBeUndefined();
  expect(inventory(result)).toMatchObject({ status: "complete", calls: [] });
});

test("lifecycle child identity remains valid when an optional terminal agentId is absent", async () => {
  const result = await response({
    events: [
      { ...lifecycle("started", "parent"), agentId: "child" },
      lifecycle("completed", "parent", { totalToolCalls: 0 }),
    ],
  });
  expect(result.error).toBeUndefined();
  expect(inventory(result)).toMatchObject({ status: "complete", calls: [] });
});

test("lifecycle starts cannot assign an existing child instance to a sibling", async () => {
  const result = await response({
    events: [
      { ...lifecycle("started", "a"), agentId: "same-child" },
      { ...lifecycle("started", "b"), agentId: "same-child" },
      { ...lifecycle("completed", "a", { totalToolCalls: 0 }), agentId: "same-child" },
      { ...lifecycle("completed", "b", { totalToolCalls: 0 }), agentId: "same-child" },
    ],
  });
  expect(inventory(result).incompleteReasons).toEqual(
    expect.arrayContaining([
      "subagent-lifecycle-identity-mismatch",
      "pending-subagents-at-shutdown",
    ]),
  );
  allFailClosed(result);
});

test("lifecycle failure validates the same child identity without losing its observed calls", async () => {
  const result = await response({
    events: [
      { ...lifecycle("started", "parent"), agentId: "child" },
      { ...start("read"), agentId: "child" },
      { ...end("read"), agentId: "child" },
      { ...lifecycle("failed", "parent", { totalToolCalls: 1 }), agentId: "child" },
    ],
  });
  expect(inventory(result)).toMatchObject({
    status: "incomplete",
    calls: [{ id: "read", success: true }],
    incompleteReasons: ["subagent-execution-incomplete"],
  });
  allFailClosed(result);
});
