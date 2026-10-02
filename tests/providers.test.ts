import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { realpathSync, statSync } from "node:fs";
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
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
} from "../packages/promptfoo-x/src/config";
import { CopilotSdkProvider, Provider } from "../packages/promptfoo-x/src/index";
import {
  type CallFrame,
  jsonSafe,
  runDelegate,
  wireContext,
} from "../packages/promptfoo-x/src/protocol";
import { atomicJson, MARKER, protect, removeTree } from "../packages/workspace-core/src/fs";

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
const native = `import {chmod,writeFile} from 'node:fs/promises';
import {writeSync} from 'node:fs';
export async function loadApiProvider(id, options) {
 return {async callApi(prompt,context,callOptions){
  if(prompt==='malformed')writeSync(1,'not-json\\n');
  if(prompt==='unknown-frame')writeSync(1,JSON.stringify({version:1,type:'unsupported'})+'\\n');
  if(prompt==='duplicate')writeSync(1,JSON.stringify({version:1,type:'result',response:{output:'premature'}})+'\\n');
  if(prompt==='write')await writeFile(options.options.config.working_dir+'/generated.txt','generated durable content');
  if(prompt==='tamper-protected'){const file=options.options.config.working_dir+'/repo/input.txt';await chmod(file,0o644);await writeFile(file,'modified protected source');}
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
        "cli_env",
        "inherit_process_env",
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
  test("provider refuses unsafe HTTPS staging instead of trying a privileged helper", async () => {
    const root = await mkdtemp(join(realpathSync(tmpdir()), "allagents-provider-stage-"));
    roots.push(root);
    const staging = join(root, "not-tmpfs");
    await mkdir(staging, { mode: 0o700 });
    const prior = process.env.ALLAGENTS_NO_PRIVILEGED_HELPER;
    process.env.ALLAGENTS_NO_PRIVILEGED_HELPER = "1";
    let provider: Provider | undefined;
    try {
      provider = new Provider({
        config: {
          delegate: { id: "openai:codex-sdk" },
          workspace: {
            sources: [
              {
                type: "git",
                repository: "https://github.com/octocat/Hello-World.git",
                ref: "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d",
                destination: "project",
              },
            ],
          },
        },
        env: {
          ALLAGENTS_CACHE_ROOT: join(root, "cache"),
          ALLAGENTS_WORKSPACE_ROOT: join(root, "runtime"),
          ALLAGENTS_GIT_STAGING_ROOT: staging,
        },
      });
      const result = await provider.callApi("no delegate should run");
      expect(result.error).toMatch(
        /Git staging (root must reside on a uniquely identified tmpfs mount|tmpfs byte\/inode capacity)/,
      );
    } finally {
      try {
        await provider?.cleanup();
      } finally {
        if (prior === undefined) delete process.env.ALLAGENTS_NO_PRIVILEGED_HELPER;
        else process.env.ALLAGENTS_NO_PRIVILEGED_HELPER = prior;
      }
    }
  });
  test("prepared remote Git runs offline, reuses clean views, and refuses mismatches or tampering", async () => {
    const path = await project("promptfoo", native);
    const repository = join(path, "local");
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
    const commit = (await git("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
    const repositoryUrl = "https://invalid.example.test/offline.git";
    const source = {
      type: "git" as const,
      repository: repositoryUrl,
      ref: commit,
      destination: "repo",
      permissions: "read-only" as const,
    };
    const key = createHash("sha256")
      .update(JSON.stringify([repositoryUrl, commit, "repo"]))
      .digest("hex");
    const prepared = join(path, "prepared");
    const protectedPath = join(prepared, "sources", key, "protected");
    await mkdir(join(prepared, "sources", key), { recursive: true, mode: 0o700 });
    await git("git", [
      "clone",
      "-q",
      "--bare",
      "--no-hardlinks",
      repository,
      join(prepared, "sources", key, "mirror"),
    ]);
    await chmod(join(prepared, "sources", key, "mirror"), 0o700);
    await cp(repository, join(prepared, "sources", key, "seed"), { recursive: true });
    await chmod(join(prepared, "sources", key, "seed"), 0o700);
    await cp(repository, protectedPath, { recursive: true });
    await protect(protectedPath, false);
    await chmod(prepared, 0o700);
    await chmod(join(prepared, "sources"), 0o700);
    await atomicJson(join(prepared, MARKER), {
      schemaVersion: 1,
      package: "@allagents/promptfoo-integration",
      kind: "prebuilt-sources",
    });
    await atomicJson(join(prepared, "manifest.json"), {
      schemaVersion: 1,
      sources: [{ repository: repositoryUrl, commit, destination: "repo" }],
    });
    const options = {
      config: {
        basePath: path,
        delegate: { id: "openai:codex-sdk" as const },
        workspace: { sources: [source], viewMode: "copy-only" as const },
      },
      env: {
        ALLAGENTS_CACHE_ROOT: join(path, "cache"),
        ALLAGENTS_WORKSPACE_ROOT: join(path, "runtime"),
        ALLAGENTS_PREBUILT_ROOT: prepared,
        ALLAGENTS_NO_PRIVILEGED_HELPER: "1",
      },
    };
    const provider = new Provider(options);
    try {
      const first = await provider.callApi("clean");
      expect(first.error).toBeUndefined();
      const workspace = (first.metadata as { workspace?: Record<string, unknown> } | undefined)
        ?.workspace;
      if (
        !workspace ||
        typeof workspace !== "object" ||
        Array.isArray(workspace) ||
        typeof workspace.path !== "string" ||
        !Array.isArray(workspace.sources)
      )
        throw new Error("Prepared workspace metadata missing");
      expect(workspace.sources[0]).toMatchObject({
        repository: repositoryUrl,
        commit,
        destination: "repo",
      });
      const linked = await readlink(join(workspace.path, "repo"));
      expect(linked).toBe(protectedPath);
      expect((await provider.callApi("clean-reuse")).error).toBeUndefined();
      expect(await readdir(join(options.env.ALLAGENTS_CACHE_ROOT, "published"))).toEqual([]);
      const mixed = new Provider({
        ...options,
        config: {
          ...options.config,
          workspace: {
            ...options.config.workspace,
            sources: [
              source,
              {
                type: "git" as const,
                repository: pathToFileURL(repository).href,
                ref: commit,
                destination: "skills",
                permissions: "all" as const,
              },
            ],
          },
        },
      });
      try {
        const result = await mixed.callApi("clean-mixed");
        expect(result.error).toBeUndefined();
        const mixedWorkspace = (
          result.metadata as { workspace?: Record<string, unknown> } | undefined
        )?.workspace;
        if (
          !mixedWorkspace ||
          typeof mixedWorkspace !== "object" ||
          Array.isArray(mixedWorkspace) ||
          typeof mixedWorkspace.path !== "string"
        )
          throw new Error("Mixed workspace metadata missing");
        expect(await readFile(join(mixedWorkspace.path, "skills", "input.txt"), "utf8")).toBe(
          "immutable source",
        );
        expect(await readlink(join(mixedWorkspace.path, "repo"))).toBe(protectedPath);
        expect(mixedWorkspace.manifestDigest).not.toBe(workspace.manifestDigest);
        expect(await readdir(join(options.env.ALLAGENTS_CACHE_ROOT, "published"))).toHaveLength(1);
      } finally {
        await mixed.cleanup();
      }
      const started: unknown[] = [];
      const onProgress = (value: unknown) => {
        if (value && typeof value === "object" && "phase" in value && value.phase === "agent-start")
          started.push(value);
      };
      subscribe("allagents.workspace.progress", onProgress);
      try {
        for (const [sources, reason] of [
          [
            [{ ...source, repository: "https://invalid.example.test/other.git" }],
            "manifest does not match",
          ],
          [[{ ...source, ref: "f".repeat(40) }], "manifest does not match"],
          [[{ ...source, destination: "wrong" }], "manifest does not match"],
          [[{ ...source, permissions: "all" as const }], "refuses writable remote Git"],
          [
            [
              {
                type: "oci" as const,
                repository: "example.org/offline/image",
                digest: `sha256:${"a".repeat(64)}` as const,
                destination: "other",
              },
            ],
            "refuses remote OCI",
          ],
          [[], "manifest does not match"],
        ] as const) {
          const mismatch = new Provider({
            ...options,
            config: {
              ...options.config,
              workspace: { ...options.config.workspace, sources: [...sources] },
            },
          });
          try {
            expect((await mismatch.callApi("write")).error).toContain(reason);
            expect(started).toEqual([]);
          } finally {
            await mismatch.cleanup();
          }
        }
      } finally {
        unsubscribe("allagents.workspace.progress", onProgress);
      }
      const tamper = await provider.callApi("tamper-protected");
      expect(tamper.error).toContain("Prepared source checkout failed integrity verification");
      expect((await provider.callApi("write")).error).toContain("invalidated");
      expect(await readFile(join(protectedPath, "input.txt"), "utf8")).toBe(
        "modified protected source",
      );
    } finally {
      await provider.cleanup();
    }
    expect(await readFile(join(protectedPath, "input.txt"), "utf8")).toBe(
      "modified protected source",
    );
  }, 30_000);
  async function workspaceProvider(fileChanges = false, readOnly = false) {
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
              permissions: readOnly ? "read-only" : "all",
            },
          ],
          viewMode: readOnly ? "copy-only" : "auto",
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
  test("progress follows seed acquisition, protected copy, reuse and agent outcomes without private data", async () => {
    const { path, provider } = await workspaceProvider(false, true);
    const events: Record<string, unknown>[] = [];
    const listener = (message: unknown) => events.push(message as Record<string, unknown>);
    subscribe("allagents.workspace.progress", listener);
    try {
      const success = await provider.callApi("private-first-prompt");
      expect(success.error).toBeUndefined();
      const failure = await provider.callApi("error");
      expect(failure.error).toBe("native failure");
      const aborted = new AbortController();
      aborted.abort();
      const cancellation = await provider.callApi("private-aborted-prompt", undefined, {
        abortSignal: aborted.signal,
      });
      expect(cancellation.error).toBeDefined();
      const first = events[0].caseIndex;
      const second = events.find((event) => event.phase === "seed-cache-hit")?.caseIndex;
      const third = events.at(-1)?.caseIndex;
      expect([first, second, third].every((index) => Number.isSafeInteger(index))).toBe(true);
      expect(new Set([first, second, third]).size).toBe(3);
      expect(success.metadata).toEqual(expect.objectContaining({ allagentsCaseIndex: first }));
      expect(failure.metadata).toEqual(expect.objectContaining({ allagentsCaseIndex: second }));
      expect(cancellation.metadata).toEqual(expect.objectContaining({ allagentsCaseIndex: third }));
      expect(events).toEqual([
        { phase: "case-start", caseIndex: first },
        { phase: "seed-start", caseIndex: first, sourceCount: 1 },
        { phase: "source-start", caseIndex: first, sourceIndex: 1, sourceCount: 1 },
        {
          phase: "source-finished",
          caseIndex: first,
          sourceIndex: 1,
          sourceCount: 1,
          outcome: "ok",
        },
        { phase: "seed-ready", caseIndex: first, sourceCount: 1 },
        { phase: "protected-copy-start", caseIndex: first, sourceIndex: 1, sourceCount: 1 },
        {
          phase: "protected-copy-finished",
          caseIndex: first,
          sourceIndex: 1,
          sourceCount: 1,
          outcome: "ok",
        },
        { phase: "workspace-ready", caseIndex: first },
        { phase: "agent-start", caseIndex: first },
        { phase: "agent-finished", caseIndex: first, outcome: "ok" },
        { phase: "case-finished", caseIndex: first, outcome: "ok" },
        { phase: "case-start", caseIndex: second },
        { phase: "seed-cache-hit", caseIndex: second, sourceCount: 1 },
        { phase: "seed-ready", caseIndex: second, sourceCount: 1 },
        { phase: "workspace-ready", caseIndex: second },
        { phase: "agent-start", caseIndex: second },
        { phase: "agent-finished", caseIndex: second, outcome: "error" },
        { phase: "case-finished", caseIndex: second, outcome: "error" },
        { phase: "case-start", caseIndex: third },
        { phase: "case-finished", caseIndex: third, outcome: "error" },
      ]);
      const serialized = JSON.stringify(events);
      for (const forbidden of [
        path,
        pathToFileURL(join(path, "source")).href,
        "private-first-prompt",
        "private-aborted-prompt",
        "native failure",
        "immutable source",
      ])
        expect(serialized).not.toContain(forbidden);
      for (const event of events)
        expect(
          Object.keys(event).every((key) =>
            ["phase", "caseIndex", "sourceIndex", "sourceCount", "outcome"].includes(key),
          ),
        ).toBe(true);
    } finally {
      unsubscribe("allagents.workspace.progress", listener);
      await provider.cleanup();
    }
  }, 15_000);
  // POSIX owners can change a protected file's mode; Windows ACLs deny that mutation.
  const onPosix = process.platform === "win32" ? test.skip : test;
  onPosix(
    "provider rejects protected checkout mutations made by a delegate",
    async () => {
      const { provider } = await workspaceProvider(false, true);
      try {
        const result = await provider.callApi("tamper-protected");
        expect(result.error).toMatch(/Protected source checkout mutated/);
        expect(result.output).toBeUndefined();
      } finally {
        await provider.cleanup();
      }
    },
    15_000,
  );
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
  test("Codex passes explicit delegate environment to its CLI without inheriting the runner", async () => {
    const path = await project(
      "promptfoo",
      `export async function loadApiProvider(id, options) {
        const cli = options.options.config.cli_env;
        return {async callApi(){return {output:
          id==='openai:codex-sdk' &&
          Object.keys(cli).sort().join(',')==='AZURE_OPENAI_API_KEY,CODEX_HOME' &&
          cli.CODEX_HOME===process.env.CODEX_HOME &&
          cli.AZURE_OPENAI_API_KEY===process.env.AZURE_OPENAI_API_KEY &&
          options.options.config.inherit_process_env===undefined ? 'ok' : 'fail'
        };}};
      }`,
    );
    const result = await runDelegate(
      frame(path),
      { CODEX_HOME: "/tmp/fixture-codex-home", AZURE_OPENAI_API_KEY: "fixture-secret" },
      5000,
    );
    expect(result.output).toBe("ok");
  });
  test("redacts credentials from response fields and native config echoes", async () => {
    const path = await project("promptfoo", native);
    const f = frame(path, "sensitive-token");
    f.config = { apiKey: "sensitive-token" };
    const result = await runDelegate(
      f,
      { OPENAI_API_KEY: "sensitive-token", EXTRA_TEST: "unpassed" },
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
  test("passes BYOK object, applies permission policy, and emits usage without invented skills", async () => {
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
    const directory = statSync(output.directory);
    const fixture = statSync(path);
    expect(directory.isDirectory()).toBe(true);
    expect([directory.dev, directory.ino]).toEqual([fixture.dev, fixture.ino]);
    expect(output.discovery).toBe(false);
    expect(response.tokenUsage).toEqual({
      prompt: 4,
      completion: 2,
      total: 6,
      cached: 1,
      numRequests: 1,
    });
    const metadata = response.metadata as {
      copilot: { skillSupport: boolean };
      skillCalls: unknown[];
    };
    expect(metadata.copilot.skillSupport).toBe(true);
    expect(metadata.skillCalls).toEqual([]);
    await provider.cleanup();
    expect((await provider.callApi("again")).error).toContain("closed");
    await access(path);
  });
  test("reports only observed, successful, contained SKILL.md read tool events", async () => {
    const fixture = await readFile(new URL("./fixtures/copilot-sdk.mjs", import.meta.url), "utf8");
    const path = await project("@github/copilot-sdk", fixture);
    const skillPath = join(path, ".agents", "skills", "cw-sql-schema-migration", "SKILL.md");
    await mkdir(join(path, ".agents", "skills", "cw-sql-schema-migration"), {
      recursive: true,
    });
    await writeFile(skillPath, "# SQL migration\n");
    await mkdir(join(path, "docs", "cw-sql-schema-migration"), { recursive: true });
    await writeFile(
      join(path, "docs", "cw-sql-schema-migration", "SKILL.md"),
      "# Not installed as a skill\n",
    );
    await writeFile(join(path, "README.md"), "# Not a skill\n");
    const external = await mkdtemp(join(realpathSync(tmpdir()), "allagents-outside-skill-"));
    roots.push(external);
    await writeFile(join(external, "SKILL.md"), "# Outside\n");
    await mkdir(join(path, ".agents", "skills", "alias"), { recursive: true });
    await symlink(join(path, "README.md"), join(path, ".agents", "skills", "alias", "SKILL.md"));
    // Windows icacls /T traverses directory links during fixture cleanup.
    if (process.platform !== "win32") {
      await symlink(
        join(path, ".agents", "skills", "cw-sql-schema-migration"),
        join(path, ".agents", "skills", "linked"),
      );
    }
    const provider = new CopilotSdkProvider({ config: { basePath: path, working_dir: "." } });
    const call = (request: object) => provider.callApi(`read:${JSON.stringify(request)}`);
    try {
      for (const request of [
        { path: ".agents/skills/cw-sql-schema-migration/SKILL.md" },
        { path: skillPath, toolName: "read", argumentKey: "file_path" },
        { path: skillPath, toolName: "view", argumentKey: "filePath" },
      ]) {
        const positive = await call(request);
        expect(positive.error).toBeUndefined();
        const positiveMetadata = positive.metadata as {
          copilot: { skillSupport: boolean };
          skillCalls: unknown[];
        };
        expect(positiveMetadata.copilot.skillSupport).toBe(true);
        expect(positiveMetadata.skillCalls).toHaveLength(1);
        const observed = positiveMetadata.skillCalls[0] as {
          name: string;
          path: string;
          source: string;
        };
        expect(observed.name).toBe("cw-sql-schema-migration");
        expect(observed.source).toBe("read-tool");
        const actualFile = statSync(observed.path);
        const expectedFile = statSync(skillPath);
        expect([actualFile.dev, actualFile.ino]).toEqual([expectedFile.dev, expectedFile.ino]);
      }
      for (const request of [
        { path: "README.md" },
        { path: "docs/cw-sql-schema-migration/SKILL.md" },
        { path: skillPath, toolName: "write_file" },
        { path: skillPath, mode: "failed" },
        { path: skillPath, mode: "started-only" },
        { path: skillPath, mode: "text-only" },
        { path: join(external, "SKILL.md") },
        { path: ".agents/skills/alias/SKILL.md" },
        ...(process.platform === "win32" ? [] : [{ path: ".agents/skills/linked/SKILL.md" }]),
        { path: skillPath, mcpServerName: "unrelated-server" },
        { path: ".agents/skills/missing/SKILL.md" },
      ]) {
        const response = await call(request);
        expect(response.error).toBeUndefined();
        const negativeMetadata = response.metadata as { skillCalls: unknown[] };
        expect(negativeMetadata.skillCalls).toEqual([]);
      }
    } finally {
      await provider.cleanup();
    }
  });
  test("workspace Provider exposes Copilot read-tool skill calls at top-level metadata", async () => {
    const fixture = await readFile(new URL("./fixtures/copilot-sdk.mjs", import.meta.url), "utf8");
    const path = await project("@github/copilot-sdk", fixture);
    const repository = join(path, "source");
    const skill = ".agents/skills/cw-sql-schema-migration/SKILL.md";
    await mkdir(join(repository, ".agents", "skills", "cw-sql-schema-migration"), {
      recursive: true,
    });
    await writeFile(join(repository, skill), "# SQL migration\n");
    const git = promisify(execFile);
    await git("git", ["init", "-q", repository]);
    await git("git", ["-C", repository, "add", "."]);
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
        delegate: { id: "copilot-sdk" },
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
      },
      env: {
        ALLAGENTS_CACHE_ROOT: join(path, "cache"),
        ALLAGENTS_WORKSPACE_ROOT: join(path, "runtime"),
      },
    });
    try {
      const response = await provider.callApi(`read:${JSON.stringify({ path: `repo/${skill}` })}`);
      expect(response.error).toBeUndefined();
      const metadata = response.metadata as {
        copilot: { skillSupport: boolean };
        skillCalls: unknown[];
        workspace: { path: string };
      };
      expect(metadata.copilot.skillSupport).toBe(true);
      expect(metadata.skillCalls).toEqual([
        {
          name: "cw-sql-schema-migration",
          path: join(metadata.workspace.path, "repo", skill),
          source: "read-tool",
        },
      ]);
    } finally {
      await provider.cleanup();
    }
  }, 15_000);
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
  const { resolvePeer } = await import("../packages/promptfoo-x/src/protocol.ts");
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
