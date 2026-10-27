import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { npmCommand } from "./npm-command";

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
  const [file, argv] = npmCommand(command, args);
  const result = spawnSync(file, argv, { cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function compileDeclarations(cwd: string) {
  const consumer = `
const agent: Providers.Agent = new Providers.Agent();
const copilot: Providers.CopilotSdk = new Providers.CopilotSdk();
const options: Providers.CallOptions = {abortSignal: new AbortController().signal};
const agentConfig: Providers.AgentConfig = {delegate: {id: 'copilot-sdk'}, workspace: {sources: []}};
const selectedConfig: Providers.AgentConfig = {delegate: {id: 'copilot-sdk'}, workspace: {fromVar: 'fixture', variants: {empty: {sources: []}}}};
const copilotConfig: Providers.CopilotSdkConfig = {working_dir: '.'};
const agentId: string = agent.id();
const reply: Promise<unknown> = agent.callApi('prompt', undefined, options);
const copilotReply: Promise<unknown> = copilot.callApi('prompt', undefined, options);
const rubric: Assertions.LlmAssertConfig = {components: [{metric: 'quality', value: 'Check answer'}]};
const assertion: Promise<unknown> = Assertions.llmAssert('answer', {config: rubric});
const agentAssertion: Promise<unknown> = Assertions.agentAssert('answer');
const selector: Assertions.ToolAssertionConfig = {name: {regex: '^read$'}, argumentsMatch: {path: '/path', regex: 'README'}, before: {name: 'write'}};
const called: unknown = Assertions['tool-called']('answer', {config: selector});
const absent: unknown = Assertions['tool-not-called']('answer', {config: selector});
const skillAbsent: unknown = Assertions['skill-not-loaded']('answer', {config: {name: 'demo'}});
const fallbackConfig: Providers.FallbackConfig = {providers: ['openai:example'], cooldownMs: 0};
const fallback = new Providers.Fallback({config: fallbackConfig});
const fallbackId: string = fallback.id();
const fallbackReply: Promise<unknown> = fallback.callApi('prompt');
const responsesConfig: Providers.CopilotModelConfig = {model: 'gpt-6-sol', reasoning_effort: 'low', response_format: {type: 'json_object'}};
const responses: Providers.CopilotModel = new Providers.CopilotModel({config: responsesConfig});
const responsesId: string = responses.id();
const responsesReply: Promise<unknown> = responses.callApi('prompt');
const endpointClient = (): Providers.CopilotEndpointClient => Providers.createCopilotEndpointClient({token: 'token'});
const endpoint = (client: Providers.CopilotEndpointClient): Promise<Providers.CopilotEndpoint> => client.endpoint('gpt-6-sol');
// @ts-expect-error The package root exports no providers.
const rootAgent = Root.Agent;
// @ts-expect-error Reasoning effort is low, medium or high.
const invalidResponses: Providers.CopilotModelConfig = {model: 'gpt-6-sol', reasoning_effort: 'extreme'};
// @ts-expect-error An AbortSignal, not a string, is required.
const invalidOptions: Providers.CallOptions = {abortSignal: 'invalid'};
// @ts-expect-error A rubric metric must be named with a string.
const invalidComponent: Assertions.RubricComponent = {metric: 42, value: 'Check answer'};
// @ts-expect-error The fallback chain must be a list.
const invalidFallback: Providers.FallbackConfig = {providers: 'invalid'};
`;
  for (const [extension, imports] of [
    [
      "mts",
      `import * as Root from 'oh-my-promptfoo';
import * as Assertions from 'oh-my-promptfoo/assertions';
import * as Providers from 'oh-my-promptfoo/providers';`,
    ],
    [
      "cts",
      `import Root = require('oh-my-promptfoo');
import Assertions = require('oh-my-promptfoo/assertions');
import Providers = require('oh-my-promptfoo/providers');`,
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
// Consumer smokes compare paths with process.cwd(), which is already canonical: macOS
// tmpdir() is under the /var -> /private/var symlink and Windows may use 8.3 names.
const temp = await mkdtemp(join(realpathSync.native(tmpdir()), "allagents-pack-"));
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
    "dist/mcp-launcher.js",
    "dist/copilot-endpoint-worker.js",
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
      `import * as Root from 'oh-my-promptfoo';
import * as Providers from 'oh-my-promptfoo/providers';
import{createRequire}from'node:module';
import{readFileSync,statSync}from'node:fs';
const require=createRequire(import.meta.url);
const c=require('oh-my-promptfoo/providers');
for(const entry of [Providers,c])if(Object.keys(entry).sort().join()!=='Agent,CopilotModel,CopilotSdk,Fallback,createCopilotEndpointClient')throw Error('Provider entry exports '+Object.keys(entry));
if(Object.keys(Root).length||Object.keys(require('oh-my-promptfoo')).length)throw Error('The package root exports values');
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
import * as InventoryAssertions from 'oh-my-promptfoo/assertions';
import {assertions as nativeAssertions} from 'promptfoo';
import {Fallback as EsmFallback} from 'oh-my-promptfoo/providers';
const require=createRequire(import.meta.url);
const c=require('oh-my-promptfoo/assertions');
const cp=require('oh-my-promptfoo/providers');
for(const entry of [InventoryAssertions,c]){
  const gated=entry.withAssertions({defaultTest:{threshold:0.1,assert:[
    {type:'equals',value:'ready',required:true,metric:'gate',weight:20},
    {type:'javascript',value:'0.6',metric:'quality'},
  ]}}).defaultTest;
  for(const [output,pass] of [['ready',true],['blocked',false]]){
    const grade=await nativeAssertions.runAssertions({test:gated,assertScoringFunction:gated.assertScoringFunction,providerResponse:{output}});
    assert.equal(grade.pass,pass);
    assert.equal(grade.score,pass?0.6:0);
    assert.equal(grade.namedScores.quality,0.6);
    if(!pass)assert.match(grade.reason,/Required assertion veto/);
  }
  const complete={schemaVersion:1,status:'complete',incompleteReasons:[],calls:[],skillInventory:'sdk',loadedSkills:[]};
  const context={config:{name:'forbidden'},providerResponse:{metadata:{toolInventory:complete}}};
  assert.equal(entry['tool-not-called']('answer',context).pass,true);
  assert.equal(entry['tool-called']('answer',context).pass,false);
  assert.equal(entry['skill-not-loaded']('answer',context).pass,true);
  for(const name of ['tool-called','tool-not-called','skill-not-loaded']){
    const grade=entry[name]('answer',{...context,providerResponse:{metadata:{toolInventory:{...complete,status:'incomplete',incompleteReasons:['missing-tool-completion']}}}});
    assert.equal(grade.pass,false);assert.equal(grade.metadata.graderError,true);
  }
}
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
for(const Fallback of [EsmFallback,cp.Fallback]){
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
for(const [assertion,Fallback] of [[llmAssert,EsmFallback],[llmAssert,cp.Fallback],[c.llmAssert,EsmFallback],[c.llmAssert,cp.Fallback]]){
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
      join(cwd, "copilot-model-smoke.mjs"),
      `import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
process.env.PROMPTFOO_DISABLE_TELEMETRY='1';
process.env.PROMPTFOO_DISABLE_UPDATE='1';
delete process.env.GH_TOKEN;
const {loadApiProvider}=await import('promptfoo');
const {CopilotModel,createCopilotEndpointClient}=await import('oh-my-promptfoo/providers');
const require=createRequire(import.meta.url);
const cp=require('oh-my-promptfoo/providers');
for(const value of [CopilotModel,cp.CopilotModel,createCopilotEndpointClient,cp.createCopilotEndpointClient])assert.equal(typeof value,'function');
assert.equal(CopilotModel,cp.CopilotModel,'ESM and CJS builds share one provider and SDK worker');
const id='package:oh-my-promptfoo/providers:CopilotModel';
const config={model:'gpt-6-sol',reasoning_effort:'low',response_format:{type:'json_object'}};
const provider=await loadApiProvider(id,{basePath:process.cwd(),options:{config}});
assert.equal(provider.id(),'copilot:gpt-6-sol');
assert.deepEqual(JSON.parse(JSON.stringify(provider)),{id:'copilot:gpt-6-sol',config});
await assert.rejects(provider.callApi('prompt'),/GH_TOKEN/);
await provider.cleanup();
await assert.rejects(loadApiProvider(id,{basePath:process.cwd(),options:{config:{model:'gpt-6-sol',apiBaseUrl:'http://127.0.0.1:9'}}}),/config.apiBaseUrl/);
assert.throws(()=>createCopilotEndpointClient({token:''}),/GH_TOKEN/);
// The SDK peer and the shipped worker resolve beside the installed bundle.
const providers=require.resolve('oh-my-promptfoo/providers');
createRequire(providers).resolve('@github/copilot-sdk');
// The worker starts under Node and fails closed on a request before sign-in, without contacting Copilot.
const child=fork(join(dirname(providers),'copilot-endpoint-worker.js'),[],{stdio:['ignore','ignore','ignore','ipc'],serialization:'advanced'});
const exited=new Promise(resolve=>child.once('exit',resolve));
const reply=await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.send({id:1,method:'models'});});
assert.deepEqual(reply,{id:1,ok:false});
await exited;
`,
    );
    await writeFile(
      join(cwd, "package-ids-smoke.mjs"),
      `import assert from 'node:assert/strict';
import {Agent,CopilotModel,CopilotSdk,Fallback} from 'oh-my-promptfoo/providers';
process.env.PROMPTFOO_DISABLE_TELEMETRY='1';
process.env.PROMPTFOO_DISABLE_UPDATE='1';
const {loadApiProvider}=await import('promptfoo');
const load=(id,config)=>loadApiProvider(id,{basePath:process.cwd(),options:{config}});
const source={type:'git',repository:'file:///nonexistent/repository',ref:'0'.repeat(40),destination:'project'};
const providers={
  Agent:[Agent,{delegate:{id:'copilot-sdk'},workspace:{sources:[source]}}],
  CopilotSdk:[CopilotSdk,{working_dir:'.'}],
  CopilotModel:[CopilotModel,{model:'gpt-6-sol'}],
  Fallback:[Fallback,{providers:['echo']}],
};
// Promptfoo's package: loader constructs each provider from the ./providers entry.
for(const [name,[Entity,config]] of Object.entries(providers)){
  const provider=await load('package:oh-my-promptfoo/providers:'+name,config);
  assert.ok(provider instanceof Entity,name+' resolves to the exported class');
  await provider.cleanup?.();
}
// The new names are not root exports, and the earlier root and Provider-suffixed names are
// gone; smoke.mjs checks the entry's exact export list, which rules out any other name.
const retired=['','/providers'].flatMap(entry=>['','CopilotSdk','Fallback'].map(name=>'package:oh-my-promptfoo'+entry+':'+name+'Provider'));
for(const id of [...Object.keys(providers).map(name=>'package:oh-my-promptfoo:'+name),...retired])
  await assert.rejects(load(id,{}),/Could not find entity/,id);
`,
    );
    // Promptfoo may run from a directory above the eval project, such as a repository
    // root, with no oh-my-promptfoo there: package judges resolve from the installed peer.
    const elsewhere = join(temp, `${manager.name}-elsewhere`);
    await mkdir(elsewhere);
    await writeFile(
      join(cwd, "judge-install-smoke.mjs"),
      `import assert from 'node:assert/strict';
import {llmAssert} from 'oh-my-promptfoo/assertions';
process.env.PROMPTFOO_DISABLE_TELEMETRY='1';
process.env.PROMPTFOO_DISABLE_UPDATE='1';
delete process.env.GH_TOKEN;
assert.equal(process.cwd(),${JSON.stringify(elsewhere)});
const id='package:oh-my-promptfoo/providers:CopilotModel';
const judge={id,config:{model:'gpt-6-sol',reasoning_effort:'low',response_format:{type:'json_object'}}};
const grade=provider=>llmAssert('answer',{config:{components:[{metric:'m',value:'Check answer'}]},test:{options:{provider}}});
// Each judge is constructed and asked; without a token it throws before contacting Copilot.
const fallback={id:'package:oh-my-promptfoo/providers:Fallback',config:{cooldownMs:0,providers:[judge]}};
for(const provider of [judge,{text:judge},fallback])await assert.rejects(grade(provider),/explicit GH_TOKEN/);
`,
    );
    run("node", ["smoke.mjs", "without-copilot"], cwd);
    await compileDeclarations(cwd);
    run("node", ["node_modules/oh-my-promptfoo/dist/cli.js", "--help"], cwd);
    run("node", ["assertions-smoke.mjs"], cwd);
    run(manager.command, [...manager.args, `@github/copilot-sdk@${copilotVersion}`], cwd);
    run("node", ["smoke.mjs", "with-copilot"], cwd);
    run("node", ["copilot-model-smoke.mjs"], cwd);
    run("node", ["package-ids-smoke.mjs"], cwd);
    run("node", [join(cwd, "judge-install-smoke.mjs")], elsewhere);
    run("node", ["node_modules/oh-my-promptfoo/dist/cli.js", "--help"], cwd);
    await compileDeclarations(cwd);
    run("node", [join(repo, "scripts/smoke-mcp.mjs"), cwd], cwd);
    console.log(
      `${manager.name}: ${registryVersion ? "registry" : "packed"} ${expectedVersion} provider and assertion exports, declarations, CLI, and actual Copilot SDK ${copilotVersion} passed`,
    );
  }
  console.log(`Pack surface passed: ${names.length} files, ${packed.size} compressed bytes`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
