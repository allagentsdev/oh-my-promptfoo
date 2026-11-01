import { spawnSync } from "node:child_process";
import { copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, test } from "vitest";

const expectedSha = "a".repeat(40);
const current = { state: "OPEN", headRefOid: expectedSha };
const notice =
  "::notice::Skipping superseded preview: the release PR closed, merged, or changed head during validation\n";
const ghCall = ["gh", "pr", "view", "123", "--json", "state,headRefOid"];
const fetchCall = ["git", "fetch", "--no-tags", "origin", "main"];
const ancestryCall = ["git", "merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"];
const manifestCall = ["git", "show", "HEAD:package.json"];
const baseAncestryCall = ["git", "merge-base", "--is-ancestor", "refs/tags/v1.26.0", "HEAD"];
const historyCall = ["git", "log", "--format=%B%x00", "refs/tags/v1.26.0..HEAD"];
const publicationCalls = [
  ghCall,
  fetchCall,
  ancestryCall,
  manifestCall,
  baseAncestryCall,
  historyCall,
];
const buriedOverride = `feat(assertions)!: default assertions to binary scoring

* feat(assertions)!: default assertions to binary scoring

Release-As: 1.27.0

* test(e2e): keep the judge fixture on graded scoring

The fixture returns partial credit.
`;

const fakeCommand = `#!/usr/bin/env node
const {appendFileSync,readFileSync}=require('node:fs');
const {basename}=require('node:path');
const windows=process.platform==='win32';
const command=basename(windows?process.execPath:process.argv[1]).replace(/\\.exe$/i,'');
const args=windows?[basename(process.argv[1]),...process.argv.slice(2)]:process.argv.slice(2);
if(args[0]==='fixture-probe'){console.log('allagents-fake-'+command);process.exit(0);}
appendFileSync(process.env.FIXTURE_CALLS,JSON.stringify([command,...args])+'\\n');
const fixture=JSON.parse(readFileSync(process.env.FIXTURE_STATE,'utf8'));
if(command==='gh'&&JSON.stringify(args)===JSON.stringify(['pr','view','123','--json','state,headRefOid'])){
  if(fixture.failure==='gh'){console.error('fixture GitHub failure');process.exit(1);}
  console.log(JSON.stringify(fixture.response));
}else if(command==='git'&&JSON.stringify(args)===JSON.stringify(['fetch','--no-tags','origin','main'])){
  if(fixture.failure==='fetch'){console.error('fixture fetch failure');process.exit(1);}
}else if(command==='git'&&JSON.stringify(args)===JSON.stringify(['merge-base','--is-ancestor','HEAD','FETCH_HEAD'])){
  if(fixture.failure==='ancestry'){console.error('fixture ancestry failure');process.exit(1);}
}else if(command==='git'&&JSON.stringify(args)===JSON.stringify(['show','HEAD:package.json'])){
  console.log(JSON.stringify({version:'1.26.0'}));
}else if(command==='git'&&JSON.stringify(args)===JSON.stringify(['merge-base','--is-ancestor','refs/tags/v1.26.0','HEAD'])){
  if(fixture.failure==='base'){console.error('fixture release base failure');process.exit(1);}
}else if(command==='git'&&JSON.stringify(args)===JSON.stringify(['log','--format=%B%x00','refs/tags/v1.26.0..HEAD'])){
  if(fixture.failure==='history'){console.error('fixture history failure');process.exit(1);}
  process.stdout.write((fixture.messages??[]).join('\\0'));
}else{console.error('Unexpected fixture command: '+command+' '+JSON.stringify(args));process.exit(2);}
`;

type PreviewCase = {
  name: string;
  response: unknown;
  expectedSha?: string;
  failure?: "gh" | "fetch" | "ancestry" | "base" | "history";
  previewVersion?: string;
  messages?: string[];
  history?: string[];
  status: number;
  output: string;
  calls: string[][];
  error?: string;
};

const cases: PreviewCase[] = [
  {
    name: "publishes only the current open head after fetching and checking source ancestry",
    response: current,
    status: 0,
    output: "publish=true\n",
    calls: publicationCalls,
  },
  {
    name: "skips a changed head without any Git work",
    response: { ...current, headRefOid: "b".repeat(40) },
    status: 0,
    output: "publish=false\n",
    calls: [ghCall],
  },
  {
    name: "skips a closed PR without any Git work",
    response: { ...current, state: "CLOSED" },
    status: 0,
    output: "publish=false\n",
    calls: [ghCall],
  },
  {
    name: "skips a merged PR without any Git work",
    response: { ...current, state: "MERGED" },
    status: 0,
    output: "publish=false\n",
    calls: [ghCall],
  },
  {
    name: "rejects a null GitHub response",
    response: null,
    status: 1,
    output: "",
    calls: [ghCall],
    error: "Malformed release pull request response",
  },
  {
    name: "rejects an array GitHub response",
    response: [current],
    status: 1,
    output: "",
    calls: [ghCall],
    error: "Malformed release pull request response",
  },
  {
    name: "rejects an unknown PR state",
    response: { ...current, state: "UNKNOWN" },
    status: 1,
    output: "",
    calls: [ghCall],
    error: "Malformed release pull request response",
  },
  {
    name: "rejects a missing PR head",
    response: { state: "OPEN" },
    status: 1,
    output: "",
    calls: [ghCall],
    error: "Malformed release pull request response",
  },
  {
    name: "rejects an invalid PR head",
    response: { ...current, headRefOid: "not-a-commit" },
    status: 1,
    output: "",
    calls: [ghCall],
    error: "Malformed release pull request response",
  },
  {
    name: "rejects an invalid expected SHA before calling GitHub or Git",
    response: current,
    expectedSha: "not-a-commit",
    status: 1,
    output: "",
    calls: [],
    error: "Invalid validated release pull request head",
  },
  {
    name: "fails closed on a GitHub error",
    response: current,
    failure: "gh",
    status: 1,
    output: "",
    calls: [ghCall],
    error: "fixture GitHub failure",
  },
  {
    name: "fails closed on a fetch error without checking ancestry",
    response: current,
    failure: "fetch",
    status: 1,
    output: "",
    calls: [ghCall, fetchCall],
    error: "fixture fetch failure",
  },
  {
    name: "fails closed when the source ancestry check fails",
    response: current,
    failure: "ancestry",
    status: 1,
    output: "",
    calls: [ghCall, fetchCall, ancestryCall],
    error: "fixture ancestry failure",
  },
  {
    name: "blocks an accidental major preview when Release-As is buried in a squash message",
    response: current,
    previewVersion: "2.0.0-next.148",
    messages: [buriedOverride],
    status: 1,
    output: "",
    calls: publicationCalls,
    error: "Release-As: 1.27.0 conflicts with preview 2.0.0-next.148",
  },
  {
    name: "allows a preview matching a buried explicit minor request",
    response: current,
    messages: [buriedOverride],
    status: 0,
    output: "publish=true\n",
    calls: publicationCalls,
  },
  {
    name: "uses the newest explicit request even when a newer commit has no override",
    response: current,
    messages: [
      "fix: follow-up",
      "chore: choose release\n\nrelease-as: 1.27.0",
      "feat!: change behavior\n\nRelease-As: 2.0.0",
    ],
    status: 0,
    output: "publish=true\n",
    calls: publicationCalls,
  },
  {
    name: "rejects conflicting explicit requests in one commit",
    response: current,
    messages: ["feat!: change\n\nRelease-As: 1.27.0\n\nRelease-As: 2.0.0"],
    status: 1,
    output: "",
    calls: publicationCalls,
    error: "Expected one stable Release-As version in the newest override commit",
  },
  {
    name: "rejects an invalid explicit version instead of silently publishing",
    response: current,
    messages: ["feat!: change\n\nRelease-As: 1.x"],
    status: 1,
    output: "",
    calls: publicationCalls,
    error: "Expected one stable Release-As version in the newest override commit",
  },
  {
    name: "fails closed when the current stable tag is not an ancestor",
    response: current,
    failure: "base",
    status: 1,
    output: "",
    calls: publicationCalls.slice(0, -1),
    error: "fixture release base failure",
  },
  {
    name: "fails closed when unreleased commit history cannot be read",
    response: current,
    failure: "history",
    status: 1,
    output: "",
    calls: publicationCalls,
    error: "fixture history failure",
  },
  {
    name: "ignores an override already included in the stable tag using real Git history",
    response: current,
    history: ["fix: follow-up without a version override"],
    status: 0,
    output: "publish=true\n",
    calls: [ghCall],
  },
  {
    name: "blocks a buried minor override from real unreleased Git history",
    response: current,
    previewVersion: "2.0.0-next.148",
    history: [buriedOverride],
    status: 1,
    output: "",
    calls: [ghCall],
    error: "Release-As: 1.27.0 conflicts with preview 2.0.0-next.148",
  },
];

async function checkPublication(scenario: PreviewCase) {
  const root = await mkdtemp(join(tmpdir(), "allagents-preview-publication-"));
  try {
    const node = spawnSync("node", ["--eval", "process.stdout.write(process.execPath)"], {
      encoding: "utf8",
    });
    if (node.error || node.status !== 0 || !node.stdout)
      throw new Error("Node is required to exercise the workflow's executable script");
    const executable = node.stdout;
    const bin = join(root, "bin");
    await mkdir(bin);
    const fakeCommands = scenario.history ? ["gh"] : ["gh", "git"];
    if (process.platform === "win32") {
      // Node execFileSync cannot launch .cmd shims. Real Node executables dispatch
      // these extensionless fixture entrypoints without a shell or compilation.
      for (const command of fakeCommands) {
        const target = join(bin, `${command}.exe`);
        await link(executable, target).catch(() => copyFile(executable, target));
      }
      for (const entrypoint of ["fixture-probe", "pr", "fetch", "merge-base", "show", "log"])
        await writeFile(join(root, entrypoint), fakeCommand);
    } else {
      for (const command of fakeCommands)
        await writeFile(join(bin, command), fakeCommand, { mode: 0o755 });
    }
    const output = join(root, "output");
    const calls = join(root, "calls");
    const state = join(root, "state.json");
    await writeFile(output, "");
    await writeFile(calls, "");
    await writeFile(state, JSON.stringify(scenario));
    const env = { ...process.env };
    const inheritedPath =
      Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
    for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
    Object.assign(env, {
      PATH: `${bin}${delimiter}${inheritedPath}`,
      RELEASE_PR: "123",
      RELEASE_PR_SHA: scenario.expectedSha ?? expectedSha,
      PREVIEW_VERSION: scenario.previewVersion ?? "1.27.0-next.148",
      GITHUB_OUTPUT: output,
      FIXTURE_CALLS: calls,
      FIXTURE_STATE: state,
    });
    if (scenario.history) {
      const git = (...args: string[]) => {
        const result = spawnSync(
          "git",
          [
            "-c",
            "user.name=Preview Test",
            "-c",
            "user.email=preview@example.invalid",
            "-c",
            "commit.gpgsign=false",
            ...args,
          ],
          { cwd: root, encoding: "utf8", env },
        );
        if (result.error || result.status !== 0)
          throw new Error(result.error?.message ?? result.stderr);
      };
      git("init", "--initial-branch=main");
      await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.26.0" }));
      git("add", "package.json");
      git("commit", "-m", "chore: previous release\n\nRelease-As: 9.0.0");
      git("tag", "v1.26.0");
      for (const message of scenario.history) git("commit", "--allow-empty", "-m", message);
      git("remote", "add", "origin", root);
    }
    for (const command of fakeCommands) {
      const probe = spawnSync(command, ["fixture-probe"], { cwd: root, encoding: "utf8", env });
      if (probe.error || probe.status !== 0 || probe.stdout.trim() !== `allagents-fake-${command}`)
        throw new Error(`Fake ${command} was not selected; refusing to run publication check`);
    }
    const result = spawnSync(
      executable,
      [join(import.meta.dirname, "..", "scripts", "check-preview-publication.mjs")],
      { cwd: root, encoding: "utf8", env },
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(scenario.status);
    expect(await readFile(output, "utf8")).toBe(scenario.output);
    expect(result.stdout).toBe(scenario.output === "publish=false\n" ? notice : "");
    if (scenario.error) expect(result.stderr).toContain(scenario.error);
    else expect(result.stderr).toBe("");
    const recorded = (await readFile(calls, "utf8")).trim();
    expect(recorded ? recorded.split("\n").map((line) => JSON.parse(line)) : []).toEqual(
      scenario.calls,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("preview publication eligibility", () => {
  for (const scenario of cases) test(scenario.name, () => checkPublication(scenario));
});
