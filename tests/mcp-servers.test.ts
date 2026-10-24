import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { NodeTracerProvider, type ReadableSpan } from "@opentelemetry/sdk-trace-node";
import { afterEach, expect, test, vi } from "vitest";
import {
  agentAssert,
  "skill-not-loaded" as skillNotLoaded,
  "tool-called" as toolCalled,
  "tool-not-called" as toolNotCalled,
} from "../packages/oh-my-promptfoo/src/assertions";
import { Agent, CopilotSdk } from "../packages/oh-my-promptfoo/src/providers";
import { toolInventory as parseToolInventory } from "../packages/oh-my-promptfoo/src/tool-inventory";
import { removeTree } from "../packages/workspace-core/src/fs";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => removeTree(root)));
});

async function consumerProject(moduleName = "@github/copilot-sdk") {
  const root = await mkdtemp(join(realpathSync.native(tmpdir()), "allagents-mcp-"));
  roots.push(root);
  const moduleDir = join(root, "node_modules", moduleName);
  await mkdir(moduleDir, { recursive: true });
  await writeFile(
    join(moduleDir, "package.json"),
    JSON.stringify({ name: moduleName, version: "0.1.0", type: "module", exports: "./index.js" }),
  );
  await writeFile(
    join(moduleDir, "index.js"),
    await readFile(new URL("./fixtures/mcp-consumer.mjs", import.meta.url), "utf8"),
  );
  if (moduleName === "@anthropic-ai/claude-agent-sdk") {
    const entry = createRequire(import.meta.url).resolve("promptfoo");
    let directory = dirname(entry);
    while (true) {
      const manifest = join(directory, "package.json");
      if (existsSync(manifest) && JSON.parse(await readFile(manifest, "utf8")).name === "promptfoo")
        break;
      if (dirname(directory) === directory) throw Error("Promptfoo package root missing");
      directory = dirname(directory);
    }
    await symlink(
      directory,
      join(root, "node_modules", "promptfoo"),
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  await mkdir(join(root, "mocks"));
  await writeFile(
    join(root, "mocks", "server.mjs"),
    await readFile(new URL("./fixtures/mock-mcp.mjs", import.meta.url), "utf8"),
  );
  await writeFile(join(root, "mocks", "native.txt"), "native read executed");
  return root;
}

// The SDK boundary consumes the translated configuration and exchanges real JSON-RPC
// over stdio. No model, network service, or private implementation seam is involved.
test.skipIf(process.platform !== "linux")(
  "workspace candidate executes a protected local-source MCP tool over stdio",
  async () => {
    const root = await consumerProject();
    const provider = new Agent({
      config: {
        basePath: root,
        delegate: {
          id: "copilot-sdk",
          config: {
            mcpServers: {
              fixture: {
                path: ".eval-mocks/server.mjs",
                env: { MOCK_MODE: "canned" },
                tools: ["search_code"],
              },
            },
          },
        },
        workspace: {
          sources: [
            {
              type: "local",
              path: "./mocks",
              destination: ".eval-mocks",
              permissions: "read-only",
            },
          ],
        },
      },
      env: {
        ALLAGENTS_CACHE_ROOT: join(root, "cache"),
        ALLAGENTS_WORKSPACE_ROOT: join(root, "runtime"),
      },
    });
    try {
      const response = await provider.callApi("search fixtures");
      expect(response.error).toBeUndefined();
      expect(JSON.parse(String(response.output))).toMatchObject({
        result: "canned code match",
        mode: "canned",
      });
    } finally {
      await provider.cleanup();
    }
  },
);

test("public candidate constructor rejects case-variant reserved MCP environment names", () => {
  for (const id of ["copilot-sdk", "anthropic:claude-agent-sdk"]) {
    for (const name of [
      "node_options",
      "Node_Options",
      "allagents_git_token",
      "AllAgents_CACHE_ROOT",
    ]) {
      expect(
        () =>
          new Agent({
            config: {
              delegate: {
                id,
                config: {
                  mcpServers: {
                    fixture: {
                      path: "server.mjs",
                      env: { [name]: "private-fixture-value" },
                    },
                  },
                },
              },
              workspace: { sources: [] },
            },
          }),
      ).toThrow(/reserved/);
    }
  }
});

type Candidate = "copilot-sdk" | "anthropic:claude-agent-sdk";
const candidates: Candidate[] = ["copilot-sdk", "anthropic:claude-agent-sdk"];
const projectFor = (id: Candidate) =>
  consumerProject(id === "copilot-sdk" ? "@github/copilot-sdk" : "@anthropic-ai/claude-agent-sdk");
function pinnedMocks(root: string) {
  const repository = join(root, "mocks");
  execFileSync("git", ["init", "-q", repository]);
  execFileSync("git", ["-C", repository, "add", "--all"]);
  execFileSync("git", [
    "-C",
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--allow-empty",
    "-qm",
    "MCP fixture",
  ]);
  const ref = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  return {
    type: "git" as const,
    repository: pathToFileURL(repository).href,
    ref,
    destination: ".eval-mocks",
    permissions: "read-only" as const,
  };
}
function candidate(
  root: string,
  id: Candidate,
  server: Record<string, unknown> = {},
  config: Record<string, unknown> = {},
  workingDir?: string,
) {
  return new Agent({
    config: {
      basePath: root,
      delegate: {
        id,
        env: {
          DELEGATE_SECRET: "private-delegate-fixture",
          ANTHROPIC_API_KEY: "private-auth-fixture",
        },
        config: {
          ...(id === "anthropic:claude-agent-sdk" ? { apiKeyRequired: false } : {}),
          mcpServers: { fixture: { path: ".eval-mocks/server.mjs", ...server } },
          ...config,
        },
      },
      ...(workingDir ? { workingDir } : {}),
      workspace: {
        sources: [pinnedMocks(root)],
      },
    },
    env: {
      ALLAGENTS_CACHE_ROOT: join(root, "cache"),
      ALLAGENTS_WORKSPACE_ROOT: join(root, "runtime"),
    },
  });
}
const request = (value: Record<string, unknown>) => `mcp:${JSON.stringify(value)}`;

for (const id of candidates) {
  test(`${id} executes real stdio with literal env, argv and working directory`, async () => {
    const root = await projectFor(id);
    vi.stubEnv("MCP_HOST_SECRET", "private-host-fixture");
    const provider = candidate(root, id, {
      env: { MOCK_MODE: "canned", LITERAL: `\${HOME}`, MiXeD_Fixture: "KeepCase" },
      args: ["--fixture", "a b"],
    });
    try {
      const response = await provider.callApi(request({ control: true }));
      expect(response.error).toBeUndefined();
      const output = JSON.parse(String(response.output));
      expect(output).toMatchObject({ result: "canned code match", args: ["--fixture", "a b"] });
      expect(output.env).toEqual({
        MOCK_MODE: "canned",
        LITERAL: `\${HOME}`,
        MiXeD_Fixture: "KeepCase",
      });
      expect(output.cwd).toBe(realpathSync((response.metadata as any).workspace.path));
      expect(output.execArgv.join(" ")).not.toContain("canned");
      expect(output.control.args.join(" ")).not.toContain("canned");
      expect(existsSync(output.control.file)).toBe(false);
      if (process.platform !== "win32") expect(output.control.mode).toBe(0o600);
    } finally {
      await provider.cleanup();
    }
  });

  test(`${id} preserves fragmented large UTF-8 MCP responses`, async () => {
    const root = await projectFor(id);
    const provider = candidate(root, id);
    try {
      const response = await provider.callApi(
        request({ arguments: { query: "fixtures", fragmented: true } }),
      );
      expect(response.error).toBeUndefined();
      expect(JSON.parse(String(response.output))).toMatchObject({
        result: "canned code match",
        unicode: "路径π🙂".repeat(2048),
      });
    } finally {
      await provider.cleanup();
    }
  });

  test(`${id} resolves scripts relative to a protected-source working directory`, async () => {
    const root = await projectFor(id);
    const provider = candidate(root, id, { path: "server.mjs" }, {}, ".eval-mocks");
    try {
      const response = await provider.callApi("search fixtures");
      expect(response.error).toBeUndefined();
      expect(JSON.parse(String(response.output)).env).toEqual({});
    } finally {
      await provider.cleanup();
    }
  });

  for (const [tools, expected] of [
    [undefined, ["search_code", "restricted"]],
    [["*"], ["search_code", "restricted"]],
    [["search_code"], ["search_code"]],
    [[], []],
  ] as const) {
    test(`${id} exposes only configured tools ${JSON.stringify(tools)}`, async () => {
      const root = await projectFor(id);
      const provider = candidate(root, id, tools === undefined ? {} : { tools });
      try {
        const response = await provider.callApi(request({ list: true }));
        expect(response.error).toBeUndefined();
        expect(JSON.parse(String(response.output))).toEqual(expected);
      } finally {
        await provider.cleanup();
      }
    });
  }

  test(`${id} never executes a tool denied by the allow-list even if SDK approval is bypassed`, async () => {
    const root = await projectFor(id);
    const marker = join(root, "must-not-exist");
    const provider = candidate(root, id, { tools: ["search_code"] });
    try {
      const response = await provider.callApi(
        request({ tool: "restricted", bypassPermission: true, arguments: { pidFile: marker } }),
      );
      expect(response.error).toContain("allow-list");
      expect(existsSync(marker)).toBe(false);
    } finally {
      await provider.cleanup();
    }
  });

  test(`${id} replaces MCP configuration in per-test generation overrides`, async () => {
    const root = await projectFor(id);
    const provider = candidate(root, id, { path: "does-not-exist.mjs" });
    try {
      const response = await provider.callApi("search fixtures", {
        prompt: {
          config: {
            delegate: {
              config: {
                mcpServers: {
                  fixture: { path: ".eval-mocks/server.mjs", env: { MOCK_MODE: "override" } },
                },
              },
            },
          },
        },
      });
      expect(response.error).toBeUndefined();
      expect(JSON.parse(String(response.output)).mode).toBe("override");
    } finally {
      await provider.cleanup();
    }
  });

  test(`${id} times out and terminates a real Node tool without late completion`, async () => {
    const root = await projectFor(id);
    const pidFile = join(root, "timed-out-pid.json");
    const provider = candidate(root, id, { timeoutMs: 150 });
    try {
      const response = await provider.callApi(request({ arguments: { pidFile, hang: true } }));
      expect(response.error).toContain("timeoutMs");
      const { pid, parent, controlFile } = JSON.parse(await readFile(pidFile, "utf8"));
      await expectGone(pid);
      await expectGone(parent);
      expect(existsSync(controlFile)).toBe(false);
    } finally {
      await provider.cleanup();
    }
  });

  test(`${id} abort cleans up both launcher and Node server`, async () => {
    const root = await projectFor(id);
    const pidFile = join(root, "aborted-pid.json");
    const provider = candidate(root, id);
    const controller = new AbortController();
    const response = provider.callApi(request({ arguments: { pidFile, hang: true } }), undefined, {
      abortSignal: controller.signal,
    });
    try {
      await waitForFile(pidFile);
      const { pid, parent, controlFile } = JSON.parse(await readFile(pidFile, "utf8"));
      controller.abort();
      expect((await response).error).toMatch(/abort/i);
      await expectGone(pid);
      await expectGone(parent);
      expect(existsSync(controlFile)).toBe(false);
    } finally {
      controller.abort();
      await response;
      await provider.cleanup();
    }
  });

  test(`${id} rejects configured MCP on the public read-only grader boundary`, async () => {
    await expect(
      agentAssert("candidate output", {
        config: {
          components: [{ metric: "safe", value: "Inspect workspace" }],
          grader: { id, config: { mcpServers: { fixture: { path: "server.mjs" } } } },
        },
      }),
    ).rejects.toThrow(/mcpServers.*read-only/i);
  });
}

async function waitForFile(path: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    try {
      await stat(path);
      return;
    } catch {}
    await delay(20);
  }
  throw Error(`Fixture did not start: ${path}`);
}
async function expectGone(pid: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await delay(20);
  }
  throw Error(`MCP child ${pid} survived cleanup`);
}

test("Copilot approves only configured servers and configured tool names", async () => {
  const root = await consumerProject();
  const provider = candidate(root, "copilot-sdk", { tools: ["search_code"] });
  try {
    const response = await provider.callApi(
      request({
        permissions: [
          { serverName: "fixture", toolName: "search_code" },
          { serverName: "fixture", toolName: "restricted" },
          { serverName: "unconfigured", toolName: "search_code" },
          { serverName: "fixture" },
          { serverName: "__proto__", toolName: "search_code" },
        ],
      }),
    );
    expect(response.error).toBeUndefined();
    expect(JSON.parse(String(response.output))).toEqual([
      "approve-once",
      "reject",
      "reject",
      "reject",
      "reject",
    ]);
  } finally {
    await provider.cleanup();
  }
});

for (const [config, write, edit] of [
  [{ custom_allowed_tools: ["Read"] }, false, false],
  [{ append_allowed_tools: ["Write"] }, true, false],
  [{ custom_allowed_tools: ["Read", "Write", "Edit"], disallowed_tools: ["Write"] }, false, true],
  [
    { allow_all_tools: true, permission_mode: "acceptEdits", disallowed_tools: ["Edit"] },
    true,
    false,
  ],
  [
    {
      tools: { type: "preset", preset: "claude_code" },
      permission_mode: "bypassPermissions",
      allow_dangerously_skip_permissions: true,
      disallowed_tools: ["Edit"],
    },
    true,
    false,
  ],
  [{ tools: { type: "preset", preset: "claude_code" }, permission_mode: "dontAsk" }, false, false],
] as const) {
  test(`Claude preserves native tool policy while enabling configured MCP ${JSON.stringify(config)}`, async () => {
    const root = await projectFor("anthropic:claude-agent-sdk");
    const provider = candidate(
      root,
      "anthropic:claude-agent-sdk",
      { tools: ["search_code"] },
      config,
    );
    try {
      const response = await provider.callApi(request({ native: true }));
      expect(response.error).toBeUndefined();
      expect(JSON.parse(String(response.output))).toMatchObject({
        result: "canned code match",
        native: {
          read: "native read executed",
          write: write ? "native write executed" : "denied",
          edit: edit ? "native edit executed" : "denied",
        },
      });
      const workspace = (response.metadata as any).workspace.path;
      expect(existsSync(join(workspace, "native-write.txt"))).toBe(write);
      expect(existsSync(join(workspace, "native-edit.txt"))).toBe(edit);
      const denied = await provider.callApi(
        request({ tool: "restricted", bypassPermission: true }),
      );
      expect(denied.error).toContain("allow-list");
    } finally {
      await provider.cleanup();
    }
  });
}

for (const id of candidates) {
  test(`${id} preserves display names, call ids and arguments with normalized MCP span identity`, async () => {
    const spans: ReadableSpan[] = [];
    const telemetry = new NodeTracerProvider({
      spanProcessors: [
        {
          onStart() {},
          onEnd(span) {
            spans.push(span);
          },
          async forceFlush() {},
          async shutdown() {},
        },
      ],
    });
    telemetry.register({
      propagator: new W3CTraceContextPropagator(),
      contextManager: new AsyncLocalStorageContextManager(),
    });
    const root = await projectFor(id);
    const provider = candidate(root, id);
    try {
      const response = await provider.callApi("search fixtures");
      expect(response.error).toBeUndefined();
      const span = spans.find((item) => item.attributes["gen_ai.tool.mcp.server"] === "fixture");
      expect(span?.attributes).toMatchObject({
        "gen_ai.tool.name":
          id === "copilot-sdk" ? "fixture-search_code" : "mcp__fixture__search_code",
        "gen_ai.tool.call.id": "mcp-1",
        "gen_ai.tool.mcp.server": "fixture",
        "gen_ai.tool.mcp.tool": "search_code",
      });
      expect(JSON.parse(String(span?.attributes["gen_ai.tool.call.arguments"]))).toEqual({
        query: "fixtures",
      });
      const metadata = response.metadata;
      if (!metadata || typeof metadata !== "object" || !("toolInventory" in metadata))
        throw new Error("Provider response omitted the adapter-owned inventory");
      const inventory = parseToolInventory(metadata.toolInventory);
      expect(inventory.status).toBe(id === "copilot-sdk" ? "complete" : "incomplete");
      expect(inventory.calls.find((call) => call.id === "mcp-1")).toMatchObject({
        name: id === "copilot-sdk" ? "fixture-search_code" : "mcp__fixture__search_code",
        mcpServer: "fixture",
        mcpTool: "search_code",
        arguments: { query: "fixtures" },
        success: true,
      });
      const assertionContext = { providerResponse: response, config: { mcpServer: "fixture" } };
      if (id === "copilot-sdk") {
        expect(toolCalled(response.output, assertionContext)).toMatchObject({
          pass: true,
          score: 1,
        });
        expect(toolNotCalled(response.output, assertionContext)).toMatchObject({
          pass: false,
          score: 0,
        });
        expect(
          skillNotLoaded(response.output, {
            providerResponse: response,
            config: { name: "forbidden" },
          }),
        ).toMatchObject({ pass: true, score: 1 });
      } else {
        for (const grade of [toolCalled, toolNotCalled, skillNotLoaded])
          expect(
            grade(response.output, { providerResponse: response, config: { name: "forbidden" } }),
          ).toMatchObject({ pass: false, score: 0, metadata: { graderError: true } });
      }
    } finally {
      await provider.cleanup();
      await telemetry.shutdown();
      trace.disable();
      context.disable();
      propagation.disable();
    }
  });
}

test("direct Copilot rejects symlink escapes and non-file MCP entrypoints", async () => {
  const root = await consumerProject();
  const outside = await mkdtemp(join(realpathSync.native(tmpdir()), "allagents-mcp-outside-"));
  roots.push(outside);
  await writeFile(join(outside, "server.mjs"), "throw Error('must not execute');");
  await symlink(join(outside, "server.mjs"), join(root, "escape.mjs"));
  for (const [path, error] of [
    ["escape.mjs", "must stay inside"],
    ["mocks", "regular file"],
  ]) {
    const provider = new CopilotSdk({
      config: { basePath: root, working_dir: ".", mcpServers: { fixture: { path } } },
    });
    try {
      expect((await provider.callApi("search fixtures")).error).toContain(error);
    } finally {
      await provider.cleanup();
    }
  }
});

for (const id of candidates) {
  for (const entry of [
    {},
    { path: "/bin/node" },
    { path: "../server.mjs" },
    { path: "a/../server.mjs" },
    { path: "C:/server.mjs" },
    { path: "https://example.test/server.mjs" },
    { path: "server.mjs", command: "node" },
    { path: "server.mjs", url: "https://example.test" },
    { path: "server.mjs", cwd: "." },
    { path: "server.mjs", unknown: true },
    { path: "server.mjs", args: [3] },
    { path: "server.mjs", env: { FOO: 3 } },
    { path: "server.mjs", env: { NODE_OPTIONS: "--require bad.js" } },
    { path: "server.mjs", env: { CREDENTIAL: "Bearer private-fixture" } },
    { path: "server.mjs", tools: [3] },
    { path: "server.mjs", timeoutMs: 0 },
    { path: "server.mjs", timeoutMs: 1.5 },
    { path: "server.mjs", timeoutMs: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    test(`${id} rejects closed MCP config ${JSON.stringify(entry)}`, () => {
      expect(
        () =>
          new Agent({
            config: {
              delegate: { id, config: { mcpServers: { fixture: entry } } },
              workspace: { sources: [] },
            },
          }),
      ).toThrow();
    });
  }
  for (const name of ["", "a.b", "a/b", "a b", "a".repeat(65)]) {
    test(`${id} rejects invalid server name ${JSON.stringify(name)}`, () => {
      expect(
        () =>
          new Agent({
            config: {
              delegate: { id, config: { mcpServers: { [name]: { path: "server.mjs" } } } },
              workspace: { sources: [] },
            },
          }),
      ).toThrow();
    });
  }
}

for (const id of candidates) {
  test(`${id} does not discover servers from workspace config files`, async () => {
    const root = await projectFor(id);
    const marker = join(root, "discovered-server-ran");
    const discovery = JSON.stringify({
      mcpServers: {
        rogue: {
          command: process.execPath,
          args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unsafe')`],
        },
      },
    });
    for (const name of [
      ".mcp.json",
      ".github/mcp.json",
      ".vscode/mcp.json",
      ".copilot/mcp-config.json",
    ]) {
      const target = join(root, "mocks", name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, discovery);
    }
    const provider = candidate(root, id, { path: "server.mjs" }, {}, ".eval-mocks");
    try {
      expect((await provider.callApi("search fixtures")).error).toBeUndefined();
      expect((await provider.callApi(request({ server: "rogue" }))).error).toContain("unavailable");
      expect(existsSync(marker)).toBe(false);
    } finally {
      await provider.cleanup();
    }
  });

  for (const name of ["__proto__", "constructor", "with__parts"]) {
    test(`${id} executes configured server ${name} without prototype or namespace confusion`, async () => {
      const root = await projectFor(id);
      const provider = candidate(
        root,
        id,
        {},
        { mcpServers: Object.fromEntries([[name, { path: ".eval-mocks/server.mjs" }]]) },
      );
      try {
        const response = await provider.callApi(request({ server: name }));
        expect(response.error).toBeUndefined();
        expect(JSON.parse(String(response.output)).result).toBe("canned code match");
      } finally {
        await provider.cleanup();
      }
    });
  }

  test(`${id} rejects unsafe per-test MCP overrides before executing a tool`, async () => {
    const root = await projectFor(id);
    const provider = candidate(root, id);
    try {
      const response = await provider.callApi("search fixtures", {
        prompt: {
          config: {
            delegate: {
              config: {
                mcpServers: {
                  fixture: {
                    path: ".eval-mocks/server.mjs",
                    env: { NODE_OPTIONS: "--require unsafe" },
                  },
                },
              },
            },
          },
        },
      });
      expect(response.error).toMatch(/reserved/);
    } finally {
      await provider.cleanup();
    }
  });
}

for (const id of ["openai:codex-sdk", "pi-sdk"]) {
  test(`${id} does not accept MCP configuration`, () => {
    expect(
      () =>
        new Agent({
          config: {
            delegate: { id, config: { mcpServers: { fixture: { path: "server.mjs" } } } },
            workspace: { sources: [] },
          },
        }),
    ).toThrow(/mcpServers/);
  });
}

test("direct Copilot runs contained Node scripts and follows only contained links", async () => {
  const root = await consumerProject();
  await symlink(join(root, "mocks", "server.mjs"), join(root, "server-link.mjs"));
  const provider = new CopilotSdk({
    config: {
      basePath: root,
      working_dir: ".",
      mcpServers: { fixture: { path: "server-link.mjs", env: { MOCK_MODE: "direct" } } },
    },
  });
  try {
    const response = await provider.callApi("search fixtures");
    expect(response.error).toBeUndefined();
    expect(JSON.parse(String(response.output))).toMatchObject({
      result: "canned code match",
      mode: "direct",
      env: { MOCK_MODE: "direct" },
    });
  } finally {
    await provider.cleanup();
  }
});

test("partial MCP resolution failure removes owner-private control files", async () => {
  const root = await consumerProject();
  vi.stubEnv(process.platform === "win32" ? "TEMP" : "TMPDIR", root);
  const provider = candidate(
    root,
    "copilot-sdk",
    {},
    {
      mcpServers: {
        first: { path: ".eval-mocks/server.mjs", env: { LITERAL: "private-control-fixture" } },
        missing: { path: ".eval-mocks/missing.mjs" },
      },
    },
  );
  try {
    const response = await provider.callApi("search fixtures");
    expect(response.error).toMatch(/ENOENT|no such file/i);
    expect(
      (await readdir(root)).filter((name) => name.startsWith("allagents-mcp-config-")),
    ).toEqual([]);
  } finally {
    await provider.cleanup();
  }
});

for (const id of candidates) {
  test(`${id} rejects case-variant startup injection in per-test MCP overrides`, async () => {
    const root = await projectFor(id);
    const marker = join(root, "startup-injection-ran");
    const provider = candidate(root, id);
    const preload = `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'unsafe')`;
    try {
      for (const key of ["node_options", "Node_Options", "allagents_git_token"]) {
        const response = await provider.callApi("search fixtures", {
          prompt: {
            config: {
              delegate: {
                config: {
                  mcpServers: {
                    fixture: {
                      path: ".eval-mocks/server.mjs",
                      env: {
                        [key]: `--import=data:text/javascript,${encodeURIComponent(preload)}`,
                      },
                    },
                  },
                },
              },
            },
          },
        });
        expect(response.error).toMatch(/reserved/);
        expect(existsSync(marker)).toBe(false);
      }
    } finally {
      await provider.cleanup();
    }
  });
}

for (const names of [
  ["a", "a__b"],
  ["a__b", "a"],
]) {
  test(`Claude rejects ambiguous configured server prefixes ${names.join(",")}`, () => {
    expect(
      () =>
        new Agent({
          config: {
            delegate: {
              id: "anthropic:claude-agent-sdk",
              config: {
                mcpServers: Object.fromEntries(
                  names.map((name) => [
                    name,
                    { path: "server.mjs", tools: name === "a" ? ["b__read"] : ["other"] },
                  ]),
                ),
              },
            },
            workspace: { sources: [] },
          },
        }),
    ).toThrow(/ambiguous.*namespace/i);
  });
}

test("Claude rejects ambiguous namespace prefixes in per-test overrides", async () => {
  const root = await projectFor("anthropic:claude-agent-sdk");
  const provider = candidate(root, "anthropic:claude-agent-sdk");
  try {
    const response = await provider.callApi("search fixtures", {
      prompt: {
        config: {
          delegate: {
            config: {
              mcpServers: {
                a: { path: ".eval-mocks/server.mjs" },
                a__b: { path: ".eval-mocks/server.mjs" },
              },
            },
          },
        },
      },
    });
    expect(response.error).toMatch(/ambiguous.*namespace/i);
  } finally {
    await provider.cleanup();
  }
});

test("Copilot retains authoritative structured identity for overlapping server prefixes", async () => {
  const root = await consumerProject();
  const spans: ReadableSpan[] = [];
  const telemetry = new NodeTracerProvider({
    spanProcessors: [
      {
        onStart() {},
        onEnd(span) {
          spans.push(span);
        },
        async forceFlush() {},
        async shutdown() {},
      },
    ],
  });
  telemetry.register({
    propagator: new W3CTraceContextPropagator(),
    contextManager: new AsyncLocalStorageContextManager(),
  });
  const provider = candidate(
    root,
    "copilot-sdk",
    {},
    {
      mcpServers: {
        a: { path: ".eval-mocks/server.mjs", tools: ["b__read"] },
        a__b: { path: ".eval-mocks/server.mjs", tools: ["other"] },
      },
    },
  );
  try {
    const response = await provider.callApi(request({ server: "a", tool: "b__read" }));
    expect(response.error).toBeUndefined();
    expect(
      spans.find((span) => span.attributes["gen_ai.tool.call.id"] === "mcp-1")?.attributes,
    ).toMatchObject({
      "gen_ai.tool.mcp.server": "a",
      "gen_ai.tool.mcp.tool": "b__read",
    });
  } finally {
    await provider.cleanup();
    await telemetry.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
  }
});

for (const id of candidates) {
  test(`${id} abrupt launcher death kills a synchronously blocked Node server`, async () => {
    const root = await projectFor(id);
    const pidFile = join(root, "busy-pid.json");
    const provider = candidate(root, id);
    const controller = new AbortController();
    let pid: number | undefined;
    const response = provider.callApi(request({ arguments: { pidFile, busy: true } }), undefined, {
      abortSignal: controller.signal,
    });
    try {
      await waitForFile(pidFile);
      const marker = JSON.parse(await readFile(pidFile, "utf8"));
      pid = marker.pid;
      process.kill(marker.parent, "SIGKILL");
      expect((await response).error).toMatch(/MCP exited/);
      await expectGone(marker.pid);
      await expectGone(marker.parent);
      expect(existsSync(marker.controlFile)).toBe(false);
    } finally {
      controller.abort();
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      await response;
      await provider.cleanup();
    }
  });
}

test("public delegate and direct Copilot env reject case-variant reserved names", () => {
  for (const name of [
    "node_options",
    "node_path",
    "BuN_Options",
    "ld_preload",
    "ld_library_path",
    "dyld_insert_libraries",
    "pAtH",
    "hOmE",
    "tMpDiR",
    "AllAgents_GIT_TOKEN",
  ]) {
    expect(
      () =>
        new CopilotSdk({ config: { working_dir: ".", env: { [name]: "private-fixture-value" } } }),
    ).toThrow(/reserved/);
    expect(
      () =>
        new Agent({
          config: {
            delegate: { id: "copilot-sdk", env: { [name]: "private-fixture-value" } },
            workspace: { sources: [] },
          },
        }),
    ).toThrow(/reserved/);
  }
});
