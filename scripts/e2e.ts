import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { removeTree } from "../packages/workspace-core/src/fs";
import { WorkspaceManager } from "../packages/workspace-core/src/index";
import { startPiModelServer, toolResults } from "../tests/fixtures/pi-model-server";

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
const promptfooVersion = "0.124.1";
const cwd = await mkdtemp(join(realpathSync(tmpdir()), "allagents-e2e-"));
const workspaceParent = await mkdtemp(join(realpathSync(tmpdir()), "allagents-e2e-workspaces-"));
// Local sources must work from the eval config alone, without a runner-supplied boundary.
const { ALLAGENTS_LOCAL_SOURCE_ROOT: _localSourceRoot, ...inherited } = process.env;
const testEnvironment = {
  ...inherited,
  PROMPTFOO_DISABLE_TELEMETRY: "1",
  PROMPTFOO_DISABLE_UPDATE: "1",
  PROMPTFOO_CONFIG_DIR: join(cwd, "pf-state"),
  ALLAGENTS_CACHE_ROOT: join(workspaceParent, "cache"),
  ALLAGENTS_WORKSPACE_ROOT: join(workspaceParent, "runtime"),
  ALLAGENTS_WORKSPACE_TIMEOUT_MS: "3600000",
  ALLAGENTS_LOCAL_SOURCE_ROOT: cwd,
};
function run(command: string, args: string[], dir = cwd, accepted = [0]) {
  const r = spawnSync(command, args, { cwd: dir, encoding: "utf8", env: testEnvironment });
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
    "--no-audit",
    "--no-fund",
    registryVersion ? `oh-my-promptfoo@${registryVersion}` : join(cwd, packed.filename),
    `promptfoo@${promptfooVersion}`,
    "@earendil-works/pi-coding-agent@1.3.0",
  ]);
  const installedManifest = JSON.parse(
    await readFile(join(cwd, "node_modules/oh-my-promptfoo/package.json"), "utf8"),
  );
  if (registryVersion && installedManifest.version !== registryVersion)
    throw new Error("Registry package version mismatch");
  const installedPromptfoo = JSON.parse(
    await readFile(join(cwd, "node_modules/promptfoo/package.json"), "utf8"),
  );
  if (installedPromptfoo.version !== promptfooVersion)
    throw new Error("Installed Promptfoo version mismatch");
  for (const [name, fixture, version] of [
    ["@openai/codex-sdk", "codex-sdk.mjs", "0.1.0"],
    ["@github/copilot-sdk", "copilot-sdk.mjs", "1.0.22"],
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
    id: "package:oh-my-promptfoo:Provider",
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
      ...(label === "writable" ? { workspaceTimeoutMs: 1_800_000 } : {}),
      fileChanges: true,
    },
  });
  const workspaceAssertion = (id: string) => ({
    type: "javascript",
    value: "package:oh-my-promptfoo/assertions:agentAssert",
    config: {
      scoring: "binary",
      grader: {
        id,
        config:
          id === "anthropic:claude-agent-sdk"
            ? { apiKeyRequired: false }
            : id === "openai:codex-sdk"
              ? { apiKey: "fixture-api-key" }
              : {},
      },
      components: [
        {
          metric: "workspace-inspected",
          value:
            "AGENT_ASSERT_E2E: Read result.txt and project/input.txt in the live workspace. result.txt must equal {{ task }} and input.txt must remain immutable input. Verify the fileChanges evidence lists result.txt.",
        },
      ],
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
            "\nreturn import('node:fs').then(fs=>{ const m=context.providerResponse.metadata; const p=m.workspace.path; return m.workspace.cleanup==='best-effort-evaluation' && fs.readFileSync(p+'/result.txt','utf8')===context.vars.task && fs.readFileSync(p+'/project/input.txt','utf8')==='immutable input\\n' && m.fileChanges.status==='complete' && m.fileChanges.schemaVersion===2 && Buffer.from(m.fileChanges.changedFiles['result.txt'].content,'base64').toString()===context.vars.task;});",
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
          workspaceAssertion("openai:codex-sdk"),
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
      {
        providers: ["writable"],
        vars: { task: "writable-row" },
        assert: [workspaceAssertion("copilot-sdk")],
      },
      {
        providers: ["claude"],
        vars: { task: "claude-row" },
        assert: [
          { type: "skill-used", value: "demo" },
          workspaceAssertion("anthropic:claude-agent-sdk"),
        ],
      },
    ],
  };
  await writeFile(
    join(cwd, "grader.mjs"),
    `import {readdir,readFile,access} from 'node:fs/promises';import {join} from 'node:path';export default class Grader { id(){return 'fixture-grader';} async callApi(){const root=process.env.ALLAGENTS_WORKSPACE_ROOT;let live=false;for(const id of await readdir(root)){if(id.startsWith('.'))continue;for(const file of await readdir(join(root,id,'records'))){const row=JSON.parse(await readFile(join(root,id,'records',file),'utf8'));try{await access(join(row.path,'result.txt'));live=true;}catch{}}}return {output:JSON.stringify({pass:live,score:live?1:0,reason:'Deterministic grading checked live published workspace'})};}}`,
  );
  await writeFile(join(cwd, "promptfooconfig.json"), JSON.stringify(config, null, 2));
  // Launch outside the consumer installation: package assertions must resolve
  // peers beside their own module, not beside the invoking process cwd.
  const output = run(
    "node",
    [
      join(cwd, "node_modules/promptfoo/dist/src/entrypoint.js"),
      "eval",
      "--config",
      join(cwd, "promptfooconfig.json"),
      "--no-cache",
      "--no-progress-bar",
      "--output",
      join(cwd, "results.json"),
    ],
    workspaceParent,
  );
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
    const workspaceGrade = (row.gradingResult?.componentResults ?? []).find(
      (component: any) => component.namedScores?.["workspace-inspected"] === 1,
    );
    if (!workspaceGrade?.pass || !(workspaceGrade.tokensUsed?.total > 0))
      throw Error("Packed agentAssert did not inspect the workspace and report grader usage");
    const path = response.metadata.workspace.path;
    try {
      await import("node:fs/promises").then((fs) => fs.access(path));
      throw Error("Stock CLI skipped normal cleanup");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const cli = join(cwd, "node_modules/promptfoo/dist/src/entrypoint.js");
  async function evaluateFixture(
    name: string,
    suite: unknown,
    accepted = [0],
    env: NodeJS.ProcessEnv = testEnvironment,
    args: string[] = [],
  ) {
    await writeFile(join(cwd, `${name}.json`), JSON.stringify(suite));
    const child = spawn(
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
        ...args,
      ],
      { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const [status] = await once(child, "close");
    if (typeof status !== "number" || !accepted.includes(status))
      throw Error(`Promptfoo fixture ${name} failed (${status})\n${stdout}\n${stderr}`);
    const exported = JSON.parse(await readFile(join(cwd, `${name}-results.json`), "utf8"));
    return exported.results;
  }
  const skillSource = join(cwd, "skills");
  await mkdir(join(skillSource, "demo"), { recursive: true });
  await writeFile(
    join(skillSource, "demo/SKILL.md"),
    "---\nname: demo\ndescription: Demo verification skill\n---\nDemo skill.\n",
  );
  const skillProviders = [
    ["openai:codex-sdk", "codex-skills"],
    ["anthropic:claude-agent-sdk", "claude-skills"],
    ["copilot-sdk", "copilot-skills"],
  ].map(([id, label]) => {
    const provider = wrapper(id, label, "all");
    return {
      ...provider,
      config: {
        ...provider.config,
        fileChanges: false,
        workspace: {
          sources: [".agents", ".claude", ".github"].map((directory) => ({
            type: "local",
            path: skillSource,
            destination: `${directory}/skills`,
          })),
        },
      },
    };
  });
  const skillGates: Record<string, { successes: number; failures: number; errors: number }> = {};
  type SkillResult = {
    gradingResult?: { pass: boolean };
    response: {
      metadata: {
        skillCalls?: { name: string; is_error?: boolean }[];
        attemptedSkillCalls?: { name: string }[];
      };
    };
  };
  for (const mode of ["success", "failed", "text-only"]) {
    const expectedPass = mode === "success";
    const evaluated = await evaluateFixture(
      `skills-${mode}`,
      {
        tracing: { enabled: false },
        prompts: ["{{task}}"],
        providers: skillProviders,
        tests: [
          {
            vars: {
              task: `read:${JSON.stringify({ path: ".agents/skills/demo/SKILL.md", mode })}`,
            },
            assert: [{ type: "skill-used", value: "demo" }],
          },
        ],
      },
      expectedPass ? [0] : [100],
    );
    const { successes, failures, errors } = evaluated.stats;
    if (
      successes !== (expectedPass ? 3 : 0) ||
      failures !== (expectedPass ? 0 : 3) ||
      errors !== 0 ||
      evaluated.results.length !== 3 ||
      evaluated.results.some((row: SkillResult) => row.gradingResult?.pass !== expectedPass)
    )
      throw Error(
        `skill-used without tracing misgraded ${mode}: ${JSON.stringify(evaluated.stats)}`,
      );
    if (mode === "failed") {
      if (
        !evaluated.results.some((row: SkillResult) =>
          row.response.metadata.attemptedSkillCalls?.some((skill) => skill.name === "demo"),
        )
      )
        throw Error("Codex lost attempted skill evidence for a failed command");
      if (
        !evaluated.results.some((row: SkillResult) =>
          row.response.metadata.skillCalls?.some(
            (skill) => skill.name === "demo" && skill.is_error,
          ),
        )
      )
        throw Error("Claude lost failed Skill tool evidence");
    }
    skillGates[mode] = { successes, failures, errors };
  }
  const piModel = await startPiModelServer((request) => {
    const results = toolResults(request);
    const task = JSON.stringify(request.messages[0]?.content);
    if (task.includes("AGENT_ASSERT_PI_E2E")) {
      const listed = results.find((result) => result.tool_use_id === "pi-grader-list");
      if (!listed)
        return { tools: [{ id: "pi-grader-list", name: "ls", args: { path: ".agents/skills" } }] };
      if (listed.is_error || !JSON.stringify(listed).includes("demo"))
        throw Error("Pi grader could not discover the staged skill directory");
      const read = results.find((result) => result.tool_use_id === "pi-grader-read");
      if (!read)
        return {
          tools: [
            { id: "pi-grader-read", name: "read", args: { path: ".agents/skills/demo/SKILL.md" } },
          ],
        };
      if (read.is_error || !JSON.stringify(read).includes("Demo skill."))
        throw Error("Pi grader could not inspect the discovered skill body");
      return {
        text: JSON.stringify({
          components: [
            {
              metric: "workspace-inspected",
              score: 1,
              reason: "Pi grader listed the live skill directory and read the skill body",
            },
          ],
        }),
      };
    }
    if (results.length) {
      if (
        !results.some((result) => result.is_error) &&
        !JSON.stringify(results).includes("Demo skill.")
      )
        throw Error("Pi read tool did not return the real staged skill body");
      return {
        text: results.some((result) => result.is_error) ? "skill read failed" : "loaded demo skill",
      };
    }
    if (task.includes("Pi text-only")) return { text: "I used demo" };
    return {
      tools: [
        {
          id: "pi-read",
          name: "read",
          args: {
            path: task.includes("Pi failed")
              ? ".agents/skills/missing/SKILL.md"
              : ".agents/skills/demo/SKILL.md",
          },
        },
      ],
    };
  });
  const piProvider = {
    id: "package:oh-my-promptfoo:Provider",
    label: "pi",
    config: {
      delegate: {
        id: "pi-sdk",
        config: {
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          apiKey: "pi-local-test",
          baseUrl: piModel.url,
        },
      },
      workspace: skillProviders[0].config.workspace,
    },
  };
  let piGates: {
    successes: number;
    failures: number;
    errors: number;
    toolTrajectory: boolean;
    graderVerified: boolean;
  };
  try {
    const piSkills = await evaluateFixture(
      "pi-skills",
      {
        tracing: { enabled: false },
        prompts: ["{{task}}"],
        providers: [piProvider],
        tests: ["success", "failed", "text-only"].map((mode) => ({
          vars: { task: `Pi ${mode}` },
          assert: [{ type: "skill-used", value: "demo" }],
        })),
      },
      [100],
    );
    const { successes, failures, errors } = piSkills.stats;
    if (successes !== 1 || failures !== 2 || errors !== 0)
      throw Error(`Real Pi SDK skill gates misgraded: ${JSON.stringify(piSkills.stats)}`);
    const piTrace = await evaluateFixture("pi-trajectory", {
      tracing: { enabled: true },
      prompts: ["Pi success"],
      providers: [piProvider],
      tests: [
        {
          assert: [
            { type: "skill-used", value: "demo" },
            { type: "trajectory:tool-used", value: "read" },
            {
              type: "trajectory:tool-args-match",
              value: { name: "read", args: { path: ".agents/skills/demo/SKILL.md" } },
            },
          ],
        },
      ],
    });
    if (piTrace.stats.successes !== 1 || piTrace.stats.errors !== 0)
      throw Error("Real Pi SDK tool trajectory did not survive the packed provider");
    const piGrader = await evaluateFixture("pi-grader", {
      tracing: { enabled: false },
      prompts: ["Pi success"],
      providers: [piProvider],
      tests: [
        {
          assert: [
            {
              type: "javascript",
              value: "package:oh-my-promptfoo/assertions:agentAssert",
              config: {
                grader: piProvider.config.delegate,
                components: [
                  {
                    metric: "workspace-inspected",
                    value:
                      "AGENT_ASSERT_PI_E2E: Discover and inspect the live workspace skill. Its body must contain Demo skill.",
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const piWorkspaceGrade = piGrader.results[0]?.gradingResult?.componentResults?.find(
      (part: { namedScores?: Record<string, number> }) =>
        part.namedScores?.["workspace-inspected"] === 1,
    );
    if (
      piGrader.stats.successes !== 1 ||
      piGrader.stats.errors !== 0 ||
      !piWorkspaceGrade?.pass ||
      !(piWorkspaceGrade.tokensUsed?.total > 0)
    )
      throw Error("Packed Pi agentAssert did not discover and grade the live workspace");
    if (piModel.failures.length)
      throw new AggregateError(piModel.failures, "Pi model fixture failed");
    piGates = { successes, failures, errors, toolTrajectory: true, graderVerified: true };
  } finally {
    await piModel.close();
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
        id: "package:oh-my-promptfoo:CopilotSdkProvider",
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
  // Promptfoo hands every provider the eval config's directory as basePath, including one
  // included from `providers: file://…`. A relative local path and the default boundary (the
  // config's Git repository) follow it, with the CLI started from another directory.
  const suite = join(cwd, "suite");
  const skills = join(suite, "plugins", "demo", "skills");
  await mkdir(join(skills, "demo"), { recursive: true });
  await mkdir(join(suite, "evals", "providers"), { recursive: true });
  await writeFile(join(skills, "demo", "SKILL.md"), "config-relative skill\n");
  run("git", ["init", "--initial-branch=main", suite]);
  const relativeWrapper = wrapper("openai:codex-sdk", "config-relative", "all");
  const relativeProvider = {
    ...relativeWrapper,
    config: {
      ...relativeWrapper.config,
      workspace: {
        sources: [{ type: "local", path: "../plugins/demo/skills", destination: ".agents/skills" }],
      },
    },
  };
  // JSON is valid YAML; Promptfoo parses included provider files as YAML.
  await writeFile(
    join(suite, "evals", "providers", "workspace.yaml"),
    JSON.stringify([relativeProvider]),
  );
  const relativeRuns: Record<string, number> = {};
  for (const [name, providers] of [
    ["inline", [relativeProvider]],
    ["included", "file://providers/workspace.yaml"],
  ] as const) {
    const configPath = join(suite, "evals", `${name}.json`);
    const resultsPath = join(cwd, `config-relative-${name}-results.json`);
    await writeFile(
      configPath,
      JSON.stringify({
        prompts: ["{{task}}"],
        providers,
        tests: [
          {
            vars: { task: `config-relative-${name}` },
            assert: [
              {
                type: "javascript",
                value: `\nreturn import('node:fs').then(fs=>{const w=context.providerResponse.metadata.workspace;return fs.readFileSync(w.path+'/.agents/skills/demo/SKILL.md','utf8')==='config-relative skill\\n'&&w.sources[0].path===${JSON.stringify(skills)};});`,
              },
            ],
          },
        ],
      }),
    );
    run(
      "node",
      [
        cli,
        "eval",
        "--config",
        relative(workspaceParent, configPath),
        "--no-cache",
        "--no-progress-bar",
        "--output",
        resultsPath,
      ],
      workspaceParent,
    );
    const exported = JSON.parse(await readFile(resultsPath, "utf8")).results;
    if (exported.stats.successes !== 1 || exported.stats.errors !== 0)
      throw Error(
        `Config-relative ${name} local source failed: ${JSON.stringify(exported.results[0]?.response?.error ?? exported.stats)}`,
      );
    relativeRuns[name] = exported.stats.successes;
  }
  const judgeRequests: {
    url: string | undefined;
    body: { model: string; messages: { role: string; content: string }[] };
  }[] = [];
  const judge = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    judgeRequests.push({ url: request.url, body: JSON.parse(body) });
    if (request.url?.startsWith("/fail/")) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Local judge outage" } }));
      return;
    }
    // `/ok/v1` answers both Promptfoo's llm-rubric and llmAssert with one reply shape.
    const verdict = request.url?.startsWith("/ok/")
      ? {
          pass: true,
          score: 1,
          reason: "Fallback judge answered",
          components: [{ metric: "fallback", score: 1, reason: "Fallback judge answered" }],
        }
      : {
          components: [
            { metric: "accuracy", score: 1, reason: "Grounded" },
            { metric: "clarity", score: 0.7, reason: "Clear" },
          ],
        };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict) } }] }));
  });
  judge.listen(0, "127.0.0.1");
  await once(judge, "listening");
  try {
    const address = judge.address();
    if (!address || typeof address === "string") throw Error("Missing local judge port");
    const name = "packaged-assertion";
    await writeFile(
      join(cwd, `${name}.json`),
      JSON.stringify({
        prompts: ["review"],
        providers: ["echo"],
        defaultTest: {
          options: {
            provider: {
              id: "openai:chat:fake-grader",
              config: { apiBaseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "local-only" },
            },
          },
        },
        tests: [
          {
            vars: {
              subject: "the packaged build",
              details: { subject: "packed object" },
              encoded: JSON.stringify({ subject: "loaded JSON" }),
            },
            assert: [
              {
                type: "javascript",
                value: "package:oh-my-promptfoo/assertions:llmAssert",
                config: {
                  threshold: 0.7,
                  rubricPrompt:
                    "Judge only {{ subject }}. Environment {% set e = env.PACKED_ASSERTION_SUBJECT %}{{ e }}; object {{ details }}; {% set parsed = encoded | load %}loaded {{ parsed.subject }}.",
                  components: [
                    {
                      metric: "accuracy",
                      value:
                        "Ground claims about {{ subject }}; environment {% set e = env.PACKED_ASSERTION_SUBJECT %}{{ e }}; {% set parsed = encoded | load %}loaded {{ parsed.subject }}; nested {{ details.subject }}",
                      weight: 3,
                    },
                    { metric: "clarity", value: "Explain {{ details.subject }} clearly" },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );
    const child = spawn(
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
      {
        cwd,
        env: {
          ...testEnvironment,
          PACKED_ASSERTION_SUBJECT: "packed environment",
          PROMPTFOO_DISABLE_TEMPLATING: "false",
          PROMPTFOO_DISABLE_OBJECT_STRINGIFY: "false",
          // `--no-cache` does not reach package code yet (promptfoo/promptfoo#11918).
          PROMPTFOO_CACHE_ENABLED: "false",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const [status] = await once(child, "close");
    if (status !== 0) throw Error(`Packed assertion CLI failed:\n${stdout}\n${stderr}`);
    const exported = JSON.parse(await readFile(join(cwd, `${name}-results.json`), "utf8")).results;
    const grade = exported.results[0]?.gradingResult;
    const componentGrades = grade?.componentResults?.filter(
      (part: { assertion?: { metric?: string } }) => part.assertion?.metric,
    );
    if (
      exported.stats.successes !== 1 ||
      judgeRequests.length !== 1 ||
      judgeRequests[0].url !== "/v1/chat/completions" ||
      judgeRequests[0].body.model !== "fake-grader" ||
      judgeRequests[0].body.messages[0].role !== "system" ||
      judgeRequests[0].body.messages[1].role !== "user" ||
      // Test variables render through the Nunjucks Promptfoo installs, from the packed build.
      !judgeRequests[0].body.messages[0].content.includes("Judge only the packaged build.") ||
      !judgeRequests[0].body.messages[0].content.includes(
        'Environment packed environment; object {"subject":"packed object"}; loaded loaded JSON.',
      ) ||
      judgeRequests[0].body.messages[1].content !==
        "<Output>\nreview\n</Output>\n<Rubric>\n- accuracy: Ground claims about the packaged build; environment packed environment; loaded loaded JSON; nested packed object\n- clarity: Explain packed object clearly\n</Rubric>" ||
      // What the judge was sent reaches Promptfoo's results, as llm-rubric reports it.
      ![grade, ...(grade?.componentResults ?? [])].some(
        (part: { metadata?: { renderedGradingPrompt?: unknown } } | undefined) =>
          part?.metadata?.renderedGradingPrompt === JSON.stringify(judgeRequests[0].body.messages),
      ) ||
      grade?.score !== 0.925 ||
      grade?.namedScores?.accuracy !== 1 ||
      grade?.namedScores?.clarity !== 0.7 ||
      componentGrades
        ?.map((part: { assertion: { metric: string } }) => part.assertion.metric)
        .join(",") !== "accuracy,clarity" ||
      componentGrades.some((part: { pass: boolean }) => !part.pass)
    )
      throw Error("Stock Promptfoo did not preserve the packed single-request rubric grades");
    const base = `http://127.0.0.1:${address.port}`;
    const judgeEnvironment = { ...testEnvironment, PROMPTFOO_CACHE_ENABLED: "false" };
    const failingJudge = {
      id: "openai:chat:fake-grader",
      label: "failing-judge",
      config: { apiBaseUrl: `${base}/fail/v1`, apiKey: "local-only" },
    };
    const answeringJudge = {
      id: "openai:chat:fake-grader",
      label: "answering-judge",
      config: { apiBaseUrl: `${base}/ok/v1`, apiKey: "local-only" },
    };
    const fallbackStart = judgeRequests.length;
    const fallback = await evaluateFixture(
      "packaged-fallback-judge",
      {
        prompts: ["fallback"],
        providers: ["echo"],
        defaultTest: {
          options: {
            provider: {
              id: "package:oh-my-promptfoo/providers:FallbackProvider",
              config: { providers: [failingJudge, answeringJudge] },
            },
          },
        },
        tests: [
          {
            assert: [
              { type: "llm-rubric", value: "Says fallback" },
              {
                type: "javascript",
                value: "package:oh-my-promptfoo/assertions:llmAssert",
                config: { components: [{ metric: "fallback", value: "Says fallback" }] },
              },
            ],
          },
        ],
      },
      [0],
      judgeEnvironment,
    );
    const fallbackRequests = judgeRequests.slice(fallbackStart);
    const fallbackRow = fallback.results[0];
    const fallbackParts: {
      pass: boolean;
      assertion?: { type?: string };
      metadata?: { fallback?: { answeredBy?: string } };
    }[] = fallbackRow?.gradingResult?.componentResults ?? [];
    const rubricPart = fallbackParts.find((part) => part.assertion?.type === "llm-rubric");
    const llmAssertPart = fallbackParts.find((part) => part.assertion?.type === "javascript");
    if (
      fallback.stats.successes !== 1 ||
      !rubricPart?.pass ||
      !llmAssertPart?.pass ||
      rubricPart.metadata?.fallback?.answeredBy !== "answering-judge" ||
      llmAssertPart.metadata?.fallback?.answeredBy !== "answering-judge" ||
      !fallbackRequests.some((request) => request.url === "/fail/v1/chat/completions") ||
      fallbackRequests.filter((request) => request.url === "/ok/v1/chat/completions").length !==
        2 ||
      // Failed attempts on the first judge count as grading requests too.
      fallbackRow.tokenUsage?.assertions?.numRequests !== fallbackRequests.length
    )
      throw Error(
        `Stock Promptfoo did not fail over llm-rubric and llmAssert to the second judge: ${JSON.stringify(fallbackRow?.gradingResult)}`,
      );
    const outage = await evaluateFixture(
      "packaged-judge-outage",
      {
        prompts: ["outage"],
        providers: ["echo"],
        defaultTest: { options: { provider: failingJudge } },
        tests: [
          {
            assert: [
              { type: "contains", value: "outage" },
              {
                type: "javascript",
                value: "package:oh-my-promptfoo/assertions:llmAssert",
                config: { components: [{ metric: "outage", value: "Says outage" }] },
              },
            ],
          },
        ],
      },
      [100],
      judgeEnvironment,
    );
    const outageRow = outage.results[0];
    const outageParts: {
      pass: boolean;
      assertion?: { type?: string };
      metadata?: { graderError?: boolean };
    }[] = outageRow?.gradingResult?.componentResults ?? [];
    if (
      outage.stats.failures !== 1 ||
      outage.stats.errors !== 0 ||
      outageRow.failureReason !== 1 ||
      !outageParts.find((part) => part.assertion?.type === "contains")?.pass ||
      outageParts.find((part) => part.assertion?.type === "javascript")?.metadata?.graderError !==
        true
    )
      throw Error(
        `A judge outage did not fail the row while keeping its other results: ${JSON.stringify(outageRow?.gradingResult)}`,
      );
    // Each level's judge answers at its own path, so the requests show who was asked.
    const levelJudge = (level: string) => ({
      id: "openai:chat:fake-grader",
      label: `${level}-judge`,
      config: { apiBaseUrl: `${base}/${level}/v1`, apiKey: "local-only" },
    });
    const judged = (provider?: unknown) => ({
      type: "javascript",
      value: "package:oh-my-promptfoo/assertions:llmAssert",
      config: {
        components: [
          { metric: "accuracy", value: "Grounded" },
          { metric: "clarity", value: "Clear" },
        ],
        ...(provider ? { provider } : {}),
      },
    });
    type JudgedPart = {
      pass: boolean;
      assertion?: { type?: string; config?: { provider?: unknown } };
      metadata?: { judge?: string; fallback?: { answeredBy?: string } };
    };
    // [row][assertion] as "who: judge" (and who answered inside a fallback chain).
    const judges = (rows: { gradingResult?: { componentResults?: JudgedPart[] } }[]) =>
      rows.map((row) =>
        (row.gradingResult?.componentResults ?? [])
          .filter((part) => part.assertion?.type === "javascript")
          .map(
            (part) =>
              `${part.assertion?.config?.provider ? "assertion" : "test"}: ${part.metadata?.judge}${
                part.metadata?.fallback ? ` via ${part.metadata.fallback.answeredBy}` : ""
              }${part.pass ? "" : " FAILED"}`,
          ),
      );
    const levelRequests = (from: number) =>
      judgeRequests
        .slice(from)
        .map((request) => request.url?.split("/")[1])
        .filter((level) => level !== "fail")
        .sort();
    const precedenceStart = judgeRequests.length;
    const precedence = await evaluateFixture(
      "packaged-assertion-judge",
      {
        prompts: ["precedence"],
        providers: ["echo"],
        defaultTest: { options: { provider: levelJudge("suite") } },
        tests: [
          { assert: [judged(), judged(levelJudge("assertion"))] },
          {
            options: { provider: levelJudge("test") },
            assert: [
              judged(),
              judged({
                id: "package:oh-my-promptfoo/providers:FallbackProvider",
                config: { providers: [failingJudge, levelJudge("assertion")] },
              }),
            ],
          },
        ],
      },
      [0],
      judgeEnvironment,
    );
    const expectedPrecedence = [
      ["test: suite-judge", "assertion: assertion-judge"],
      [
        "test: test-judge",
        "assertion: package:oh-my-promptfoo/providers:FallbackProvider via assertion-judge",
      ],
    ];
    if (
      precedence.stats.successes !== 2 ||
      JSON.stringify(judges(precedence.results)) !== JSON.stringify(expectedPrecedence) ||
      JSON.stringify(levelRequests(precedenceStart)) !==
        JSON.stringify(["assertion", "assertion", "suite", "test"])
    )
      throw Error(
        `An assertion's config.provider did not take precedence over the test and suite judges: ${JSON.stringify(judges(precedence.results))}`,
      );
    // --grader replaces the suite judge, and an assertion's config.provider still beats it.
    const graderStart = judgeRequests.length;
    const overGrader = await evaluateFixture(
      "packaged-assertion-judge-over-grader",
      {
        prompts: ["precedence"],
        providers: ["echo"],
        defaultTest: { options: { provider: levelJudge("suite") } },
        tests: [{ assert: [judged(), judged(levelJudge("assertion"))] }],
      },
      [0],
      {
        ...judgeEnvironment,
        // Promptfoo reads OPENAI_API_BASE_URL first, so an inherited one must not win.
        OPENAI_API_BASE_URL: `${base}/grader/v1`,
        OPENAI_BASE_URL: `${base}/grader/v1`,
        OPENAI_API_KEY: "local-only",
      },
      ["--grader", "openai:chat:fake-grader"],
    );
    if (
      overGrader.stats.successes !== 1 ||
      // Promptfoo's OpenAI chat provider names itself openai:<model>.
      JSON.stringify(judges(overGrader.results)) !==
        JSON.stringify([["test: openai:fake-grader", "assertion: assertion-judge"]]) ||
      JSON.stringify(levelRequests(graderStart)) !== JSON.stringify(["assertion", "grader"])
    )
      throw Error(
        `An assertion's config.provider did not take precedence over --grader: ${JSON.stringify(judges(overGrader.results))}`,
      );
  } finally {
    const closed = once(judge, "close");
    judge.close();
    await closed;
  }
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
    `import {Provider} from 'oh-my-promptfoo';const provider=new Provider(${JSON.stringify({ config: wrapper("openai:codex-sdk", "abandoned", "all").config })});const response=await provider.callApi('abandoned');if(response.error)throw Error(response.error);console.log(response.metadata.workspace.path);`,
  );
  const abandoned = run("node", ["abandoned.mjs"]).trim();
  await import("node:fs/promises").then((fs) => fs.access(abandoned));
  await writeFile(
    join(cwd, "recover.mjs"),
    `import {Provider} from 'oh-my-promptfoo';const provider=new Provider(${JSON.stringify({ config: wrapper("openai:codex-sdk", "recovery", "all").config })});await provider.cleanup();`,
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
        promptfoo: promptfooVersion,
        package: installedManifest.version,
        surface: registryVersion
          ? "registry-installed package loaded by stock promptfoo eval"
          : "npm-packed package loaded by stock promptfoo eval",
        sdkMode:
          "deterministic Codex/Claude/Copilot SDK fixtures; real Pi SDK against a local model-service endpoint; independently npm-installed Promptfoo and real integration runtime",
        stats,
        verifiedAssertions,
        additionalGates: {
          unfilteredRows: unfiltered.stats.successes,
          directCopilot: direct.stats.successes,
          nativeErrors: nativeError.stats.errors,
          skillUsedWithoutTracing: skillGates,
          piSdk: piGates,
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
          "packaged llmAssert with defaultTest judge",
          "llm-rubric and llmAssert through FallbackProvider",
          "llmAssert judge outage keeps row results",
          "llmAssert config.provider over test, --grader and defaultTest judges",
        ],
        stdout: output
          .replaceAll(cwd, "<temporary-consumer>")
          .replaceAll(workspaceParent, "<temporary-workspace-storage>"),
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `Built Promptfoo E2E passed: ${JSON.stringify(stats)}; config-relative local sources: ${JSON.stringify(relativeRuns)}`,
  );
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
