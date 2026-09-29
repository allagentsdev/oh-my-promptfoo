import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { context as otelContext, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  promptConfig,
  validateCopilotConfig,
  validateDelegateConfig,
  validateProviderConfig,
} from "../packages/promptfoo-integration/src/config";
import { CopilotSdkProvider, Provider } from "../packages/promptfoo-integration/src/index";
import {
  type CallFrame,
  jsonSafe,
  runDelegate,
  wireContext,
} from "../packages/promptfoo-integration/src/protocol";
import { removeTree } from "../packages/workspace-core/src/fs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => removeTree(path)));
});
async function project(moduleName: string, source: string): Promise<string> {
  const path = await mkdtemp(join(realpathSync(tmpdir()), "allagents-providers-"));
  roots.push(path);
  const dir = join(path, "node_modules", moduleName);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: moduleName, type: "module", exports: "./index.js" }),
  );
  await writeFile(join(dir, "index.js"), source);
  return path;
}
const native = `import {writeFile} from 'node:fs/promises';
import {writeSync} from 'node:fs';
export async function loadApiProvider(id, options) {
 return {async callApi(prompt,context,callOptions){
  if(prompt==='malformed')writeSync(1,'not-json\\n');
  if(prompt==='unknown-frame')writeSync(1,JSON.stringify({version:1,type:'unsupported'})+'\\n');
  if(prompt==='duplicate')writeSync(1,JSON.stringify({version:1,type:'result',response:{output:'premature'}})+'\\n');
  if(prompt==='write')await writeFile(options.options.config.working_dir+'/generated.txt','generated durable content');
  if(prompt==='sleep'){await new Promise(()=>{});}
  if(prompt==='large') return {output:'x'.repeat(17000000)};
  if(prompt==='cache') return {output:'old',cached:true};
  if(prompt==='bad') return {output:()=>true};
  if(prompt==='collision') return {output:'ok',metadata:{workspace:{}}};
  if(prompt==='stderr'){process.stderr.write('x'.repeat(70000));await new Promise(()=>{});}
  if(prompt==='error') return {error:'native failure',output:'partial',metadata:{skillCalls:[{name:'fixture'}]}};
  return {output:prompt,tokenUsage:{prompt:2,completion:3,total:5},cost:0.5,raw:{native:true},publicField:[1,2],metadata:{skillCalls:[{name:'fixture'}],options,context}};
 },async cleanup(){await new Promise(r=>setTimeout(r,20));}};
}`;
function frame(
  path: string,
  prompt = "success",
  delegate: CallFrame["delegate"] = "openai:codex-sdk",
): CallFrame {
  return {
    version: 1,
    type: "call",
    delegate,
    basePath: path,
    workingDir: path,
    config: {},
    prompt,
    context: { bustCache: true },
  };
}
describe("closed configuration", () => {
  test("default-unwrapping package loaders retain both named provider constructors", () => {
    expect(Provider.Provider).toBe(Provider);
    expect(Provider.CopilotSdkProvider).toBe(CopilotSdkProvider);
  });
  test("rejects unknown, recursive and reserved fields at authored layers", () => {
    const workspace = {
      sources: [{ type: "git", repository: "file:///tmp/repo", ref: "HEAD", destination: "repo" }],
    };
    expect(() =>
      validateProviderConfig({ delegate: { id: "allagents:workspace" }, workspace }),
    ).toThrow();
    for (const id of ["openai:codex-sdk", "anthropic:claude-agent-sdk", "copilot-sdk"] as const) {
      for (const key of [
        "working_dir",
        "bustCache",
        "env",
        "basePath",
        "skip_git_repo_check",
        "persist_threads",
        "additional_directories",
        "cliPath",
      ])
        expect(() => validateDelegateConfig(id, { [key]: true })).toThrow();
      expect(() => promptConfig({ prompt: { config: { workspace } } }, id, {})).toThrow();
      expect(() => promptConfig({ prompt: { config: { delegate: { id } } } }, id, {})).toThrow();
    }
    expect(() =>
      validateProviderConfig({
        delegate: { id: "copilot-sdk", env: { ALLAGENTS_GIT_TOKEN: "secret" } },
        workspace,
      }),
    ).toThrow();
  });
  test("accepts endpoint objects and rejects credentials or unsupported fields", () => {
    expect(
      validateCopilotConfig({
        working_dir: ".",
        provider: { baseUrl: "https://api.example.test", apiKey: "secret", type: "openai" },
      }).provider?.apiKey,
    ).toBe("secret");
    for (const provider of [
      "openai",
      {},
      { baseUrl: "https://user:password@api.example.test" },
      { baseUrl: "https://api.example.test", headers: {} },
    ])
      expect(() => validateCopilotConfig({ working_dir: ".", provider })).toThrow();
    expect(() =>
      validateCopilotConfig({ working_dir: ".", permissions: { filesystem: "all" } }),
    ).toThrow();
  });
  test("merges only delegate config overrides", () => {
    expect(
      promptConfig(
        { prompt: { config: { prefix: undefined, suffix: undefined, provider: undefined } } },
        "copilot-sdk",
        { model: "base" },
      ),
    ).toEqual({ model: "base" });
    expect(promptConfig({ prompt: { config: {} } }, "openai:codex-sdk", { model: "base" })).toEqual(
      { model: "base" },
    );
    expect(
      promptConfig(
        { prompt: { config: { delegate: { config: { model: "override" } } } } },
        "openai:codex-sdk",
        { model: "base", sandbox_mode: "workspace-write" },
      ),
    ).toEqual({ model: "override", sandbox_mode: "workspace-write" });
  });
});
describe("workspace provider publication and lifetime", () => {
  async function workspaceProvider(fileChanges = false) {
    const path = await project("promptfoo", native);
    const repository = join(path, "source");
    await mkdir(repository);
    await writeFile(join(repository, "input.txt"), "immutable source");
    const git = promisify(execFile);
    await git("git", ["init", "-q", repository]);
    await git("git", [
      "-C",
      repository,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "add",
      ".",
    ]);
    await git("git", [
      "-C",
      repository,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "fixture",
    ]);
    const { stdout } = await git("git", ["-C", repository, "rev-parse", "HEAD"]);
    const provider = new Provider({
      config: {
        basePath: path,
        delegate: { id: "openai:codex-sdk" },
        workspace: {
          sources: [
            {
              type: "git",
              repository: pathToFileURL(repository).href,
              ref: stdout.trim(),
              destination: "repo",
            },
          ],
        },
        fileChanges,
      },
      env: {
        ALLAGENTS_CACHE_ROOT: join(path, "cache"),
        ALLAGENTS_WORKSPACE_ROOT: join(path, "runtime"),
      },
    });
    return { path, provider };
  }
  test("parallel rows remain assertion-accessible with distinct writable workspace paths", async () => {
    const { provider } = await workspaceProvider();
    try {
      const results = await Promise.all(
        ["success", "error"].map((prompt) => provider.callApi(prompt)),
      );
      expect(results[0].error).toBeUndefined();
      expect(results[1].error).toBe("native failure");
      const paths = results.map((r) => (r.metadata as any).workspace.path);
      expect(paths[0]).not.toBe(paths[1]);
      for (const [i, path] of paths.entries()) {
        await access(join(path, "repo", "input.txt"));
        await writeFile(join(path, "assertion.txt"), String(i));
        expect((results[i].metadata as any).workspace.cleanup).toBe("best-effort-evaluation");
        expect((results[i].metadata as any).fileChanges).toBeUndefined();
      }
      expect((results[0].metadata as any).workspace.manifestDigest).toBe(
        (results[1].metadata as any).workspace.manifestDigest,
      );
      expect((results[1].metadata as any).skillCalls).toEqual([{ name: "fixture" }]);
      await provider.cleanup();
      for (const path of paths) await expect(access(path)).rejects.toThrow();
    } finally {
      await provider.cleanup();
    }
  }, 15_000);
  test("file-change bytes survive workspace cleanup and metadata collisions do not publish paths", async () => {
    const { provider } = await workspaceProvider(true);
    try {
      const result = await provider.callApi("write");
      expect(result.error).toBeUndefined();
      const metadata = result.metadata as any;
      expect(
        Buffer.from(
          metadata.fileChanges.generatedFiles["generated.txt"].content,
          "base64",
        ).toString(),
      ).toBe("generated durable content");
      await access(metadata.workspace.path);
      const collision = await provider.callApi("collision");
      expect(collision.error).toContain("reserved");
      expect(collision.metadata).toBeUndefined();
      await provider.cleanup();
      await expect(access(metadata.workspace.path)).rejects.toThrow();
      expect(
        Buffer.from(
          metadata.fileChanges.generatedFiles["generated.txt"].content,
          "base64",
        ).toString(),
      ).toBe("generated durable content");
    } finally {
      await provider.cleanup();
    }
  }, 15_000);
});
describe("protocol and native adapters", () => {
  test("native SDK discovery uses the consumer while agent writes use external workspace storage", async () => {
    const path = await project(
      "promptfoo",
      `import {writeFile} from 'node:fs/promises';
       export async function loadApiProvider(id, options) {
         if(process.cwd()!==options.basePath)throw Error('SDK discovery escaped consumer');
         return {async callApi(){
           await writeFile(options.options.config.working_dir+'/output.txt',id);
           return {output:process.cwd()};
         }};
       }`,
    );
    const workingDir = await mkdtemp(join(realpathSync(tmpdir()), "allagents-external-workspace-"));
    roots.push(workingDir);
    for (const id of ["openai:codex-sdk", "anthropic:claude-agent-sdk"] as const) {
      const result = await runDelegate({ ...frame(path, "success", id), workingDir }, {}, 5000);
      expect(result.output).toBe(path);
      expect(await readFile(join(workingDir, "output.txt"), "utf8")).toBe(id);
      await expect(access(join(path, "output.txt"))).rejects.toThrow();
    }
  });
  test("all native fields survive final path/cache injection for both native IDs", async () => {
    const path = await project("promptfoo", native);
    for (const id of ["openai:codex-sdk", "anthropic:claude-agent-sdk"] as const) {
      const result = await runDelegate(frame(path, "success", id), {}, 5000);
      expect(result.raw).toEqual({ native: true });
      expect(result.publicField).toEqual([1, 2]);
      expect(result.tokenUsage).toEqual({ prompt: 2, completion: 3, total: 5 });
      expect(result.cost).toBe(0.5);
      const metadata = result.metadata as any;
      expect(metadata.skillCalls).toEqual([{ name: "fixture" }]);
      expect(metadata.options.options.config.working_dir).toBe(path);
      expect(metadata.options.options.config.bustCache).toBeUndefined();
      expect(metadata.options.options.config.skip_git_repo_check).toBe(
        id === "openai:codex-sdk" ? true : undefined,
      );
      expect(metadata.context.bustCache).toBe(true);
    }
  });
  test("redacts credentials from response fields and native config echoes", async () => {
    const path = await project("promptfoo", native);
    const f = frame(path, "sensitive-token");
    f.config = { apiKey: "sensitive-token" };
    const result = await runDelegate(
      f,
      { OPENAI_API_KEY: "sensitive-token", ALLAGENTS_TEST: "unpassed" },
      5000,
    );
    expect(JSON.stringify(result)).not.toContain("sensitive-token");
    expect(result.output).toBe("[REDACTED]");
  });
  test("rejects malformed, unknown, duplicate and post-terminal frames", async () => {
    const path = await project("promptfoo", native);
    for (const prompt of ["malformed", "unknown-frame", "duplicate"])
      await expect(runDelegate(frame(path, prompt), {}, 5000)).rejects.toThrow("protocol");
  }, 10_000);
  test("timeouts, cancellation, oversized output and cached responses fail closed", async () => {
    const path = await project("promptfoo", native);
    await expect(runDelegate(frame(path, "sleep"), {}, 80)).rejects.toThrow("timeout");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 80);
    await expect(runDelegate(frame(path, "sleep"), {}, 5000, controller.signal)).rejects.toThrow(
      "aborted",
    );
    await expect(runDelegate(frame(path, "large"), {}, 5000)).rejects.toThrow("byte limit");
    await expect(runDelegate(frame(path, "cache"), {}, 5000)).rejects.toThrow("cached response");
    await expect(runDelegate(frame(path, "bad"), {}, 5000)).rejects.toThrow("JSON-safe");
    await expect(runDelegate(frame(path, "stderr"), {}, 5000)).rejects.toThrow("stderr");
  }, 15_000);
  test("wire context rejects functions and omits live execution objects", () => {
    expect(() => wireContext({ prompt: { raw: () => "prompt" } })).toThrow("JSON-safe");
    expect(
      wireContext({
        provider: { callApi() {} },
        vars: { value: 1 },
        filters: { fn() {} },
        test: { metadata: { id: 1 }, assert: [{ value: () => true }] },
      }),
    ).toEqual({ bustCache: true, vars: { value: 1 }, test: { metadata: { id: 1 } } });
    for (const value of [Symbol("x"), new Uint8Array([1]), { fn() {} }, { n: NaN }, [undefined]])
      expect(() => jsonSafe(value)).toThrow();
    const circular: any = {};
    circular.self = circular;
    expect(() => jsonSafe(circular)).toThrow("Circular");
    expect(jsonSafe({ optional: undefined, field: "preserved" })).toBe('{"field":"preserved"}');
  });
});
const sdk = `export class CopilotClient {
 constructor(options){this.options=options;}
 async createSession(config){let listener;return {
  on(fn){listener=fn;return ()=>{};},
  async sendAndWait({prompt}){
   listener({type:'tool.execution_start',data:{toolCallId:'one',toolName:'write',arguments:{path:'out'}}});
   listener({type:'tool.execution_complete',data:{toolCallId:'one',success:true}});
   listener({type:'assistant.usage',data:{inputTokens:4,outputTokens:2,cacheReadTokens:1,cost:0.1}});
   listener({type:'assistant.message',data:{content:'answer'}});
   return {data:{content:JSON.stringify({provider:config.provider,permissions:['read','write','shell','url','mcp'].map(kind=>config.onPermissionRequest({kind})),directory:config.workingDirectory,discovery:config.enableConfigDiscovery})}};
  },async abort(){},async disconnect(){}};}
 async stop(){return [];} async forceStop(){}
}`;
describe("direct Copilot provider", () => {
  test("passes BYOK object, applies permission policy, emits normalized usage and disables inferred skills", async () => {
    const path = await project("@github/copilot-sdk", sdk);
    const provider = new CopilotSdkProvider({
      config: {
        basePath: path,
        working_dir: ".",
        provider: { baseUrl: "https://api.example.test", apiKey: "private-api-key" },
        permissions: { filesystem: "write", shell: "deny", network: "allow" },
      },
    });
    const response = await provider.callApi("question");
    const output = JSON.parse(response.output as string);
    expect(output.provider).toEqual({ baseUrl: "https://api.example.test", apiKey: "[REDACTED]" });
    expect(output.permissions.map((p: any) => p.kind)).toEqual([
      "approve-once",
      "approve-once",
      "reject",
      "approve-once",
      "reject",
    ]);
    expect(output.directory).toBe(path);
    expect(output.discovery).toBe(false);
    expect(response.tokenUsage).toEqual({
      prompt: 4,
      completion: 2,
      total: 6,
      cached: 1,
      numRequests: 1,
    });
    expect((response.metadata as any).copilot.skillSupport).toBe(false);
    await provider.cleanup();
    expect((await provider.callApi("again")).error).toContain("closed");
    await access(path);
  });
  test("missing SDK is actionable and pre-abort performs no execution", async () => {
    const path = await project("unrelated", "export {};");
    const provider = new CopilotSdkProvider({ config: { basePath: path, working_dir: "." } });
    expect((await provider.callApi("test")).error).toContain("Install @github/copilot-sdk@1.0.6");
    const controller = new AbortController();
    controller.abort();
    expect(
      (await provider.callApi("test", undefined, { abortSignal: controller.signal })).error,
    ).toContain("aborted");
  });
});
describe("native tracing relay", () => {
  test("preserves row trace, nested native span ancestry, attributes and duration", async () => {
    const completed: any[] = [];
    const tracerProvider = new NodeTracerProvider({
      spanProcessors: [
        {
          onStart() {},
          onEnd(span) {
            completed.push(span);
          },
          async forceFlush() {},
          async shutdown() {},
        },
      ],
    });
    tracerProvider.register({
      propagator: new W3CTraceContextPropagator(),
      contextManager: new AsyncLocalStorageContextManager(),
    });
    try {
      const apiPath = createRequire(import.meta.url).resolve("@opentelemetry/api");
      const path = await project(
        "promptfoo",
        `import {trace} from ${JSON.stringify(pathToFileURL(apiPath).href)};
      export async function loadApiProvider(){return {async callApi(){return trace.getTracer('fixture').startActiveSpan('native-parent',async span=>{const tool=trace.getTracer('fixture').startSpan('native-tool',{attributes:{'gen_ai.tool.name':'read_file','gen_ai.operation.name':'execute_tool','native.number':12}});await new Promise(resolve=>setTimeout(resolve,25));tool.setAttribute('native.final','present');tool.end();span.end();return{output:'traced'};});},async cleanup(){}};}`,
      );
      const f = frame(path);
      f.context.traceparent = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
      expect((await runDelegate(f, {}, 5000)).output).toBe("traced");
      const parent = completed.find((s) => s.name === "native-parent");
      const tool = completed.find((s) => s.name === "native-tool");
      expect(tool.spanContext().traceId).toBe("0123456789abcdef0123456789abcdef");
      expect(parent.parentSpanContext.spanId).toBe("0123456789abcdef");
      expect(tool.parentSpanContext.spanId).toBe(parent.spanContext().spanId);
      expect(tool.attributes["gen_ai.tool.name"]).toBe("read_file");
      expect(tool.attributes["native.number"]).toBe(12);
      expect(tool.attributes["native.final"]).toBe("present");
      expect(tool.duration[0] * 1000 + tool.duration[1] / 1e6).toBeGreaterThanOrEqual(20);
    } finally {
      await tracerProvider.shutdown();
      trace.disable();
      propagation.disable();
      otelContext.disable();
    }
  });
});

test("native peer resolution selects the evaluation project import condition", async () => {
  const { resolvePeer } = await import("../packages/promptfoo-integration/src/protocol.ts");
  const path = await project("promptfoo", native);
  const root = join(path, "node_modules/promptfoo");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "promptfoo",
      type: "module",
      exports: { ".": { import: "./index.js", require: "./wrong.cjs" } },
    }),
  );
  await writeFile(join(root, "wrong.cjs"), "throw Error('CommonJS branch must never be imported')");
  expect(resolvePeer(path, "promptfoo")).toBe(join(root, "index.js"));
  const response = await runDelegate(frame(path, "import branch", "openai:codex-sdk"), {}, 5000);
  expect(response.error).toBeUndefined();
  expect(response.output).toBe("import branch");
});
