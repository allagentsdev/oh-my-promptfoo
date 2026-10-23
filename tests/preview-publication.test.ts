import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const expectedSha = "a".repeat(40);
const current = { state: "OPEN", headRefOid: expectedSha };
const notice =
  "::notice::Skipping superseded preview: the release PR closed, merged, or changed head during validation\n";
const ghCall = ["gh", "pr", "view", "123", "--json", "state,headRefOid"];
const fetchCall = ["git", "fetch", "--no-tags", "origin", "main"];
const ancestryCall = ["git", "merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"];

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
}else{console.error('Unexpected fixture command: '+command+' '+JSON.stringify(args));process.exit(2);}
`;

type PreviewCase = {
  name: string;
  response: unknown;
  expectedSha?: string;
  failure?: "gh" | "fetch" | "ancestry";
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
    calls: [ghCall, fetchCall, ancestryCall],
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
    if (process.platform === "win32") {
      // Node execFileSync cannot launch .cmd shims. Real Node executables dispatch
      // these extensionless fixture entrypoints without a shell or compilation.
      for (const command of ["gh", "git"]) {
        const target = join(bin, `${command}.exe`);
        await link(executable, target).catch(() => copyFile(executable, target));
      }
      for (const entrypoint of ["fixture-probe", "pr", "fetch", "merge-base"])
        await writeFile(join(root, entrypoint), fakeCommand);
    } else {
      for (const command of ["gh", "git"])
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
      GITHUB_OUTPUT: output,
      FIXTURE_CALLS: calls,
      FIXTURE_STATE: state,
    });
    for (const command of ["gh", "git"]) {
      const probe = spawnSync(command, ["fixture-probe"], { cwd: root, encoding: "utf8", env });
      if (probe.error || probe.status !== 0 || probe.stdout.trim() !== `allagents-fake-${command}`)
        throw new Error(`Fake ${command} was not selected; refusing to run publication check`);
    }
    const result = spawnSync(
      executable,
      [join(import.meta.dir, "..", "scripts", "check-preview-publication.mjs")],
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
