import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const fakeNpm = `#!/usr/bin/env node
const {readFileSync,writeFileSync}=require('node:fs');
const args=process.argv.slice(2);
if(args[0]==='--fixture-probe'){console.log('allagents-fake-npm');process.exit(0);}
const file=process.env.FAKE_REGISTRY_FILE;
const state=JSON.parse(readFileSync(file,'utf8'));
if(args[0]==='view'&&state.indexDelay>0){
  state.indexDelay--;
  writeFileSync(file,JSON.stringify(state));
  if(args[2]==='version'){console.error('ETARGET');process.exit(1);}
  if(args[2]==='dist-tags'){console.log(JSON.stringify({latest:'1.0.0-rc.1'}));process.exit(0);}
}
if(args[0]==='view'){
  if(process.env.FAKE_REGISTRY_MODE==='unavailable'){
    console.error('E503: registry unavailable');process.exit(1);
  }
  if(args[2]==='version'){
    const version=args[1].slice(args[1].lastIndexOf('@')+1);
    if(!state.versions.includes(version)){
      console.error(state.versions.length?'ETARGET':'E404');process.exit(1);
    }
    console.log(JSON.stringify(process.env.FAKE_REGISTRY_MODE==='wrong-version'?'9.9.9':version));
  }else if(args[2]==='dist-tags'){
    if(!state.versions.length){console.error('E404');process.exit(1);}
    console.log(JSON.stringify(state.tags));
  }else process.exit(2);
}else if(args[0]==='publish'){
  const version=JSON.parse(readFileSync('package.json','utf8')).version;
  if(state.versions.includes(version)){console.error('Already published');process.exit(1);}
  state.versions.push(version);
  state.tags[args[args.indexOf('--tag')+1]]=version;
  state.published.push(version);
  if(process.env.FAKE_REGISTRY_MODE==='lagged')state.indexDelay=3;
  writeFileSync(file,JSON.stringify(state));
}else process.exit(2);
`;

const isPathKey = (key: string) => key.toLowerCase() === "path";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "allagents-publish-test-"));
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "bin"));
  await mkdir(join(root, "packages", "promptfoo-x"), { recursive: true });
  await copyFile(
    join(import.meta.dir, "..", "scripts", "publish.ts"),
    join(root, "scripts", "publish.ts"),
  );
  if (process.platform === "win32") {
    await writeFile(join(root, "bin", "npm.js"), fakeNpm);
    await writeFile(
      join(root, "bin", "npm.cmd"),
      `@echo off\r\n"${process.execPath}" "%~dp0npm.js" %*\r\n`,
    );
  } else {
    await writeFile(join(root, "bin", "npm"), fakeNpm, { mode: 0o755 });
  }
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ version: "1.0.0", private: true })}\n`,
  );
  await writeFile(
    join(root, "packages", "promptfoo-x", "package.json"),
    `${JSON.stringify({ name: "@allagents/promptfoo-x", version: "1.0.0", private: true })}\n`,
  );
  const registry = join(root, "registry-state");
  await writeFile(registry, JSON.stringify({ versions: [], tags: {}, published: [] }));
  return { root, registry, output: join(root, "output") };
}

function run(
  f: Awaited<ReturnType<typeof fixture>>,
  options: { ref?: string; mode?: string } = {},
) {
  const env = { ...process.env };
  const inheritedPath = Object.entries(env).find(([key]) => isPathKey(key))?.[1] ?? "";
  for (const key of Object.keys(env)) if (isPathKey(key)) delete env[key];
  Object.assign(env, {
    PATH: `${join(f.root, "bin")}${delimiter}${inheritedPath}`,
    RELEASE_REF: options.ref ?? "v1.0.0",
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/oidc",
    GITHUB_OUTPUT: f.output,
    FAKE_REGISTRY_FILE: f.registry,
    FAKE_REGISTRY_MODE: options.mode ?? "",
  });
  const probe = spawnSync("npm", ["--fixture-probe"], { cwd: f.root, encoding: "utf8", env });
  if (probe.status !== 0 || probe.stdout.trim() !== "allagents-fake-npm")
    throw new Error("Fake npm shim was not selected; refusing to run release script");
  return spawnSync(process.execPath, [join(f.root, "scripts", "publish.ts")], {
    cwd: f.root,
    encoding: "utf8",
    env,
  });
}

describe("trusted stable release publish", () => {
  test("publishes latest once and safely retries an already published stable version", async () => {
    const f = await fixture();
    try {
      const first = run(f);
      expect(first.status).toBe(0);
      expect(await readFile(f.output, "utf8")).toContain("version=1.0.0\n");
      const state = JSON.parse(await readFile(f.registry, "utf8"));
      expect(state.tags).toEqual({ latest: "1.0.0" });
      expect(state.published).toEqual(["1.0.0"]);
      expect(run(f).status).toBe(0);
      expect(JSON.parse(await readFile(f.registry, "utf8")).published).toEqual(["1.0.0"]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test("waits for the accepted version and latest tag to become queryable", async () => {
    const f = await fixture();
    try {
      const result = run(f, { mode: "lagged" });
      expect(result.status).toBe(0);
      const state = JSON.parse(await readFile(f.registry, "utf8"));
      expect(state.published).toEqual(["1.0.0"]);
      expect(state.indexDelay).toBe(0);
      expect(state.tags.latest).toBe("1.0.0");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test("publishes a subsequent version when the package already has older releases", async () => {
    const f = await fixture();
    try {
      await writeFile(
        f.registry,
        JSON.stringify({ versions: ["0.9.0"], tags: { latest: "0.9.0" }, published: [] }),
      );
      expect(run(f).status).toBe(0);
      const state = JSON.parse(await readFile(f.registry, "utf8"));
      expect(state.tags.latest).toBe("1.0.0");
      expect(state.published).toEqual(["1.0.0"]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test("rejects an existing stable version under a different latest dist-tag", async () => {
    const f = await fixture();
    try {
      await writeFile(
        f.registry,
        JSON.stringify({ versions: ["1.0.0"], tags: { latest: "0.9.0" }, published: [] }),
      );
      const result = run(f);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("must be published under latest");
      expect(await Bun.file(f.output).exists()).toBe(false);
      expect(JSON.parse(await readFile(f.registry, "utf8")).published).toEqual([]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test("rejects registry lookup errors instead of assuming a version is missing", async () => {
    const f = await fixture();
    try {
      const result = run(f, { mode: "unavailable" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("npm view failed");
      expect(JSON.parse(await readFile(f.registry, "utf8")).published).toEqual([]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test("rejects a mismatching registry version", async () => {
    const f = await fixture();
    try {
      await writeFile(
        f.registry,
        JSON.stringify({ versions: ["1.0.0"], tags: { latest: "1.0.0" }, published: [] }),
      );
      const result = run(f, { mode: "wrong-version" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Unexpected registry version");
      expect(JSON.parse(await readFile(f.registry, "utf8")).published).toEqual([]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test("rejects prerelease refs and mismatched manifest versions before publishing", async () => {
    const f = await fixture();
    try {
      expect(run(f, { ref: "v1.0.0-rc.1" }).status).not.toBe(0);
      await writeFile(join(f.root, "package.json"), JSON.stringify({ version: "1.1.0" }));
      const result = run(f);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Root version 1.1.0 differs from package version 1.0.0");
      expect(JSON.parse(await readFile(f.registry, "utf8")).published).toEqual([]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
