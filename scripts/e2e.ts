import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeTree } from "../packages/workspace-core/src/fs";
import { WorkspaceManager } from "../packages/workspace-core/src/index";

const arguments_ = process.argv.slice(2);
const registryVersion = arguments_[0] === "--registry" ? arguments_[1] : undefined;
if (
  arguments_.length &&
  (arguments_.length !== 2 ||
    !registryVersion ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(registryVersion))
)
  throw new Error("Usage: e2e.ts [--registry VERSION]");
const repo = resolve(".");
const cwd = await mkdtemp(join(realpathSync(tmpdir()), "allagents-e2e-"));
const workspaceParent = await mkdtemp(join(realpathSync(tmpdir()), "allagents-e2e-workspaces-"));
function run(command: string, args: string[], dir = cwd, accepted = [0]) {
  const r = spawnSync(command, args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PROMPTFOO_DISABLE_TELEMETRY: "1",
      PROMPTFOO_DISABLE_UPDATE: "1",
      PROMPTFOO_CONFIG_DIR: join(cwd, "pf-state"),
      ALLAGENTS_CACHE_ROOT: join(workspaceParent, "cache"),
      ALLAGENTS_WORKSPACE_ROOT: join(workspaceParent, "runtime"),
    },
  });
  if (r.status === null || !accepted.includes(r.status))
    throw Error(`${command} failed (${r.status})\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}
try {
  const packed = JSON.parse(
    run(
      "npm",
      ["pack", "--json", "--pack-destination", cwd],
      join(repo, "packages/oh-my-promptfoo"),
    ),
  )[0];
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({ name: "built-e2e", type: "module", private: true }),
  );
  run("npm", [
    "install",
    "--legacy-peer-deps",
    "--no-audit",
    "--no-fund",
    registryVersion ? `@allagents/oh-my-promptfoo@${registryVersion}` : join(cwd, packed.filename),
    "promptfoo@0.122.0",
  ]);
  const installedManifest = JSON.parse(
    await readFile(join(cwd, "node_modules/@allagents/oh-my-promptfoo/package.json"), "utf8"),
  );
  if (registryVersion && installedManifest.version !== registryVersion)
    throw new Error("Registry package version mismatch");
  for (const [name, fixture, version] of [
    ["@openai/codex-sdk", "codex-sdk.mjs", "0.1.0"],
    ["@github/copilot-sdk", "copilot-sdk.mjs", "1.0.6"],
    ["@anthropic-ai/claude-agent-sdk", "claude-sdk.mjs", "0.1.0"],
  ]) {
    const dir = join(cwd, "node_modules", name);
    // Native SDK loaders also inspect dist files; replace the entire consumer fixture.
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name, version, type: "module", exports: "./index.js" }),
    );
    await copyFile(join(repo, "tests/fixtures", fixture), join(dir, "index.js"));
  }
  const source = join(cwd, "source");
  await mkdir(source);
  run("git", ["init", "--initial-branch=main", source]);
  await writeFile(join(source, "input.txt"), "immutable input\n");
  run("git", ["add", "."], source);
  run(
    "git",
    ["-c", "user.name=E2E", "-c", "user.email=e2e@example.invalid", "commit", "-m", "fixture"],
    source,
  );
  const commit = run("git", ["rev-parse", "HEAD"], source).trim();
  const wrapper = (id: string, label: string, permissions: string) => ({
    id: "package:@allagents/oh-my-promptfoo:Provider",
    label,
    config: {
      delegate: {
        id,
        config:
          id === "openai:codex-sdk"
            ? { model: "gpt-5.3-codex", enable_streaming: true, sandbox_mode: "workspace-write" }
            : id === "anthropic:claude-agent-sdk"
              ? { apiKeyRequired: false }
              : { permissions: { filesystem: "write", shell: "deny" } },
      },
      workspace: {
        sources: [
          {
            type: "git",
            repository: new URL(`file://${source}`).href,
            ref: commit,
            destination: "project",
            permissions,
          },
        ],
      },
      fileChanges: true,
    },
  });
  const config = {
    description: "Built package / real stock Promptfoo with deterministic SDK fixtures",
    tracing: { enabled: true },
    prompts: ["{{task}}"],
    providers: [
      wrapper("openai:codex-sdk", "readonly", "read-only"),
      wrapper("copilot-sdk", "writable", "all"),
      wrapper("anthropic:claude-agent-sdk", "claude", "all"),
    ],
    defaultTest: {
      providers: ["readonly"],
      assert: [
        { type: "contains", value: "ok" },
        { type: "regex", value: '"ok":true' },
        { type: "is-json" },
        {
          type: "llm-rubric",
          value: "The response reports ok and its workspace remains live during grading",
          provider: "file://grader.mjs",
        },
        {
          type: "javascript",
          value:
            "\nreturn import('node:fs').then(fs=>{ const m=context.providerResponse.metadata; const p=m.workspace.path; return m.workspace.cleanup==='best-effort-evaluation' && fs.readFileSync(p+'/result.txt','utf8')===context.vars.task && fs.readFileSync(p+'/project/input.txt','utf8')==='immutable input\\n' && m.fileChanges.status==='complete' && Buffer.from(m.fileChanges.generatedFiles['result.txt'].content,'base64').toString()===context.vars.task;});",
        },
        {
          type: "javascript",
          value:
            "\nreturn import('node:fs').then(fs=>new Promise(resolve=>setTimeout(()=>{ const p=context.providerResponse.metadata.workspace.path; fs.writeFileSync(p+'/assertion.txt','live');resolve(fs.existsSync(p+'/assertion.txt'));},50)));",
        },
      ],
    },
    tests: [
      {
        vars: { task: "readonly-row" },
        assert: [
          { type: "skill-used", value: "demo" },
          { type: "trajectory:tool-used", value: "probe" },
          {
            type: "trajectory:tool-args-match",
            value: { name: "probe", args: { target: "result.txt" } },
          },
          { type: "trajectory:tool-sequence", value: ["probe"] },
          { type: "trajectory:step-count", value: { min: 1, max: 20 } },
        ],
      },
      { providers: ["writable"], vars: { task: "writable-row" } },
      {
        providers: ["claude"],
        vars: { task: "claude-row" },
        assert: [{ type: "skill-used", value: "demo" }],
      },
    ],
  };
  await writeFile(
    join(cwd, "grader.mjs"),
    `import {readdir,readFile,access} from 'node:fs/promises';import {join} from 'node:path';export default class Grader { id(){return 'fixture-grader';} async callApi(){const root=process.env.ALLAGENTS_WORKSPACE_ROOT;let live=false;for(const id of await readdir(root)){if(id.startsWith('.'))continue;for(const file of await readdir(join(root,id,'records'))){const row=JSON.parse(await readFile(join(root,id,'records',file),'utf8'));try{await access(join(row.path,'result.txt'));live=true;}catch{}}}return {output:JSON.stringify({pass:live,score:live?1:0,reason:'Deterministic grading checked live published workspace'})};}}`,
  );
  await writeFile(join(cwd, "promptfooconfig.json"), JSON.stringify(config, null, 2));
  const output = run("node", [
    join(cwd, "node_modules/promptfoo/dist/src/entrypoint.js"),
    "eval",
    "--config",
    "promptfooconfig.json",
    "--no-cache",
    "--no-progress-bar",
    "--output",
    "results.json",
  ]);
  const results = JSON.parse(await readFile(join(cwd, "results.json"), "utf8"));
  const stats = results.results?.stats ?? results.stats;
  if (stats?.successes !== 3 || stats?.failures !== 0 || stats?.errors !== 0)
    throw Error(`Unexpected stats ${JSON.stringify(stats)}`);
  const rows = results.results?.results ?? results.results;
  const components = rows.flatMap((row: any) => row.gradingResult?.componentResults ?? []);
  const verifiedAssertions = [
    ...new Set(
      components
        .filter((c: any) => c.pass)
        .map((c: any) => c.assertion?.type)
        .filter(Boolean),
    ),
  ];
  for (const type of [
    "contains",
    "regex",
    "is-json",
    "javascript",
    "llm-rubric",
    "skill-used",
    "trajectory:tool-used",
    "trajectory:tool-args-match",
    "trajectory:tool-sequence",
    "trajectory:step-count",
  ])
    if (!verifiedAssertions.includes(type))
      throw Error(`Stock assertion missing from verified output: ${type}`);
  for (const row of rows) {
    const response = row.providerResponse ?? row.response;
    if (!response?.metadata?.workspace)
      throw Error(`Export row missing workspace: ${Object.keys(row).join(",")}`);
    const path = response.metadata.workspace.path;
    try {
      await import("node:fs/promises").then((fs) => fs.access(path));
      throw Error("Stock CLI skipped normal cleanup");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const cli = join(cwd, "node_modules/promptfoo/dist/src/entrypoint.js");
  async function evaluateFixture(name: string, suite: unknown, accepted = [0]) {
    await writeFile(join(cwd, `${name}.json`), JSON.stringify(suite));
    run(
      "node",
      [
        cli,
        "eval",
        "--config",
        `${name}.json`,
        "--no-cache",
        "--no-progress-bar",
        "--output",
        `${name}-results.json`,
      ],
      cwd,
      accepted,
    );
    const exported = JSON.parse(await readFile(join(cwd, `${name}-results.json`), "utf8"));
    return exported.results;
  }
  const unfiltered = await evaluateFixture("unfiltered", {
    ...config,
    defaultTest: { ...config.defaultTest, providers: undefined },
    tests: [{ vars: { task: "unfiltered-row" } }],
  });
  if (unfiltered.stats.successes !== 3 || unfiltered.results.length !== 3)
    throw Error("Missing provider filter did not run all labeled policies");
  const directDir = join(cwd, "existing");
  await mkdir(directDir);
  const direct = await evaluateFixture("direct", {
    prompts: ["direct-row"],
    providers: [
      {
        id: "package:@allagents/oh-my-promptfoo:CopilotSdkProvider",
        config: { working_dir: directDir },
      },
    ],
    tests: [
      {
        assert: [
          { type: "contains", value: "ok" },
          {
            type: "javascript",
            value: `\nreturn import('node:fs').then(fs=>fs.readFileSync(${JSON.stringify(join(directDir, "result.txt"))},'utf8')==='direct-row');`,
          },
        ],
      },
    ],
  });
  if (direct.stats.successes !== 1) throw Error("Direct Copilot named constructor failed");
  const nativeError = await evaluateFixture(
    "native-error",
    {
      prompts: ["native-error"],
      providers: [wrapper("anthropic:claude-agent-sdk", "error", "all")],
      tests: [
        {
          assert: [
            {
              type: "javascript",
              value: 'throw new Error("Native error assertions must be skipped");',
            },
          ],
        },
      ],
    },
    [1, 100],
  );
  const errorRow = nativeError.results[0];
  if (
    nativeError.stats.errors !== 1 ||
    !errorRow.response.error?.includes("error_max_turns") ||
    !errorRow.response.metadata.workspace ||
    (errorRow.gradingResult?.componentResults?.length ?? 0) !== 0
  )
    throw Error("Native error response or skipped assertion behavior changed");
  await writeFile(
    join(cwd, "abandoned.mjs"),
    `import {Provider} from '@allagents/oh-my-promptfoo';const provider=new Provider(${JSON.stringify({ config: wrapper("openai:codex-sdk", "abandoned", "all").config })});const response=await provider.callApi('abandoned');if(response.error)throw Error(response.error);console.log(response.metadata.workspace.path);`,
  );
  const abandoned = run("node", ["abandoned.mjs"]).trim();
  await import("node:fs/promises").then((fs) => fs.access(abandoned));
  await writeFile(
    join(cwd, "recover.mjs"),
    `import {Provider} from '@allagents/oh-my-promptfoo';const provider=new Provider(${JSON.stringify({ config: wrapper("openai:codex-sdk", "recovery", "all").config })});await provider.cleanup();`,
  );
  run("node", ["recover.mjs"]);
  try {
    await import("node:fs/promises").then((fs) => fs.access(abandoned));
    throw Error("Built Node recovery retained abandoned workspace");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(join(repo, "docs/evidence"), { recursive: true });
  await writeFile(
    join(repo, "docs/evidence/promptfoo-e2e.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        date: new Date().toISOString(),
        node: run("node", ["--version"]).trim(),
        promptfoo: "0.122.0",
        package: installedManifest.version,
        surface: registryVersion
          ? "registry-installed package loaded by stock promptfoo eval"
          : "npm-packed package loaded by stock promptfoo eval",
        sdkMode:
          "deterministic SDK fixtures; independently npm-installed Promptfoo, native Codex/Claude adapters and real integration runtime",
        stats,
        verifiedAssertions,
        additionalGates: {
          unfilteredRows: unfiltered.stats.successes,
          directCopilot: direct.stats.successes,
          nativeErrors: nativeError.stats.errors,
          normalCleanup: true,
          skippedCleanupRecovery: true,
          storageOutsideConsumer: true,
        },
        assertions: [
          "contains",
          "regex",
          "is-json",
          "filesystem JavaScript",
          "async workspace assertion",
          "exact durable file bytes",
          "labeled source policy selection",
          "llm-rubric with live workspace",
          "skill-used",
          "trajectory:tool-used",
          "trajectory:tool-args-match",
          "trajectory:tool-sequence",
          "trajectory:step-count",
        ],
        stdout: output
          .replaceAll(cwd, "<temporary-consumer>")
          .replaceAll(workspaceParent, "<temporary-workspace-storage>"),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Built Promptfoo E2E passed: ${JSON.stringify(stats)}`);
} finally {
  const recovery = new WorkspaceManager(
    { sources: [] },
    {
      ALLAGENTS_CACHE_ROOT: join(workspaceParent, "cache"),
      ALLAGENTS_WORKSPACE_ROOT: join(workspaceParent, "runtime"),
    },
  );
  await recovery.cleanup();
  await removeTree(cwd);
  await removeTree(workspaceParent);
}
