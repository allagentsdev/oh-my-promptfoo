import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
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
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { context as otelContext, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { NodeTracerProvider, type ReadableSpan } from "@opentelemetry/sdk-trace-node";
import {
  object,
  promptConfig,
  resolveSourcePaths,
  validateCopilotConfig,
  validateDelegateConfig,
  validateProviderConfig,
} from "../packages/oh-my-promptfoo/src/config";
import {
  CopilotSdkProvider,
  Provider,
  type WorkspaceMetadata,
} from "../packages/oh-my-promptfoo/src/index";
import {
  type CallFrame,
  jsonSafe,
  runDelegate,
  wireContext,
} from "../packages/oh-my-promptfoo/src/protocol";
import { atomicJson, MARKER, protect, removeTree } from "../packages/workspace-core/src/fs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => removeTree(path)));
});
async function project(
  moduleName: string,
  source: string,
  telemetryPackage = "@opentelemetry/api",
): Promise<string> {
  const path = await mkdtemp(join(realpathSync(tmpdir()), "allagents-providers-"));
  roots.push(path);
  const dir = join(path, "node_modules", moduleName);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: moduleName, type: "module", exports: "./index.js" }),
  );
  await writeFile(join(dir, "index.js"), source);
  if (moduleName === "promptfoo") await installTelemetryPeer(dir, telemetryPackage);
  return path;
}
async function telemetryPackageRoot(entry: string): Promise<string> {
  for (let directory = dirname(entry); ; directory = dirname(directory)) {
    const manifest = join(directory, "package.json");
    if (
      existsSync(manifest) &&
      object(JSON.parse(await readFile(manifest, "utf8")), "telemetry API package").name ===
        "@opentelemetry/api"
    )
      return directory;
    if (dirname(directory) === directory)
      throw new Error(`OpenTelemetry API package root not found for ${entry}`);
  }
}
async function installTelemetryPeer(path: string, name: string): Promise<void> {
  const packageRoot = await telemetryPackageRoot(createRequire(import.meta.url).resolve(name));
  const scope = join(path, "node_modules", "@opentelemetry");
  await mkdir(scope, { recursive: true });
  await symlink(packageRoot, join(scope, "api"), process.platform === "win32" ? "junction" : "dir");
}
const native = `import {chmod,readdir,readFile,utimes,writeFile} from 'node:fs/promises';
import {writeSync} from 'node:fs';
export async function loadApiProvider(id, options) {
 return {async callApi(prompt,context,callOptions){
  if(prompt==='malformed')writeSync(1,'not-json\\n');
  if(prompt==='unknown-frame')writeSync(1,JSON.stringify({version:1,type:'unsupported'})+'\\n');
  if(prompt==='duplicate')writeSync(1,JSON.stringify({version:1,type:'result',response:{output:'premature'}})+'\\n');
  if(prompt==='write')await writeFile(options.options.config.working_dir+'/generated.txt','generated durable content');
  if(prompt==='edit-local-skill')await writeFile(options.options.config.working_dir+'/.agents/skills/example/scripts/task.sh','echo agent\\n');
  if(prompt==='read-local-skill')return {output:await readFile(options.options.config.working_dir+'/.agents/skills/example/scripts/task.sh','utf8')};
  if(prompt==='list-local-skills')return {output:(await readdir(options.options.config.working_dir+'/.agents/skills')).sort().join(',')};
  if(prompt==='tamper-protected'){const file=options.options.config.working_dir+'/repo/input.txt';await chmod(file,0o644);await writeFile(file,'modified protected source');}
  if(prompt==='tamper-secondary'){const file=options.options.config.working_dir+'/secondary/input.txt';await chmod(file,0o644);await writeFile(file,'modified protected source');}
  if(prompt==='tamper-protected-metadata'){const file=options.options.config.working_dir+'/repo/.git/HEAD';await utimes(file,new Date(0),new Date(0));}
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
    for (const id of [
      "openai:codex-sdk",
      "anthropic:claude-agent-sdk",
      "copilot-sdk",
      "pi-sdk",
    ] as const) {
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
    for (const workingDir of [
      "",
      ".",
      "../outside",
      "repo/../outside",
      "/tmp/outside",
      "repo\\nested",
    ])
      expect(() =>
        validateProviderConfig({ delegate: { id: "openai:codex-sdk" }, workspace, workingDir }),
      ).toThrow(/config\.workingDir/);
  });
  test("keeps workspace preparation and agent call deadlines separate", () => {
    const config = validateProviderConfig({
      delegate: { id: "copilot-sdk" },
      workspace: { sources: [] },
      timeoutMs: 1_800_000,
      workspaceTimeoutMs: 3_600_000,
    });
    expect(config.timeoutMs).toBe(1_800_000);
    expect(config.workspaceTimeoutMs).toBe(3_600_000);
    for (const timeout of [0, -1, 3_600_001, "3600000"])
      expect(() => validateProviderConfig({ ...config, workspaceTimeoutMs: timeout })).toThrow(
        /config\.workspaceTimeoutMs/,
      );
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
  test("Pi requires a complete model selection but accepts partial prompt overrides", () => {
    const config = {
      provider: "openai",
      model: "gpt-4o-mini",
      baseUrl: "http://localhost:8080/v1",
    };
    expect(
      validateProviderConfig({
        delegate: { id: "pi-sdk", config },
        workspace: { sources: [] },
      }).delegate.config,
    ).toEqual(config);
    for (const partial of [
      {},
      { provider: "openai" },
      { model: "model" },
      { provider: " ", model: "model" },
    ])
      expect(() =>
        validateProviderConfig({
          delegate: { id: "pi-sdk", config: partial },
          workspace: { sources: [] },
        }),
      ).toThrow();
    expect(validateDelegateConfig("pi-sdk", { model: "replacement" })).toEqual({
      model: "replacement",
    });
    expect(
      promptConfig(
        { prompt: { config: { delegate: { config: { model: "replacement" } } } } },
        "pi-sdk",
        config,
      ),
    ).toEqual({ ...config, model: "replacement" });
  });
  test("Pi rejects dynamic SDK injection, unsafe endpoints and invalid permissions", () => {
    for (const key of [
      "cwd",
      "extensions",
      "resourceLoader",
      "tools",
      "sessionDir",
      "agentDir",
      "inheritEnv",
    ])
      expect(() => validateDelegateConfig("pi-sdk", { [key]: {} })).toThrow();
    for (const baseUrl of ["relative", "file:///tmp/model", "https://user:pass@example.test", ""])
      expect(() => validateDelegateConfig("pi-sdk", { baseUrl })).toThrow();
    for (const permissions of [{ filesystem: "all" }, { shell: "yes" }, { network: "allow" }])
      expect(() => validateDelegateConfig("pi-sdk", { permissions })).toThrow();
    expect(() => validateDelegateConfig("pi-sdk", { thinkingLevel: "max" })).toThrow();
    expect(
      validateDelegateConfig("pi-sdk", { permissions: { filesystem: "read", shell: "deny" } }),
    ).toEqual({ permissions: { filesystem: "read", shell: "deny" } });
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
        {
          prompt: {
            config: {
              provider: "openai:grader-model",
              delegate: { config: { model: "override" } },
            },
          },
        },
        "openai:codex-sdk",
        { model: "base", sandbox_mode: "workspace-write" },
      ),
    ).toEqual({ model: "override", sandbox_mode: "workspace-write" });
  });
  test("ignores live grading metadata without inspecting or mutating it", () => {
    const unexpected = () => {
      throw new Error("grader methods must not run during generation validation");
    };
    const grader = {
      id: unexpected,
      callApi: unexpected,
      toJSON: unexpected,
      self: null as unknown,
    };
    grader.self = grader;
    Object.freeze(grader);
    const original = Object.freeze({ model: "base" });
    const config = Object.freeze({ provider: grader });
    const context = Object.freeze({
      prompt: Object.freeze({ config }),
      test: Object.freeze({ options: Object.freeze({ provider: grader }) }),
    });
    expect(promptConfig(context, "openai:codex-sdk", original)).toBe(original);
    expect(context.prompt.config).toBe(config);
    expect(context.prompt.config.provider).toBe(grader);
    expect(context.test.options.provider).toBe(grader);
    expect(grader.self).toBe(grader);
  });
  test("grading metadata does not admit unsupported generation overrides", () => {
    for (const override of [
      { model: "unsupported-root-model" },
      { workspace: { sources: [] } },
      { permissions: {} },
      { env: {} },
      { delegate: { id: "copilot-sdk" } },
      { delegate: { permissions: {} } },
      { delegate: { env: {} } },
      { delegate: { config: { env: {} } } },
    ])
      expect(() =>
        promptConfig(
          {
            prompt: {
              config: {
                provider: "openai:grader-model",
                rubricPrompt: "Candidate: {{output}} Criterion: {{rubric}}",
                ...override,
              },
            },
          },
          "openai:codex-sdk",
          {},
        ),
      ).toThrow();
    expect(() =>
      promptConfig(
        {
          prompt: {
            config: {
              provider: "openai:grader-model",
              delegate: { config: { timeoutMs: 1000 } },
            },
          },
        },
        "openai:codex-sdk",
        {},
      ),
    ).toThrow("prompt.config.delegate.config.timeoutMs is constructor-only");
  });
  test("resolves only relative source paths against the loader basePath", () => {
    const spec = resolveSourcePaths(
      {
        sources: [
          { type: "local", path: "../skills", destination: "a" },
          { type: "local", path: "/abs/skills", destination: "b" },
          { type: "git", repository: "file://../repo.git", ref: "main", destination: "c" },
          { type: "git", repository: "file:///abs/repo.git", ref: "main", destination: "d" },
          {
            type: "git",
            repository: "file://localhost/abs/repo.git",
            ref: "main",
            destination: "e",
          },
          {
            type: "git",
            repository: "file://LOCALHOST/abs/repo.git",
            ref: "main",
            destination: "g",
          },
          {
            type: "git",
            repository: "https://example.test/repo.git",
            ref: "main",
            destination: "f",
          },
        ],
      },
      "/suite/evals",
    );
    expect(spec.sources.map((s) => (s.type === "local" ? s.path : s.repository))).toEqual([
      "/suite/skills",
      "/abs/skills",
      "file:///suite/repo.git",
      "file:///abs/repo.git",
      "file://localhost/abs/repo.git",
      "file://LOCALHOST/abs/repo.git",
      "https://example.test/repo.git",
    ]);
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
    const events: Record<string, unknown>[] = [];
    const listener = (message: unknown) => {
      if (message && typeof message === "object" && "phase" in message)
        events.push(message as Record<string, unknown>);
    };
    const checkPhases: Record<string, true> = {
      "protected-git-check-start": true,
      "protected-git-check-finished": true,
      "protected-stamp-start": true,
      "protected-stamp-finished": true,
    };
    const checksFor = (caseIndex: number) =>
      events.filter((event) => event.caseIndex === caseIndex && checkPhases[String(event.phase)]);
    const checkedCaseIndex = (metadata: unknown): number => {
      if (
        !metadata ||
        typeof metadata !== "object" ||
        !("allagentsCaseIndex" in metadata) ||
        typeof metadata.allagentsCaseIndex !== "number" ||
        !Number.isSafeInteger(metadata.allagentsCaseIndex) ||
        metadata.allagentsCaseIndex < 1
      )
        throw new Error("Provider response missing progress case ordinal");
      return metadata.allagentsCaseIndex;
    };
    const successfulChecks = (caseIndex: number) => [
      { phase: "protected-git-check-start", caseIndex, sourceIndex: 1, sourceCount: 1 },
      {
        phase: "protected-git-check-finished",
        caseIndex,
        sourceIndex: 1,
        sourceCount: 1,
        outcome: "ok",
      },
      { phase: "protected-stamp-start", caseIndex, sourceIndex: 1, sourceCount: 1 },
      {
        phase: "protected-stamp-finished",
        caseIndex,
        sourceIndex: 1,
        sourceCount: 1,
        outcome: "ok",
      },
    ];
    subscribe("allagents.workspace.progress", listener);
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
      const reuse = await provider.callApi("clean-reuse");
      expect(reuse.error).toBeUndefined();
      const firstCase = checkedCaseIndex(first.metadata);
      const reuseCase = checkedCaseIndex(reuse.metadata);
      expect(reuseCase).not.toBe(firstCase);
      expect(
        events.filter((event) => event.caseIndex === firstCase).map((event) => event.phase),
      ).toEqual([
        "case-start",
        "workspace-ready",
        "agent-start",
        "agent-finished",
        ...successfulChecks(firstCase).map((event) => event.phase),
        "case-finished",
      ]);
      expect(checksFor(firstCase)).toEqual(successfulChecks(firstCase));
      expect(checksFor(reuseCase)).toEqual(successfulChecks(reuseCase));
      expect(await readdir(join(options.env.ALLAGENTS_CACHE_ROOT, "published"))).toEqual([]);
      const secondUrl = "https://invalid.example.test/secondary.git";
      const secondSource = {
        ...source,
        repository: secondUrl,
        destination: "secondary",
      };
      const secondKey = createHash("sha256")
        .update(JSON.stringify([secondUrl, commit, "secondary"]))
        .digest("hex");
      const secondRoot = join(prepared, "sources", secondKey);
      await mkdir(secondRoot, { recursive: true, mode: 0o700 });
      await git("git", [
        "clone",
        "-q",
        "--bare",
        "--no-hardlinks",
        repository,
        join(secondRoot, "mirror"),
      ]);
      await chmod(join(secondRoot, "mirror"), 0o700);
      await cp(repository, join(secondRoot, "seed"), { recursive: true });
      await chmod(join(secondRoot, "seed"), 0o700);
      await cp(repository, join(secondRoot, "protected"), { recursive: true });
      await protect(join(secondRoot, "protected"), false);
      await atomicJson(join(prepared, "manifest.json"), {
        schemaVersion: 1,
        sources: [
          { repository: repositoryUrl, commit, destination: "repo" },
          { repository: secondUrl, commit, destination: "secondary" },
        ],
      });
      const concurrent = new Provider({
        ...options,
        config: {
          ...options.config,
          workspace: { ...options.config.workspace, sources: [source, secondSource] },
        },
      });
      try {
        const pair = await concurrent.callApi("clean");
        expect(pair.error).toBeUndefined();
        const pairCase = checkedCaseIndex(pair.metadata);
        const pairChecks = checksFor(pairCase);
        const secondGitStart = pairChecks.findIndex(
          (event) => event.phase === "protected-git-check-start" && event.sourceIndex === 2,
        );
        const firstStampFinish = pairChecks.findIndex(
          (event) => event.phase === "protected-stamp-finished" && event.sourceIndex === 1,
        );
        expect(secondGitStart).toBeGreaterThanOrEqual(0);
        expect(firstStampFinish).toBeGreaterThanOrEqual(0);
        expect(secondGitStart).toBeLessThan(firstStampFinish);
        const altered = await concurrent.callApi("tamper-secondary");
        expect(altered.error).toContain("Prepared source checkout failed integrity verification");
        const alteredCase = checkedCaseIndex(altered.metadata);
        const alteredChecks = checksFor(alteredCase);
        expect(alteredChecks).toContainEqual({
          phase: "protected-stamp-finished",
          caseIndex: alteredCase,
          sourceIndex: 1,
          sourceCount: 2,
          outcome: "ok",
        });
        expect(alteredChecks).toContainEqual({
          phase: "protected-git-check-finished",
          caseIndex: alteredCase,
          sourceIndex: 2,
          sourceCount: 2,
          outcome: "error",
        });
      } finally {
        await concurrent.cleanup();
        await atomicJson(join(prepared, "manifest.json"), {
          schemaVersion: 1,
          sources: [{ repository: repositoryUrl, commit, destination: "repo" }],
        });
      }
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
      const delegateError = await provider.callApi("error");
      expect(delegateError.error).toBe("native failure");
      const errorCase = checkedCaseIndex(delegateError.metadata);
      expect(checksFor(errorCase)).toEqual(successfulChecks(errorCase));
      const metadataPrepared = join(path, "prepared-metadata");
      await cp(prepared, metadataPrepared, { recursive: true });
      await chmod(metadataPrepared, 0o700);
      const tamper = await provider.callApi("tamper-protected");
      expect(tamper.error).toContain("Prepared source checkout failed integrity verification");
      const tamperCase = checkedCaseIndex(tamper.metadata);
      expect(checksFor(tamperCase)).toEqual([
        {
          phase: "protected-git-check-start",
          caseIndex: tamperCase,
          sourceIndex: 1,
          sourceCount: 1,
        },
        {
          phase: "protected-git-check-finished",
          caseIndex: tamperCase,
          sourceIndex: 1,
          sourceCount: 1,
          outcome: "error",
        },
      ]);
      expect(events.filter((event) => event.caseIndex === tamperCase).at(-1)).toEqual({
        phase: "case-finished",
        caseIndex: tamperCase,
        outcome: "error",
      });
      const metadataProvider = new Provider({
        ...options,
        env: { ...options.env, ALLAGENTS_PREBUILT_ROOT: metadataPrepared },
      });
      try {
        const metadataTamper = await metadataProvider.callApi("tamper-protected-metadata");
        expect(metadataTamper.error).toContain(
          "Prepared source checkout failed integrity verification",
        );
        const metadataCase = checkedCaseIndex(metadataTamper.metadata);
        expect(checksFor(metadataCase)).toEqual([
          {
            phase: "protected-git-check-start",
            caseIndex: metadataCase,
            sourceIndex: 1,
            sourceCount: 1,
          },
          {
            phase: "protected-git-check-finished",
            caseIndex: metadataCase,
            sourceIndex: 1,
            sourceCount: 1,
            outcome: "ok",
          },
          {
            phase: "protected-stamp-start",
            caseIndex: metadataCase,
            sourceIndex: 1,
            sourceCount: 1,
          },
          {
            phase: "protected-stamp-finished",
            caseIndex: metadataCase,
            sourceIndex: 1,
            sourceCount: 1,
            outcome: "error",
          },
        ]);
        expect((await metadataProvider.callApi("clean")).error).toContain("invalidated");
      } finally {
        await metadataProvider.cleanup();
      }
      const diagnostics = JSON.stringify(events);
      for (const forbidden of [
        path,
        repositoryUrl,
        commit,
        "tamper-protected",
        "tamper-protected-metadata",
        "native failure",
      ])
        expect(diagnostics).not.toContain(forbidden);
      for (const event of events)
        expect(
          Object.keys(event).every((key) =>
            ["phase", "caseIndex", "sourceIndex", "sourceCount", "outcome"].includes(key),
          ),
        ).toBe(true);
      expect((await provider.callApi("write")).error).toContain("invalidated");
      expect(await readFile(join(protectedPath, "input.txt"), "utf8")).toBe(
        "modified protected source",
      );
    } finally {
      unsubscribe("allagents.workspace.progress", listener);
      await provider.cleanup();
    }
    expect(await readFile(join(protectedPath, "input.txt"), "utf8")).toBe(
      "modified protected source",
    );
  }, 30_000);
  async function workspaceProvider(fileChanges = false, readOnly = false, workingDir?: string) {
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
        ...(workingDir ? { workingDir } : {}),
      },
      env: {
        ALLAGENTS_CACHE_ROOT: join(path, "cache"),
        ALLAGENTS_WORKSPACE_ROOT: join(path, "runtime"),
      },
    });
    return { path, provider };
  }
  test("starts the agent in a materialized repository when workingDir is set", async () => {
    for (const readOnly of [false, true]) {
      const { provider } = await workspaceProvider(false, readOnly, "repo");
      try {
        const grader = "openai:grader-model";
        const rubricPrompt = "Candidate: {{output}} Criterion: {{rubric}}";
        const context = {
          prompt: {
            config: { provider: grader, rubricPrompt, delegate: { config: { model: "override" } } },
          },
          test: { options: { provider: grader, rubricPrompt } },
        };
        const result = await provider.callApi(readOnly ? "success" : "write", context);
        expect(result.error).toBeUndefined();
        expect(context.prompt.config.provider).toBe(grader);
        expect(context.test.options.provider).toBe(grader);
        expect(context.prompt.config.rubricPrompt).toBe(rubricPrompt);
        expect(context.test.options.rubricPrompt).toBe(rubricPrompt);
        expect((result.metadata as any).options.options.config.model).toBe("override");
        const root = (result.metadata as any).workspace.path as string;
        expect((result.metadata as any).options.options.config.working_dir).toBe(
          join(root, "repo"),
        );
        expect(await readFile(join(root, "repo", "input.txt"), "utf8")).toBe("immutable source");
        if (!readOnly) {
          expect(await readFile(join(root, "repo", "generated.txt"), "utf8")).toBe(
            "generated durable content",
          );
          await expect(access(join(root, "generated.txt"))).rejects.toThrow();
        }
      } finally {
        await provider.cleanup();
      }
    }
  }, 30_000);
  test("rejects a configured working directory that was not materialized", async () => {
    const { provider } = await workspaceProvider(false, false, "missing");
    try {
      const result = await provider.callApi("success");
      expect(result.error).toContain("config.workingDir");
      expect(result.metadata).toBeUndefined();
    } finally {
      await provider.cleanup();
    }
  }, 15_000);
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
  const onLinux = process.platform === "linux" ? test : test.skip;
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
  onLinux(
    "reports a host-local skill baseline from actual provider calls without modifying host bytes",
    async () => {
      const root = await project("promptfoo", native);
      const source = join(root, "inputs", "skills");
      const skill = join(source, "example");
      await mkdir(join(skill, "scripts"), { recursive: true });
      await writeFile(join(skill, "SKILL.md"), "# Example\n");
      await writeFile(join(skill, "scripts", "task.sh"), "echo baseline\n", { mode: 0o755 });
      await chmod(join(skill, "scripts", "task.sh"), 0o755);
      const options = {
        config: {
          basePath: root,
          delegate: { id: "openai:codex-sdk" as const },
          workspace: {
            sources: [
              {
                type: "local" as const,
                path: source,
                destination: ".agents/skills",
                permissions: "all" as const,
              },
            ],
          },
          fileChanges: true,
        },
        env: {
          ALLAGENTS_LOCAL_SOURCE_ROOT: join(root, "inputs"),
          ALLAGENTS_CACHE_ROOT: join(root, "cache"),
          ALLAGENTS_WORKSPACE_ROOT: join(root, "runtime"),
        },
      };
      const provider = new Provider(options);
      try {
        const [first, parallel] = await Promise.all([
          provider.callApi("read-local-skill"),
          provider.callApi("read-local-skill"),
        ]);
        expect(first.error).toBeUndefined();
        expect(first.output).toBe("echo baseline\n");
        expect(parallel.output).toBe("echo baseline\n");
        const metadata = first.metadata as { workspace: WorkspaceMetadata };
        const sourceMetadata = metadata.workspace.sources[0];
        expect(sourceMetadata?.type).toBe("local");
        if (!sourceMetadata || sourceMetadata.type !== "local")
          throw new Error("Expected local source metadata");
        expect(sourceMetadata.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(metadata.workspace.manifestDigest).toBe(
          (parallel.metadata as { workspace: WorkspaceMetadata }).workspace.manifestDigest,
        );
        const edit = await provider.callApi("edit-local-skill");
        expect(edit.error).toBeUndefined();
        expect((edit.metadata as { workspace: WorkspaceMetadata }).workspace.sources[0]).toEqual(
          sourceMetadata,
        );
        expect(await readFile(join(skill, "scripts", "task.sh"), "utf8")).toBe("echo baseline\n");
        expect(
          await readFile(
            join(
              (edit.metadata as { workspace: WorkspaceMetadata }).workspace.path,
              ".agents",
              "skills",
              "example",
              "scripts",
              "task.sh",
            ),
            "utf8",
          ),
        ).toBe("echo agent\n");
        await writeFile(join(skill, "scripts", "task.sh"), "echo host update\n");
        const same = await provider.callApi("read-local-skill");
        expect(same.output).toBe("echo baseline\n");
        expect((same.metadata as { workspace: WorkspaceMetadata }).workspace.sources[0]).toEqual(
          sourceMetadata,
        );
        const fresh = new Provider(options);
        try {
          const updated = await fresh.callApi("read-local-skill");
          expect(updated.error).toBeUndefined();
          expect(updated.output).toBe("echo host update\n");
          const next = (updated.metadata as { workspace: WorkspaceMetadata }).workspace;
          const nextSource = next.sources[0];
          if (!nextSource || nextSource.type !== "local") throw new Error("Expected local source");
          expect(nextSource.digest).not.toBe(sourceMetadata.digest);
          expect(next.manifestDigest).not.toBe(metadata.workspace.manifestDigest);
        } finally {
          await fresh.cleanup();
        }
      } finally {
        await provider.cleanup();
      }
    },
    45_000,
  );
  onLinux(
    "merged local sources let the agent discover every staged plugin's skills",
    async () => {
      const root = await project("promptfoo", native);
      const plugins = ["alpha", "beta", "gamma", "delta"];
      for (const name of plugins) {
        await mkdir(join(root, "inputs", name, `${name}-skill`), { recursive: true });
        await writeFile(
          join(root, "inputs", name, `${name}-skill`, "SKILL.md"),
          `# ${name} skill\n`,
        );
      }
      const provider = new Provider({
        config: {
          basePath: root,
          delegate: { id: "openai:codex-sdk" as const },
          workspace: {
            sources: plugins.map((name) => ({
              type: "local" as const,
              path: join(root, "inputs", name),
              destination: ".agents/skills",
              permissions: "all" as const,
            })),
          },
        },
        env: {
          ALLAGENTS_LOCAL_SOURCE_ROOT: join(root, "inputs"),
          ALLAGENTS_CACHE_ROOT: join(root, "cache"),
          ALLAGENTS_WORKSPACE_ROOT: join(root, "runtime"),
        },
      });
      try {
        const result = await provider.callApi("list-local-skills");
        expect(result.error).toBeUndefined();
        expect(result.output).toBe(
          plugins
            .map((name) => `${name}-skill`)
            .sort()
            .join(","),
        );
        const metadata = result.metadata as { workspace: WorkspaceMetadata };
        expect(metadata.workspace.sources).toHaveLength(plugins.length);
      } finally {
        await provider.cleanup();
      }
    },
    45_000,
  );
  // An eval config in `repo/evals`, a plugin elsewhere in that repository, and a sibling
  // directory outside it. The consumer project (`root`) is not itself a Git repository.
  async function configRepository() {
    const root = await project("promptfoo", native);
    const repo = join(root, "repo");
    const evals = join(repo, "evals");
    const skills = join(repo, "plugins", "demo", "skills");
    await mkdir(evals, { recursive: true });
    await promisify(execFile)("git", ["init", "-q", repo]);
    for (const [dir, body] of [
      [skills, "echo plugin\n"],
      [join(root, "outside"), "echo outside\n"],
      [join(repo, "other"), "echo other\n"],
    ]) {
      await mkdir(join(dir, "example", "scripts"), { recursive: true });
      await writeFile(join(dir, "example", "scripts", "task.sh"), body);
    }
    return { root, repo, evals, skills };
  }
  async function readLocal(
    root: string,
    basePath: string,
    path: string,
    localRoot?: string,
  ): Promise<{ output?: unknown; error?: unknown; metadata?: unknown }> {
    const provider = new Provider({
      config: {
        basePath,
        delegate: { id: "openai:codex-sdk" as const },
        workspace: { sources: [{ type: "local", path, destination: ".agents/skills" }] },
      },
      env: {
        ...(localRoot ? { ALLAGENTS_LOCAL_SOURCE_ROOT: localRoot } : {}),
        ALLAGENTS_CACHE_ROOT: join(root, "cache"),
        ALLAGENTS_WORKSPACE_ROOT: join(root, "runtime"),
      },
    });
    try {
      return await provider.callApi("read-local-skill");
    } finally {
      await provider.cleanup();
    }
  }
  async function withoutLocalRootVariable<T>(run: () => Promise<T>): Promise<T> {
    const inherited = process.env.ALLAGENTS_LOCAL_SOURCE_ROOT;
    delete process.env.ALLAGENTS_LOCAL_SOURCE_ROOT;
    try {
      return await run();
    } finally {
      if (inherited !== undefined) process.env.ALLAGENTS_LOCAL_SOURCE_ROOT = inherited;
    }
  }
  onLinux(
    "relative local paths resolve against the loader basePath, not the process cwd",
    () =>
      withoutLocalRootVariable(async () => {
        const { root, evals, skills } = await configRepository();
        // Promptfoo 0.124 passes an absolute basePath; 0.122 passes it relative to the cwd.
        for (const basePath of [evals, relative(process.cwd(), evals)]) {
          const result = await readLocal(root, basePath, "../plugins/demo/skills");
          expect(result.error).toBeUndefined();
          expect(result.output).toBe("echo plugin\n");
          const source = (result.metadata as { workspace: WorkspaceMetadata }).workspace.sources[0];
          expect(source?.type === "local" && source.path).toBe(skills);
        }
      }),
    45_000,
  );
  onLinux(
    "without ALLAGENTS_LOCAL_SOURCE_ROOT, local sources stay inside the config's Git repository",
    () =>
      withoutLocalRootVariable(async () => {
        const { root, repo, evals } = await configRepository();
        for (const outside of [
          "../../outside",
          "../plugins/../../outside",
          join(root, "outside"),
        ]) {
          const result = await readLocal(root, evals, outside);
          expect(result.output).toBeUndefined();
          expect(String(result.error)).toContain(
            `Local source must stay inside trusted source root ${JSON.stringify(repo)}`,
          );
        }
        // Outside any repository, the boundary is the config directory itself.
        const loose = join(root, "outside", "evals");
        await mkdir(loose);
        expect((await readLocal(root, loose, "..")).error).toContain(JSON.stringify(loose));
        await mkdir(join(loose, "skills", "example", "scripts"), { recursive: true });
        await writeFile(join(loose, "skills", "example", "scripts", "task.sh"), "echo loose\n");
        expect((await readLocal(root, loose, "skills")).output).toBe("echo loose\n");
      }),
    45_000,
  );
  onLinux(
    "ALLAGENTS_LOCAL_SOURCE_ROOT replaces the repository boundary",
    async () => {
      const { root, repo, evals } = await configRepository();
      const narrowed = join(repo, "plugins");
      const escaped = await readLocal(root, evals, "../other", narrowed);
      expect(escaped.output).toBeUndefined();
      expect(String(escaped.error)).toContain(
        `Local source must stay inside trusted source root ${JSON.stringify(narrowed)}`,
      );
      expect((await readLocal(root, evals, "../plugins/demo/skills", narrowed)).output).toBe(
        "echo plugin\n",
      );
      expect((await readLocal(root, evals, "../../outside", root)).output).toBe("echo outside\n");
      expect((await readLocal(root, evals, "../other", "relative/root")).error).toContain(
        "absolute ALLAGENTS_LOCAL_SOURCE_ROOT",
      );
    },
    45_000,
  );
  test("relative file:// Git repositories resolve against the loader basePath", async () => {
    const root = await project("promptfoo", native);
    const evals = join(root, "evals");
    const repository = join(root, "vendor", "source");
    await mkdir(evals);
    await mkdir(repository, { recursive: true });
    await writeFile(join(repository, "input.txt"), "relative source");
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
        basePath: evals,
        delegate: { id: "openai:codex-sdk" },
        workspace: {
          sources: [
            {
              type: "git",
              repository: "file://../vendor/source",
              ref: "HEAD",
              destination: "repo",
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
      const result = await provider.callApi("success");
      expect(result.error).toBeUndefined();
      const workspace = (result.metadata as { workspace: WorkspaceMetadata }).workspace;
      expect(workspace.sources[0]).toMatchObject({
        repository: pathToFileURL(repository).href,
        commit: stdout.trim(),
      });
      expect(await readFile(join(workspace.path, "repo", "input.txt"), "utf8")).toBe(
        "relative source",
      );
    } finally {
      await provider.cleanup();
    }
  }, 30_000);
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
  async function accountingProvider(timeoutMs = 5000, model = "fixture-requested") {
    const fixture = await readFile(new URL("./fixtures/copilot-sdk.mjs", import.meta.url), "utf8");
    const path = await project("@github/copilot-sdk", fixture);
    return {
      path,
      provider: new CopilotSdkProvider({
        config: { basePath: path, working_dir: ".", model, timeoutMs },
      }),
    };
  }
  const accountingPrompt = (scenario: Record<string, unknown>) =>
    `accounting:${JSON.stringify(scenario)}`;
  test("session creation failure retains unavailable accounting and stops its client", async () => {
    const { path, provider } = await accountingProvider(5000, "fixture-create-error");
    try {
      const response = await provider.callApi("not sent");
      expect(response.error).toContain("session creation failed");
      expect(response.cost).toBeUndefined();
      expect((response.metadata as any).copilot.accounting).toMatchObject({
        status: "unavailable",
        reason: "session_not_created",
      });
      expect((response.metadata as any).copilot.accounting.totalNanoAiu).toBeUndefined();
      expect(await readFile(join(path, "accounting-stopped"), "utf8")).toBe("stopped");
    } finally {
      await provider.cleanup();
    }
  });
  test("session accounting uses only the final nano-AIU total and keeps multipliers separate", async () => {
    const { provider } = await accountingProvider();
    try {
      const response = await provider.callApi(accountingPrompt({ metrics: "complete" }));
      expect(response.error).toBeUndefined();
      expect(response.output).toBe("accounting fixture output");
      expect(response.cost).toBe(0.025);
      const copilot = (response.metadata as any).copilot;
      expect(copilot.accounting).toEqual({
        version: 1,
        source: "session.rpc.usage.getMetrics",
        scope: "session",
        unit: "nano-AIU",
        status: "complete",
        totalNanoAiu: 2_500_000_000,
        requestedModel: "fixture-requested",
        currentModel: "fixture-current",
        totalPremiumRequestCost: 1.5,
        totalUserRequests: 2,
      });
      expect(copilot.premiumRequestUsage).toEqual({
        source: "assistant.usage",
        scope: "received-events",
        reportedCost: 0.75,
        numRequests: 2,
      });
      expect(JSON.stringify(copilot)).not.toContain("must not escape");
    } finally {
      await provider.cleanup();
    }
  });
  for (const [metrics, reason] of [
    ["zero", undefined],
    ["missing", "missing_total"],
    ["invalid", "invalid_total"],
    ["unsafe", "invalid_total"],
    ["fractional", "invalid_total"],
    ["negative", "invalid_total"],
    ["nan", "invalid_total"],
    ["infinity", "invalid_total"],
    ["unsupported", "unsupported"],
    ["throw", "capture_failed"],
  ] as const) {
    test(`session accounting preserves ${metrics} metrics without inventing cost`, async () => {
      const { provider } = await accountingProvider();
      try {
        const response = await provider.callApi(accountingPrompt({ metrics }));
        expect(response.error).toBeUndefined();
        expect(response.output).toBe("accounting fixture output");
        const accounting = (response.metadata as any).copilot.accounting;
        expect(accounting.status).toBe(metrics === "zero" ? "complete" : "unavailable");
        expect(accounting.reason).toBe(reason);
        expect(accounting.totalNanoAiu).toBe(metrics === "zero" ? 0 : undefined);
        expect(response.cost).toBe(metrics === "zero" ? 0 : undefined);
      } finally {
        await provider.cleanup();
      }
    });
  }
  for (const timeoutMs of [200, 5000]) {
    test(`hung optional metrics preserve success within the ${timeoutMs}ms deadline and one-second cap`, async () => {
      const { provider } = await accountingProvider(timeoutMs);
      try {
        const started = Date.now();
        const response = await provider.callApi(accountingPrompt({ metrics: "hang" }));
        expect(Date.now() - started).toBeLessThan(timeoutMs === 200 ? 1500 : 3000);
        expect(response.error).toBeUndefined();
        expect(response.output).toBe("accounting fixture output");
        expect(response.cost).toBeUndefined();
        expect((response.metadata as any).copilot.accounting).toMatchObject({
          status: "unavailable",
          reason: "timeout",
        });
      } finally {
        await provider.cleanup();
      }
    });
  }
  test("execution errors retain a partial session snapshot without generic cost", async () => {
    const { provider } = await accountingProvider();
    try {
      const response = await provider.callApi(
        accountingPrompt({ metrics: "complete", executionError: true }),
      );
      expect(response.error).toContain("fixture execution failed");
      expect(response.cost).toBeUndefined();
      expect((response.metadata as any).copilot.accounting).toMatchObject({
        status: "partial",
        reason: "execution_incomplete",
        totalNanoAiu: 2_500_000_000,
      });
    } finally {
      await provider.cleanup();
    }
  });
  for (const mode of ["direct", "workspace"] as const) {
    test(`empty-message execution failures retain nonempty errors and partial accounting in ${mode} Copilot calls`, async () => {
      const fixture = await readFile(
        new URL("./fixtures/copilot-sdk.mjs", import.meta.url),
        "utf8",
      );
      const path = await project("@github/copilot-sdk", fixture);
      const provider =
        mode === "direct"
          ? new CopilotSdkProvider({
              config: {
                basePath: path,
                working_dir: ".",
                model: "fixture-requested",
                timeoutMs: 5000,
              },
            })
          : new Provider({
              config: {
                basePath: path,
                delegate: { id: "copilot-sdk", config: { model: "fixture-requested" } },
                workspace: { sources: [] },
                timeoutMs: 5000,
              },
              env: {
                ALLAGENTS_CACHE_ROOT: join(path, "cache"),
                ALLAGENTS_WORKSPACE_ROOT: join(path, "runtime"),
              },
            });
      const passingVerdict = JSON.stringify({
        components: [{ metric: "accuracy", pass: true, score: 1, reason: "Verified" }],
      });
      try {
        const response = await provider.callApi(
          accountingPrompt({
            metrics: "complete",
            executionError: "empty",
            output: passingVerdict,
          }),
        );
        expect(response.output).toBe(passingVerdict);
        expect(typeof response.error === "string" && response.error.trim().length > 0).toBe(true);
        expect(response.cost).toBeUndefined();
        expect((response.metadata as any).copilot.accounting).toMatchObject({
          status: "partial",
          reason: "execution_incomplete",
          totalNanoAiu: 2_500_000_000,
        });
        expect(response.tokenUsage).toMatchObject({
          prompt: 6,
          completion: 4,
          total: 10,
          numRequests: 2,
        });
      } finally {
        await provider.cleanup();
      }
    }, 15_000);
  }
  test("cancellation retains settled Copilot accounting through the delegate protocol", async () => {
    const { path, provider } = await accountingProvider();
    const controller = new AbortController();
    try {
      const pending = provider.callApi(
        accountingPrompt({ metrics: "complete", waitForAbort: true }),
        undefined,
        { abortSignal: controller.signal },
      );
      const deadline = Date.now() + 3000;
      while (true) {
        try {
          await access(join(path, "accounting-started"));
          break;
        } catch {
          if (Date.now() >= deadline) throw new Error("Fixture did not start");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      controller.abort();
      const response = await pending;
      expect(response.error).toContain("aborted");
      expect(response.cost).toBeUndefined();
      expect((response.metadata as any).copilot.accounting).toMatchObject({
        status: "partial",
        reason: "execution_incomplete",
        totalNanoAiu: 2_500_000_000,
      });
    } finally {
      await provider.cleanup();
    }
  });
  test("cleanup failure retains a partial snapshot without generic cost", async () => {
    const { provider } = await accountingProvider();
    try {
      const response = await provider.callApi(
        accountingPrompt({ metrics: "complete", cleanupError: true }),
      );
      expect((response.metadata as any).copilot.accounting).toMatchObject({
        status: "partial",
        totalNanoAiu: 2_500_000_000,
      });
      expect(response.error).toContain("cleanup failed");
      expect(response.cost).toBeUndefined();
    } finally {
      await provider.cleanup();
    }
  });
  test("default fixture multiplier events are not generic money without metrics", async () => {
    const { provider } = await accountingProvider();
    try {
      const response = await provider.callApi("ordinary fixture request");
      expect(response.error).toBeUndefined();
      expect(response.cost).toBeUndefined();
      expect((response.metadata as any).copilot.accounting).toMatchObject({
        status: "unavailable",
        reason: "unsupported",
      });
      expect((response.metadata as any).copilot.premiumRequestUsage.reportedCost).toBe(0.001);
    } finally {
      await provider.cleanup();
    }
  });
  test("missing multiplier events do not imply measured premium-request usage", async () => {
    const { provider } = await accountingProvider();
    try {
      for (const eventCosts of [[], [0.25, null], [-1], [Number.MAX_SAFE_INTEGER, 1]]) {
        const response = await provider.callApi(
          accountingPrompt({ metrics: "complete", eventCosts }),
        );
        expect(response.error).toBeUndefined();
        expect(response.cost).toBe(0.025);
        const premium = (response.metadata as any).copilot.premiumRequestUsage;
        expect(premium.numRequests).toBe(eventCosts.length);
        expect(premium.reportedCost).toBeUndefined();
      }
    } finally {
      await provider.cleanup();
    }
  });
  test("workspace Provider serializes session accounting through the Copilot delegate", async () => {
    const fixture = await readFile(new URL("./fixtures/copilot-sdk.mjs", import.meta.url), "utf8");
    const path = await project("@github/copilot-sdk", fixture);
    const provider = new Provider({
      config: {
        basePath: path,
        delegate: { id: "copilot-sdk", config: { model: "fixture-requested" } },
        workspace: { sources: [] },
        timeoutMs: 5000,
      },
      env: {
        ALLAGENTS_CACHE_ROOT: join(path, "cache"),
        ALLAGENTS_WORKSPACE_ROOT: join(path, "runtime"),
      },
    });
    try {
      const response = await provider.callApi(accountingPrompt({ metrics: "complete" }));
      expect(response.error).toBeUndefined();
      expect(response.output).toBe("accounting fixture output");
      expect(response.cost).toBe(0.025);
      const metadata = JSON.parse(JSON.stringify(response.metadata));
      expect(metadata.copilot.accounting).toMatchObject({
        version: 1,
        status: "complete",
        totalNanoAiu: 2_500_000_000,
        requestedModel: "fixture-requested",
      });
      expect(metadata.copilot.premiumRequestUsage.reportedCost).toBe(0.75);
      expect(typeof metadata.workspace.path).toBe("string");
    } finally {
      await provider.cleanup();
    }
  }, 15_000);
  if (process.platform !== "win32")
    test("workspace integrity failure retains captured Copilot accounting without money", async () => {
      const fixture = await readFile(
        new URL("./fixtures/copilot-sdk.mjs", import.meta.url),
        "utf8",
      );
      const path = await project("@github/copilot-sdk", fixture);
      const repository = join(path, "source");
      await mkdir(repository);
      await writeFile(join(repository, "input.txt"), "immutable source");
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
          timeoutMs: 5000,
          workspace: {
            viewMode: "copy-only",
            sources: [
              {
                type: "git",
                repository: pathToFileURL(repository).href,
                ref: stdout.trim(),
                destination: "repo",
                permissions: "read-only",
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
        const response = await provider.callApi(
          accountingPrompt({ metrics: "complete", mutateProtected: true }),
        );
        expect(response.error).toMatch(/Protected source checkout mutated/);
        expect(response.output).toBeUndefined();
        expect(response.cost).toBeUndefined();
        expect((response.metadata as any).copilot.accounting).toMatchObject({
          status: "partial",
          totalNanoAiu: 2_500_000_000,
        });
      } finally {
        await provider.cleanup();
      }
    }, 15_000);
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
  test("workspace Provider records only SDK-loaded matching local skill content", async () => {
    const fixture = await readFile(new URL("./fixtures/copilot-sdk.mjs", import.meta.url), "utf8");
    const path = await project("@github/copilot-sdk", fixture);
    const repository = join(path, "source");
    const skill = ".agents/skills/cw-sql-schema-migration/SKILL.md";
    await mkdir(join(repository, ".agents", "skills", "cw-sql-schema-migration"), {
      recursive: true,
    });
    // Long enough that one masked phrase leaves over 90% of the body visible, so each
    // rejected variant below fails on its own rule rather than on visibility. The literal
    // ****** line must still align when another phrase is redacted.
    await writeFile(
      join(repository, skill),
      `# SQL migration\nSend Bearer authentication;\nKeep the column inventory.\nExample ****** stays literal.\n${"Inventory first. ".repeat(30)}\n${"Review each column before migrating.\n".repeat(80)}`,
    );
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
        workingDir: "repo",
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
      const response = await provider.callApi("auto-skill-review");
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
          source: "sdk-skill-loader",
        },
      ]);
      const dual = await provider.callApi("auto-skill-review:dual");
      expect(dual.error).toBeUndefined();
      const dualMetadata = dual.metadata as { skillCalls: unknown[]; workspace: { path: string } };
      const dualPath = join(dualMetadata.workspace.path, "repo", skill);
      expect(dualMetadata.skillCalls).toEqual([
        { name: "cw-sql-schema-migration", path: dualPath, source: "read-tool" },
        { name: "cw-sql-schema-migration", path: dualPath, source: "sdk-skill-loader" },
      ]);
      const mismatch = await provider.callApi("auto-skill-review:mismatch");
      expect(mismatch.error).toBeUndefined();
      expect((mismatch.metadata as { skillCalls: unknown[] }).skillCalls).toEqual([]);
      // The CLI returns secret-shaped prose as ******. Only a bounded single-line mask
      // with every visible character unchanged still proves the local skill loaded.
      for (const [variant, accepted] of [
        [":masked", true],
        [":masked-multiline", false],
        [":masked-altered", false],
        [":masked-most", false],
        [":masked-long-span", false],
        [":masked-too-many", false],
      ] as const) {
        const result = await provider.callApi(`auto-skill-review${variant}`);
        expect(result.error).toBeUndefined();
        const resultMetadata = result.metadata as {
          skillCalls: unknown[];
          workspace: { path: string };
        };
        expect(resultMetadata.skillCalls).toEqual(
          accepted
            ? [
                {
                  name: "cw-sql-schema-migration",
                  path: join(resultMetadata.workspace.path, "repo", skill),
                  source: "sdk-skill-loader",
                },
              ]
            : [],
        );
      }
    } finally {
      await provider.cleanup();
    }
    const protectedProvider = new Provider({
      config: {
        basePath: path,
        delegate: { id: "copilot-sdk" },
        workingDir: "repo",
        workspace: {
          viewMode: "copy-only",
          sources: [
            {
              type: "git",
              repository: pathToFileURL(repository).href,
              ref: stdout.trim(),
              destination: "repo",
              permissions: "read-only",
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
      const protectedResult = await protectedProvider.callApi("auto-skill-review");
      expect(protectedResult.error).toBeUndefined();
      const metadata = protectedResult.metadata as {
        skillCalls: unknown[];
        workspace: { path: string };
      };
      expect(lstatSync(join(metadata.workspace.path, "repo")).isSymbolicLink()).toBe(true);
      expect(metadata.skillCalls).toEqual([
        {
          name: "cw-sql-schema-migration",
          path: join(metadata.workspace.path, "repo", skill),
          source: "sdk-skill-loader",
        },
      ]);
    } finally {
      await protectedProvider.cleanup();
    }
  }, 15_000);
  test("missing SDK is actionable and pre-abort performs no execution", async () => {
    const path = await project("unrelated", "export {};");
    const provider = new CopilotSdkProvider({ config: { basePath: path, working_dir: "." } });
    const missing = await provider.callApi("test");
    expect(missing.error).toContain("@github/copilot-sdk");
    expect(missing.error).toContain(path);
    const controller = new AbortController();
    controller.abort();
    expect(
      (await provider.callApi("test", undefined, { abortSignal: controller.signal })).error,
    ).toContain("aborted");
  });
});
describe("native tracing relay", () => {
  for (const [telemetryPackage, minor, decoyPackage] of [
    ["@opentelemetry/api", "1.9.", "@opentelemetry/api-consumer"],
    ["@opentelemetry/api-consumer", "1.10.", "@opentelemetry/api"],
  ] as const) {
    test(`registers the actual Promptfoo API ${minor} peer and preserves native and relayed ancestry`, async () => {
      const completed: ReadableSpan[] = [];
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
        const path = await project(
          "promptfoo",
          `import {context,propagation,trace} from '@opentelemetry/api';
const tracer=trace.getTracer('fixture');
function identity(value){return value && {traceId:value.traceId,spanId:value.spanId,traceFlags:value.traceFlags,isRemote:value.isRemote===true,tracestate:value.traceState?.serialize()};}
function active(){return identity(trace.getSpan(context.active())?.spanContext());}
export async function loadApiProvider(){return {
 async callApi(){
  const spans={before:active()},carrier={};
  propagation.inject(context.active(),carrier);
  await tracer.startActiveSpan('native-parent',async parent=>{
   spans.parent=identity(parent.spanContext());spans.parentParent=identity(parent.parentSpanContext);
   await tracer.startActiveSpan('native-tool',{attributes:{'gen_ai.tool.name':'read_file','gen_ai.operation.name':'execute_tool','native.number':12}},async tool=>{
    spans.tool=identity(tool.spanContext());spans.toolParent=identity(tool.parentSpanContext);
    await new Promise(resolve=>setTimeout(resolve,25));
    spans.toolActive=active();
    tool.setAttribute('native.final','present');tool.end();
   });
   spans.afterTool=active();parent.end();
  });
  spans.restored=active();
  return {output:'traced',metadata:{native:{spans,carrier}}};
 },
 async cleanup(){const span=tracer.startSpan('native-cleanup');span.end();}
};}`,
          telemetryPackage,
        );
        // A different API at basePath catches resolution that skips the real peer.
        await installTelemetryPeer(path, decoyPackage);
        const peerRequire = createRequire(join(path, "node_modules", "promptfoo", "index.js"));
        const apiRoot = await telemetryPackageRoot(peerRequire.resolve("@opentelemetry/api"));
        const apiPackage = object(
          JSON.parse(await readFile(join(apiRoot, "package.json"), "utf8")),
          "consumer API package",
        );
        expect(apiPackage.name).toBe("@opentelemetry/api");
        expect(typeof apiPackage.version === "string" && apiPackage.version.startsWith(minor)).toBe(
          true,
        );
        const f = frame(path);
        const traceId = "0123456789abcdef0123456789abcdef";
        const rowId = "0123456789abcdef";
        f.context.traceparent = `00-${traceId}-${rowId}-01`;
        f.context.tracestate = "fixture=consumer";
        const response = await runDelegate(f, {}, 5000);
        expect(response.output).toBe("traced");
        const metadata = object(response.metadata, "response metadata");
        const native = object(metadata.native, "native trace metadata");
        const spans = object(native.spans, "native span identities");
        expect(native.carrier).toEqual({
          traceparent: f.context.traceparent,
          tracestate: f.context.tracestate,
        });
        expect(spans.before).toEqual(expect.objectContaining({ traceId, spanId: rowId }));
        expect(object(spans.parent, "native parent").traceId).toBe(traceId);
        expect(spans.parentParent).toEqual(
          expect.objectContaining({ traceId, spanId: rowId, isRemote: true }),
        );
        expect(object(spans.tool, "native tool").traceId).toBe(traceId);
        expect(spans.toolParent).toEqual(spans.parent);
        expect(spans.toolActive).toEqual(spans.tool);
        expect(spans.afterTool).toEqual(spans.parent);
        expect(spans.restored).toEqual(spans.before);
        expect(completed.map((span) => span.name).sort()).toEqual([
          "native-cleanup",
          "native-parent",
          "native-tool",
        ]);
        const parent = completed.find((span) => span.name === "native-parent");
        const tool = completed.find((span) => span.name === "native-tool");
        const cleanup = completed.find((span) => span.name === "native-cleanup");
        if (!parent || !tool || !cleanup)
          throw new Error("Native spans did not reach the row trace");
        expect(parent.spanContext().traceId).toBe(traceId);
        expect(parent.parentSpanContext?.spanId).toBe(rowId);
        expect(tool.spanContext().traceId).toBe(traceId);
        expect(tool.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
        expect(tool.attributes["gen_ai.tool.name"]).toBe("read_file");
        expect(tool.attributes["gen_ai.operation.name"]).toBe("execute_tool");
        expect(tool.attributes["native.number"]).toBe(12);
        expect(tool.attributes["native.final"]).toBe("present");
        expect(tool.duration[0] * 1000 + tool.duration[1] / 1e6).toBeGreaterThanOrEqual(20);
        expect(cleanup.spanContext().traceId).toBe(traceId);
        expect(cleanup.parentSpanContext?.spanId).toBe(rowId);
        expect(trace.getSpan(otelContext.active())).toBeUndefined();
      } finally {
        await tracerProvider.shutdown();
        trace.disable();
        propagation.disable();
        otelContext.disable();
      }
    });
  }
});

test("native peer resolution selects the evaluation project import condition", async () => {
  const { resolvePeer } = await import("../packages/oh-my-promptfoo/src/protocol.ts");
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
