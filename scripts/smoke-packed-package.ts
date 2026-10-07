import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const arguments_ = process.argv.slice(2);
const registryVersion = arguments_[0] === "--registry" ? arguments_[1] : undefined;
if (
  arguments_.length &&
  (arguments_.length !== 2 ||
    !registryVersion ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(registryVersion))
)
  throw new Error("Usage: smoke-packed-package.ts [--registry VERSION]");
const repo = resolve(".");
function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
const temp = await mkdtemp(join(realpathSync(tmpdir()), "allagents-pack-"));
try {
  const packed = JSON.parse(
    run(
      "npm",
      ["pack", "--json", "--pack-destination", temp],
      join(repo, "packages/oh-my-promptfoo"),
    ),
  )[0];
  const names = packed.files.map((f: { path: string }) => f.path);
  for (const name of [
    "dist/index.js",
    "dist/index.cjs",
    "dist/index.d.ts",
    "dist/assertions.js",
    "dist/assertions.cjs",
    "dist/assertions.d.ts",
    "dist/delegate-runner.js",
    "dist/cli.js",
    "LICENSE",
    "README.md",
  ])
    if (!names.includes(name)) throw new Error(`Missing packed file ${name}`);
  if (names.some((n: string) => /tests|fixtures|workspace-core|\.env/.test(n)))
    throw new Error("Private/test files in package");
  const manifest = JSON.parse(await readFile("packages/oh-my-promptfoo/package.json", "utf8"));
  if (
    manifest.dependencies?.["@allagents/workspace-core"] ||
    Object.keys(manifest.exports).join() !== ".,./assertions" ||
    Object.keys(manifest.bin).length !== 1
  )
    throw new Error("Public manifest contract mismatch");
  const tarball = join(temp, packed.filename);
  const installation = registryVersion ? `oh-my-promptfoo@${registryVersion}` : tarball;
  const expectedVersion = registryVersion ?? manifest.version;
  const pnpm =
    spawnSync("pnpm", ["--version"], { encoding: "utf8" }).status === 0
      ? { command: "pnpm", prefix: [] }
      : { command: "npx", prefix: ["--yes", "pnpm@10.28.2"] };
  for (const manager of [
    {
      name: "npm",
      command: "npm",
      args: ["install", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund"],
    },
    {
      name: "pnpm",
      command: pnpm.command,
      args: [...pnpm.prefix, "add", "--ignore-scripts", "--config.auto-install-peers=false"],
    },
    { name: "bun", command: "bun", args: ["add", "--ignore-scripts", "--omit=peer", "--exact"] },
  ]) {
    const cwd = join(temp, manager.name);
    await mkdir(cwd);
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ name: `consumer-${manager.name}`, private: true, type: "module" }),
    );
    run(manager.command, [...manager.args, installation], cwd);
    const peer = join(cwd, "node_modules/promptfoo");
    try {
      await symlink(join(repo, "node_modules/promptfoo"), peer, "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await writeFile(
      join(cwd, "smoke.mjs"),
      `import Default,{Provider,CopilotSdkProvider} from 'oh-my-promptfoo';import{createRequire}from'node:module';import{readFileSync}from'node:fs';const require=createRequire(import.meta.url);const c=require('oh-my-promptfoo');if(Default!==Provider||typeof Provider!=='function'||typeof CopilotSdkProvider!=='function'||typeof c.Provider!=='function'||typeof c.CopilotSdkProvider!=='function')throw Error('Exports');const manifest=JSON.parse(readFileSync(new URL('../package.json',import.meta.resolve('oh-my-promptfoo')),'utf8'));if(manifest.version!==${JSON.stringify(expectedVersion)})throw Error('Loaded package version mismatch');if(process.argv[2]==='without-copilot'){let absent=false;try{require.resolve('@github/copilot-sdk');}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;absent=true;}if(!absent)throw Error('Copilot SDK unexpectedly installed');}else{const peer=JSON.parse(readFileSync('node_modules/@github/copilot-sdk/package.json','utf8'));if(peer.version!=='1.0.17')throw Error('Copilot SDK version mismatch');/* The optional peer is absent in without-copilot mode, so load it only here. */await import('@github/copilot-sdk');}console.log('exports and loaded version passed');`,
    );
    await writeFile(
      join(cwd, "assertions-smoke.mjs"),
      `import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {llmAssert} from 'oh-my-promptfoo/assertions';const require=createRequire(import.meta.url);const c=require('oh-my-promptfoo/assertions');assert.equal(typeof c.llmAssert,'function');await assert.rejects(llmAssert('answer',{config:{components:[]}}),/unique named components/);await assert.rejects(c.llmAssert('answer',{config:{components:[]}}),/unique named components/);`,
    );
    run("node", ["smoke.mjs", "without-copilot"], cwd);
    run("node", ["node_modules/oh-my-promptfoo/dist/cli.js", "--help"], cwd);
    run("node", ["assertions-smoke.mjs"], cwd);
    run(manager.command, [...manager.args, "@github/copilot-sdk@1.0.17"], cwd);
    run("node", ["smoke.mjs", "with-copilot"], cwd);
    run("node", ["node_modules/oh-my-promptfoo/dist/cli.js", "--help"], cwd);
    console.log(
      `${manager.name}: ${registryVersion ? "registry" : "packed"} ${expectedVersion} provider and assertion exports, CLI, and actual Copilot SDK 1.0.17 passed`,
    );
  }
  console.log(`Pack surface passed: ${names.length} files, ${packed.size} compressed bytes`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
