import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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

async function compileDeclarations(cwd: string) {
  const consumer = `
const DefaultProvider: typeof Providers.Provider = Providers.default;
const provider: Providers.Provider = new DefaultProvider();
const copilot: Providers.CopilotSdkProvider = new Providers.CopilotSdkProvider();
const options: Providers.CallOptions = {abortSignal: new AbortController().signal};
const providerId: string = provider.id();
const reply: Promise<unknown> = provider.callApi('prompt', undefined, options);
const copilotReply: Promise<unknown> = copilot.callApi('prompt', undefined, options);
const rubric: Assertions.LlmAssertConfig = {components: [{metric: 'quality', value: 'Check answer'}]};
const assertion: Promise<unknown> = Assertions.llmAssert('answer', {config: rubric});
const agentAssertion: Promise<unknown> = Assertions.agentAssert('answer');
const fallbackConfig: Fallbacks.FallbackProviderConfig = {providers: ['openai:example'], cooldownMs: 0};
const fallback = new Fallbacks.FallbackProvider({config: fallbackConfig});
const fallbackId: string = fallback.id();
const fallbackReply: Promise<unknown> = fallback.callApi('prompt');
// @ts-expect-error An AbortSignal, not a string, is required.
const invalidOptions: Providers.CallOptions = {abortSignal: 'invalid'};
// @ts-expect-error A rubric metric must be named with a string.
const invalidComponent: Assertions.RubricComponent = {metric: 42, value: 'Check answer'};
// @ts-expect-error The fallback chain must be a list.
const invalidFallback: Fallbacks.FallbackProviderConfig = {providers: 'invalid'};
`;
  for (const [extension, imports] of [
    [
      "mts",
      `import * as Providers from 'oh-my-promptfoo';
import * as Assertions from 'oh-my-promptfoo/assertions';
import * as Fallbacks from 'oh-my-promptfoo/providers';`,
    ],
    [
      "cts",
      `import Providers = require('oh-my-promptfoo');
import Assertions = require('oh-my-promptfoo/assertions');
import Fallbacks = require('oh-my-promptfoo/providers');`,
    ],
  ])
    await writeFile(join(cwd, `consumer.${extension}`), `${imports}\n${consumer}`);
  await writeFile(
    join(cwd, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: ["node"],
      },
      files: ["consumer.mts", "consumer.cts"],
    }),
  );
  // Use the compiler installed in this consumer, with no workspace aliases or symlinks.
  run("node", ["node_modules/typescript/bin/tsc", "--project", "tsconfig.json"], cwd);
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
    "dist/index.d.cts",
    "dist/assertions.js",
    "dist/assertions.cjs",
    "dist/assertions.d.ts",
    "dist/assertions.d.cts",
    "dist/providers.js",
    "dist/providers.cjs",
    "dist/providers.d.ts",
    "dist/providers.d.cts",
    "dist/delegate-runner.js",
    "dist/workspace-reader.js",
    "dist/cli.js",
    "LICENSE",
    "README.md",
  ])
    if (!names.includes(name)) throw new Error(`Missing packed file ${name}`);
  if (
    names.some((n: string) =>
      /(?:^|\/)(?:tests|fixtures|workspace-core)(?:\/|$)|(?:^|\/)\.env(?:\.|$)/.test(n),
    )
  )
    throw new Error("Private/test files in package");
  // tsdown splits shared code and declarations. Every emitted artifact must survive packing.
  const dist = join(repo, "packages/oh-my-promptfoo/dist");
  for (const file of await readdir(dist, { recursive: true })) {
    if (
      (await stat(join(dist, file))).isFile() &&
      !names.includes(`dist/${file.replaceAll("\\", "/")}`)
    )
      throw new Error(`Missing packed build artifact ${file}`);
  }
  const manifest = JSON.parse(await readFile("packages/oh-my-promptfoo/package.json", "utf8"));
  if (
    manifest.dependencies?.["@allagents/workspace-core"] ||
    Object.keys(manifest.exports).join() !== ".,./assertions,./providers" ||
    Object.keys(manifest.bin).length !== 1
  )
    throw new Error("Public manifest contract mismatch");
  const rootManifest = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
  const copilotVersion: string = manifest.peerDependencies["@github/copilot-sdk"];
  if (copilotVersion !== rootManifest.devDependencies["@github/copilot-sdk"])
    throw new Error("Copilot development and public peer versions differ");
  const consumerDependencies = [
    `promptfoo@${rootManifest.devDependencies.promptfoo}`,
    `typescript@${rootManifest.devDependencies.typescript}`,
    `@types/node@${rootManifest.devDependencies["@types/node"]}`,
  ];
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
      args: ["install", "--ignore-scripts", "--strict-peer-deps", "--no-audit", "--no-fund"],
    },
    {
      name: "pnpm",
      command: pnpm.command,
      args: [
        ...pnpm.prefix,
        "add",
        "--ignore-scripts",
        "--strict-peer-dependencies",
        "--config.auto-install-peers=false",
      ],
    },
    { name: "bun", command: "bun", args: ["add", "--ignore-scripts", "--omit=peer", "--exact"] },
  ]) {
    const cwd = join(temp, manager.name);
    await mkdir(cwd);
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ name: `consumer-${manager.name}`, private: true, type: "module" }),
    );
    // Install real peers in the isolated consumer; strict npm/pnpm resolution must succeed.
    run(manager.command, [...manager.args, installation, ...consumerDependencies], cwd);
    await writeFile(
      join(cwd, "smoke.mjs"),
      `import Default,{Provider,CopilotSdkProvider} from 'oh-my-promptfoo';
import{createRequire}from'node:module';
import{readFileSync,statSync}from'node:fs';
const require=createRequire(import.meta.url);
const c=require('oh-my-promptfoo');
if(Default!==Provider||c.default!==c.Provider||typeof Provider!=='function'||typeof CopilotSdkProvider!=='function'||typeof c.Provider!=='function'||typeof c.CopilotSdkProvider!=='function')throw Error('Exports');
const packageUrl=new URL('../package.json',import.meta.resolve('oh-my-promptfoo'));
const manifest=JSON.parse(readFileSync(packageUrl,'utf8'));
if(manifest.version!==${JSON.stringify(expectedVersion)})throw Error('Loaded package version mismatch');
for(const entry of Object.values(manifest.exports))for(const target of Object.values(entry))if(!statSync(new URL(target,packageUrl)).isFile())throw Error('Missing installed export '+target);
if(process.argv[2]==='without-copilot'){
  let absent=false;
  try{require.resolve('@github/copilot-sdk');}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;absent=true;}
  if(!absent)throw Error('Copilot SDK unexpectedly installed');
}else{
  const peer=JSON.parse(readFileSync('node_modules/@github/copilot-sdk/package.json','utf8'));
  if(peer.version!==${JSON.stringify(copilotVersion)})throw Error('Copilot SDK version mismatch');
  await import('@github/copilot-sdk');
}
console.log('exports and loaded version passed');`,
    );
    await writeFile(
      join(cwd, "assertions-smoke.mjs"),
      // Resolve Nunjucks through the installed Promptfoo peer, not the workspace layout.
      `import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {llmAssert,agentAssert} from 'oh-my-promptfoo/assertions';
import {FallbackProvider} from 'oh-my-promptfoo/providers';
const require=createRequire(import.meta.url);
const c=require('oh-my-promptfoo/assertions');
const cp=require('oh-my-promptfoo/providers');
assert.equal(typeof llmAssert,'function');assert.equal(typeof c.llmAssert,'function');
assert.equal(typeof agentAssert,'function');assert.equal(typeof c.agentAssert,'function');
const invalidAgent={config:{components:[],grader:{id:'copilot-sdk'}}};
for(const assertion of [agentAssert,c.agentAssert])await assert.rejects(assertion('answer',invalidAgent),/unique named components/);
process.env.PROMPTFOO_DISABLE_TEMPLATING='false';
process.env.PROMPTFOO_DISABLE_OBJECT_STRINGIFY='false';
process.env.PACKED_ASSERTION_SUBJECT='packed environment';
const requests=[];
const judge={
  id:()=>'packed-judge',
  callApi:async (prompt)=>{
    requests.push(JSON.parse(prompt));
    return {output:JSON.stringify({components:[{metric:'m',score:1,reason:'Captured packed template'}]})};
  },
};
const withJudge=context=>({...context,test:{options:{provider:judge}}});
const stub=(name,reply)=>({id:()=>name,callApi:async ()=>reply});
for(const Fallback of [FallbackProvider,cp.FallbackProvider]){
  assert.equal(typeof Fallback,'function');
  const provider=new Fallback({config:{cooldownMs:0,providers:[
    stub('down',{error:'API error: 500',metadata:{http:{status:500}}}),
    stub('up',{output:'judged'}),
  ]}});
  assert.equal(provider.handlesOwnRetries,true);
  const reply=await provider.callApi('prompt');
  assert.equal(reply.error,undefined);
  assert.equal(reply.output,'judged');
  assert.equal(reply.metadata.fallback.answeredBy,'up');
}
for(const assertion of [llmAssert,c.llmAssert]){
  await assert.rejects(assertion('answer',{config:{components:[]}}),/unique named components/);
  await assert.rejects(assertion('answer',{config:{components:[{metric:'m',value:'Check answer'}]}}),/llmAssert has no judge/);
  const unset=withJudge({config:{components:[{metric:'m',value:'{{ missing }}'}]},vars:{}});
  await assert.rejects(assertion('answer',unset),/attempted to output null or undefined value/);
  const result=await assertion('candidate answer',withJudge({
    config:{
      rubricPrompt:'Judge {{ env.PACKED_ASSERTION_SUBJECT }} {{ object }} {{ array }} {% set parsed = encoded | load %}{{ parsed.subject }}',
      components:[{metric:'m',value:'Check {{ subject }} {{ env.PACKED_ASSERTION_SUBJECT }} {% set parsed = encoded | load %}{{ parsed.subject }} {{ object.subject }} {{ array[0] }}'}],
    },
    vars:{subject:'component template',object:{subject:'object value'},array:['array value',{nested:'array object'}],encoded:JSON.stringify({subject:'loaded JSON'})},
  }));
  assert.equal(result.pass,true);
  const messages=requests.at(-1);
  assert.equal(messages[0].role,'system');
  assert.ok(messages[0].content.includes('Judge packed environment {"subject":"object value"} array value,{"nested":"array object"} loaded JSON'));
  assert.deepEqual(messages[1],{role:'user',content:'<Output>\\ncandidate answer\\n</Output>\\n<Rubric>\\n- m: Check component template packed environment loaded JSON object value array value\\n</Rubric>'});
  assert.equal(result.metadata.renderedGradingPrompt,JSON.stringify(messages));
  assert.equal(result.metadata.judge,'packed-judge');
  assert.deepEqual(result.metadata.judgeAccounting,{version:1,attempts:[{cached:false}]});
  assert.equal(result.tokensUsed?.cost,undefined);
  const before=requests.length;
  for(const config of [
    {rubricPrompt:'file://packed-rubric.txt',components:[{metric:'m',value:'Check answer'}]},
    {components:[{metric:'m',value:'file://packed-criteria.txt'}]},
  ]) await assert.rejects(assertion('answer',withJudge({config})),/config.*director|director.*config/i);
  assert.equal(requests.length,before,'file templates must fail before requesting a judge');
}
assert.equal(requests.length,2);
const measuredAccounting={version:1,source:'session.rpc.usage.getMetrics',scope:'session',unit:'nano-AIU',status:'complete',totalNanoAiu:1000000000};
for(const [assertion,Fallback] of [[llmAssert,FallbackProvider],[llmAssert,cp.FallbackProvider],[c.llmAssert,FallbackProvider],[c.llmAssert,cp.FallbackProvider]]){
  const permanent=Object.freeze(new Error('Packed permanent judge failure'));
  let backupCalls=0;
  const inner=new Fallback({config:{cooldownMs:0,providers:[
    {id:()=>'packed-native-transient',async callApi(){return {error:'API error: 503',tokenUsage:{total:3,prompt:2,completion:1,numRequests:1},metadata:{http:{status:503}}};}},
    {id:()=>'packed-native-permanent',async callApi(){throw permanent;}},
    {id:()=>'packed-native-never',async callApi(){backupCalls++;return {output:'unexpected backup'};}},
  ]}});
  let calls=0;
  const provider={id:()=>'packed-accounted-retry',async callApi(prompt,context,options){
    if(++calls===1)return {output:'not JSON',tokenUsage:{total:4,prompt:3,completion:1,numRequests:1},metadata:{copilot:{accounting:measuredAccounting}}};
    return inner.callApi(prompt,context,options);
  }};
  const result=await assertion('answer',{config:{components:[{metric:'m',value:'Check answer'}],provider}});
  assert.equal(result.pass,false);
  assert.equal(result.metadata.graderError,true);
  assert.equal(result.reason,permanent.message);
  assert.equal(result.tokensUsed.total,7);
  assert.equal(result.tokensUsed.numRequests,3);
  assert.equal(result.tokensUsed.cost,undefined);
  assert.deepEqual(result.metadata.judgeAccounting.attempts,[{cached:false,accounting:measuredAccounting},{cached:false},{cached:false}]);
  assert.equal(backupCalls,0);
}
`,
    );
    await writeFile(
      join(cwd, "workspace-reader-smoke.mjs"),
      `import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync,symlinkSync,readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
const require=createRequire(import.meta.url);
const root=join(process.cwd(),'reader-workspace');mkdirSync(root);
writeFileSync(join(root,'large.txt'),'a'.repeat(256*1024)+'bb');
writeFileSync(join(process.cwd(),'outside.txt'),'outside secret');
const protectedRoot=join(process.cwd(),'protected-source');mkdirSync(protectedRoot);
writeFileSync(join(protectedRoot,'protected.txt'),'protected source');
symlinkSync(protectedRoot,join(root,'protected-link'),'dir');
symlinkSync(join(protectedRoot,'protected.txt'),join(root,'undeclared-link'));
const requests=[
 {id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'packed-smoke',version:'1'}}},
 {method:'notifications/initialized'},
 {id:2,method:'tools/list'},
 {id:3,method:'tools/call',params:{name:'read_file',arguments:{path:'large.txt'}}},
 {id:4,method:'tools/call',params:{name:'read_file',arguments:{path:'large.txt',offset:256*1024,length:2}}},
 {id:5,method:'tools/call',params:{name:'list_directory',arguments:{path:'.',limit:1}}},
 {id:6,method:'tools/call',params:{name:'read_file',arguments:{path:'../protected.txt'}}},
 {id:7,method:'tools/call',params:{name:'read_file',arguments:{path:join(root,'large.txt')}}},
 {id:8,method:'tools/call',params:{name:'read_file',arguments:{path:'large.txt',length:256*1024+1}}},
 {id:9,method:'tools/call',params:{name:'write_file',arguments:{path:'large.txt'}}},
 {id:10,method:'tools/call',params:{name:'read_file',arguments:{path:'protected-link/protected.txt'}}},
 {id:11,method:'tools/call',params:{name:'read_file',arguments:{path:'undeclared-link'}}},
 {id:12,method:'tools/call',params:{name:'read_file',arguments:{path:join(process.cwd(),'outside.txt')}}},
];
const child=spawnSync(process.execPath,[join(dirname(require.resolve('oh-my-promptfoo')),'workspace-reader.js'),root,JSON.stringify({'protected-link':protectedRoot})],{
 input:requests.map(request=>JSON.stringify({jsonrpc:'2.0',...request})).join('\\n')+'\\n',encoding:'utf8',timeout:5000,maxBuffer:2*1024*1024,
});
assert.equal(child.status,0,child.stderr);
const replies=child.stdout.trim().split('\\n').map(line=>JSON.parse(line));assert.equal(replies.length,12);
const response=id=>replies.find(reply=>reply.id===id).result;
const value=id=>JSON.parse(response(id).content[0].text);
assert.deepEqual(response(2).tools.map(tool=>tool.name),['read_file','list_directory']);
assert.ok(response(2).tools.every(tool=>tool.annotations.readOnlyHint&&!tool.annotations.destructiveHint));
assert.equal(value(3).text.length,256*1024);assert.equal(value(3).truncated,true);assert.equal(value(3).nextOffset,256*1024);
assert.equal(value(4).text,'bb');assert.equal(value(4).truncated,false);
assert.equal(value(5).entries.length,1);assert.equal(value(5).truncated,true);
assert.equal(value(7).text,'a'.repeat(256*1024));
for(const id of [6,8,9,11,12])assert.equal(response(id).isError,true,'Unsafe workspace reader request '+id);
assert.equal(value(10).text,'protected source');assert.equal(readFileSync(join(root,'large.txt'),'utf8').length,256*1024+2);
`,
    );
    run("node", ["smoke.mjs", "without-copilot"], cwd);
    await compileDeclarations(cwd);
    run("node", ["node_modules/oh-my-promptfoo/dist/cli.js", "--help"], cwd);
    run("node", ["assertions-smoke.mjs"], cwd);
    if (manager.name === "bun") run("bun", ["assertions-smoke.mjs"], cwd);
    run("node", ["workspace-reader-smoke.mjs"], cwd);
    run(manager.command, [...manager.args, `@github/copilot-sdk@${copilotVersion}`], cwd);
    run("node", ["smoke.mjs", "with-copilot"], cwd);
    run("node", ["node_modules/oh-my-promptfoo/dist/cli.js", "--help"], cwd);
    await compileDeclarations(cwd);
    console.log(
      `${manager.name}: ${registryVersion ? "registry" : "packed"} ${expectedVersion} provider and assertion exports, declarations, CLI, and actual Copilot SDK ${copilotVersion} passed`,
    );
  }
  console.log(`Pack surface passed: ${names.length} files, ${packed.size} compressed bytes`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
