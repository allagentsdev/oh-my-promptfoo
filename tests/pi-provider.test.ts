import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolve as resolveImport } from "import-meta-resolve";
import { afterEach, expect, test } from "vitest";
import { type JsonObject, object } from "../packages/oh-my-promptfoo/src/config";
import {
  type CallFrame,
  MAX_FRAME_BYTES,
  runDelegate,
} from "../packages/oh-my-promptfoo/src/protocol";
import {
  type PiModelReply,
  type PiModelRequest,
  type PiModelServer,
  startPiModelServer,
  toolResults,
} from "./fixtures/pi-model-server";

// The child imports TypeScript sources through the repository's tsx loader.
const tsx = resolveImport("tsx", import.meta.url);
const roots: string[] = [];
const servers: PiModelServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function workspace() {
  const path = await mkdtemp(join(realpathSync.native(tmpdir()), "allagents-pi-"));
  roots.push(path);
  return path;
}
async function modelServer(reply: (request: PiModelRequest, index: number) => PiModelReply) {
  const server = await startPiModelServer(reply);
  servers.push(server);
  return server;
}
function callFrame(path: string, baseUrl: string, permissions?: JsonObject): CallFrame {
  return {
    version: 1,
    type: "call",
    delegate: "pi-sdk",
    basePath: resolve("."),
    workingDir: path,
    config: {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      apiKey: "pi-local-test",
      baseUrl,
      ...(permissions ? { permissions } : {}),
    },
    prompt: "Inspect the requested workspace files.",
    context: {},
  };
}

test("Pi records successful real SDK skill reads across the staged roots and aggregates usage", async () => {
  const path = await workspace();
  const skillPaths: string[] = [];
  for (const [index, directory] of [".agents", ".claude", ".github"].entries()) {
    const skill = join(directory, "skills", `example-${index}`, "SKILL.md");
    await mkdir(join(path, directory, "skills", `example-${index}`), { recursive: true });
    await writeFile(
      join(path, skill),
      `---\nname: example-${index}\ndescription: Skill ${index}\n---\nskill-nonce-${index}\n`,
    );
    skillPaths.push(skill);
  }
  const server = await modelServer((request, index) => {
    if (index === 0) {
      assert.ok(request.tools.includes("read"));
      assert.ok(!JSON.stringify(request.system).includes("skill-nonce-"));
      return {
        tools: skillPaths.map((skill, i) => ({
          id: `read-${i}`,
          name: "read",
          args: { path: skill },
        })),
      };
    }
    const results = toolResults(request);
    assert.equal(results.length, 3);
    for (let i = 0; i < 3; i++) assert.ok(JSON.stringify(results).includes(`skill-nonce-${i}`));
    assert.ok(results.every((result) => !result.is_error));
    return { text: "verified real skill contents" };
  });
  const result = await runDelegate(callFrame(path, server.url), {}, 20_000);
  expect(result.error).toBeUndefined();
  expect(result.output).toBe("verified real skill contents");
  const calls = object(result.metadata, "metadata").skillCalls;
  expect(calls).toHaveLength(skillPaths.length);
  expect(calls).toEqual(
    expect.arrayContaining(
      skillPaths.map((skill, index) => ({
        name: `example-${index}`,
        path: join(path, skill),
        source: "read-tool",
      })),
    ),
  );
  expect(result.tokenUsage).toMatchObject({
    prompt: 32,
    completion: 14,
    total: 46,
    cached: 6,
    numRequests: 2,
  });
  expect(result.cost).toBeGreaterThan(0);
  expect(server.failures).toEqual([]);
}, 30_000);

test("Pi does not count missing, outside, or symlinked files as skill use", async () => {
  const path = await workspace();
  const outside = await workspace();
  await writeFile(join(outside, "SKILL.md"), "outside-skill-evidence");
  await mkdir(join(path, ".agents/skills/alias"), { recursive: true });
  await symlink(join(outside, "SKILL.md"), join(path, ".agents/skills/alias/SKILL.md"));
  const paths = [
    ".agents/skills/missing/SKILL.md",
    join(outside, "SKILL.md"),
    ".agents/skills/alias/SKILL.md",
  ];
  const server = await modelServer((request, index) => {
    if (index === 0)
      return {
        tools: paths.map((file, i) => ({ id: `read-${i}`, name: "read", args: { path: file } })),
      };
    const results = toolResults(request);
    assert.equal(results.length, 3);
    assert.ok(results.some((result) => result.is_error === true));
    assert.ok(JSON.stringify(results).includes("outside-skill-evidence"));
    return { text: "unqualified reads completed" };
  });
  const result = await runDelegate(callFrame(path, server.url), {}, 20_000);
  expect(result.error).toBeUndefined();
  expect(object(result.metadata, "metadata").skillCalls).toEqual([]);
  expect(server.failures).toEqual([]);
}, 30_000);

test("Pi discovery and assistant claims alone do not satisfy a skill gate", async () => {
  const path = await workspace();
  await mkdir(join(path, ".agents/skills/example"), { recursive: true });
  await writeFile(
    join(path, ".agents/skills/example/SKILL.md"),
    "---\nname: example\ndescription: Discovered example\n---\nprivate-skill-body",
  );
  const server = await modelServer((request) => {
    assert.ok(JSON.stringify(request.system).includes("Discovered example"));
    assert.ok(!JSON.stringify(request.system).includes("private-skill-body"));
    return { text: "I used example" };
  });
  const result = await runDelegate(callFrame(path, server.url), {}, 20_000);
  expect(result.output).toBe("I used example");
  expect(object(result.metadata, "metadata").skillCalls).toEqual([]);
  expect(server.failures).toEqual([]);
}, 30_000);

test("Pi denies write and shell tools by default even if the model asks for them", async () => {
  const path = await workspace();
  const server = await modelServer((request, index) => {
    if (index === 0) {
      assert.ok(!request.tools.includes("write"));
      assert.ok(!request.tools.includes("bash"));
      return {
        tools: [
          { id: "write", name: "write", args: { path: "forbidden.txt", content: "unsafe" } },
          { id: "shell", name: "bash", args: { command: "printf unsafe > forbidden-shell.txt" } },
        ],
      };
    }
    assert.equal(toolResults(request).length, 2);
    assert.ok(toolResults(request).every((result) => result.is_error === true));
    return { text: "unsafe tools denied" };
  });
  const result = await runDelegate(callFrame(path, server.url), {}, 20_000);
  expect(result.output).toBe("unsafe tools denied");
  await expect(access(join(path, "forbidden.txt"))).rejects.toThrow();
  await expect(access(join(path, "forbidden-shell.txt"))).rejects.toThrow();
  expect(server.failures).toEqual([]);
}, 30_000);

test("Pi executes explicitly allowed filesystem and shell tools in its workspace", async () => {
  const path = await workspace();
  const server = await modelServer((request, index) => {
    if (index === 0) {
      assert.ok(request.tools.includes("write"));
      assert.ok(request.tools.includes("bash"));
      return {
        tools: [
          {
            id: "write",
            name: "write",
            args: { path: "generated.txt", content: "actual Pi write" },
          },
          { id: "shell", name: "bash", args: { command: "printf 'actual Pi shell' > shell.txt" } },
        ],
      };
    }
    assert.equal(toolResults(request).length, 2);
    assert.ok(toolResults(request).every((result) => !result.is_error));
    return { text: "workspace edits completed" };
  });
  const result = await runDelegate(
    callFrame(path, server.url, { filesystem: "write", shell: "allow" }),
    {},
    20_000,
  );
  expect(result.output).toBe("workspace edits completed");
  expect(await readFile(join(path, "generated.txt"), "utf8")).toBe("actual Pi write");
  expect(await readFile(join(path, "shell.txt"), "utf8")).toBe("actual Pi shell");
  expect(server.failures).toEqual([]);
}, 30_000);

test("Pi publishes model-service authentication errors instead of a successful empty answer", async () => {
  const path = await workspace();
  const server = await modelServer(() => ({
    status: 401,
    error: "local fixture authentication refused",
  }));
  const result = await runDelegate(callFrame(path, server.url), {}, 20_000);
  expect(result.error).toMatch(/401|authentication refused/);
  expect(server.failures).toEqual([]);
}, 30_000);

test("Pi uses only explicitly supplied credential environment variables", async () => {
  const path = await workspace();
  const server = await modelServer(() => ({ text: "explicit environment credential accepted" }));
  const frame = callFrame(path, server.url);
  delete frame.config.apiKey;
  const result = await runDelegate(frame, { ANTHROPIC_API_KEY: "pi-local-test" }, 20_000);
  expect(result.error).toBeUndefined();
  expect(result.output).toBe("explicit environment credential accepted");
  expect(server.failures).toEqual([]);
}, 30_000);

test("Pi rejects unknown model selections instead of silently falling back", async () => {
  const path = await workspace();
  const frame = callFrame(path, "http://127.0.0.1:1");
  frame.config.model = "definitely-not-a-pi-model";
  await expect(runDelegate(frame, {}, 20_000)).rejects.toThrow(/Unknown Pi model/);
  frame.config.provider = "definitely-not-a-pi-provider";
  await expect(runDelegate(frame, {}, 20_000)).rejects.toThrow(/Unknown Pi provider/);
}, 30_000);

test("Pi missing optional peer errors name the supported SDK package", async () => {
  const path = await workspace();
  const frame = callFrame(path, "http://127.0.0.1:1");
  frame.basePath = path;
  await expect(runDelegate(frame, {}, 20_000)).rejects.toThrow(
    /Install @earendil-works\/pi-coding-agent@1\.3\.0/,
  );
}, 30_000);

test("Pi cancellation stops an active real SDK model request", async () => {
  const path = await workspace();
  const started = Promise.withResolvers<void>();
  const server = await modelServer(() => {
    started.resolve();
    return { hang: true };
  });
  const controller = new AbortController();
  const response = runDelegate(callFrame(path, server.url), {}, 20_000, controller.signal);
  const completion = response.then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
  const beganRequest = await Promise.race([
    started.promise.then(() => true),
    completion.then(() => false),
  ]);
  expect(beganRequest).toBe(true);
  controller.abort();
  expect(await completion).toMatchObject({ message: expect.stringMatching(/abort|cancel/i) });
}, 30_000);

test("Pi meters streaming deltas without repeatedly counting accumulated snapshots", async () => {
  const path = await workspace();
  const answer = "streamed answer ".repeat(1500);
  const server = await modelServer(() => ({ text: answer, chunkSize: 8 }));
  const result = await runDelegate(callFrame(path, server.url), {}, 20_000);
  expect(result.error).toBeUndefined();
  expect(result.output).toBe(answer);
  expect(result.tokenUsage).toMatchObject({ prompt: 16, completion: 7, total: 23, numRequests: 1 });
  expect(server.failures).toEqual([]);
}, 30_000);

test("Pi still rejects genuinely oversized streamed content", async () => {
  const path = await workspace();
  const server = await modelServer(() => ({ text: "x".repeat(MAX_FRAME_BYTES + 1) }));
  const result = await runDelegate(callFrame(path, server.url), {}, 20_000);
  expect(result.error).toMatch(/exceeds its bound/);
  expect(result.output).toBeUndefined();
}, 30_000);

test("Pi retains billed usage and observed skills when a later model request fails", async () => {
  const path = await workspace();
  await mkdir(join(path, ".agents/skills/example"), { recursive: true });
  await writeFile(
    join(path, ".agents/skills/example/SKILL.md"),
    "---\nname: example\ndescription: Example\n---\nEvidence read before transport failure.",
  );
  const server = await modelServer((_request, index) =>
    index === 0
      ? { tools: [{ id: "read", name: "read", args: { path: ".agents/skills/example/SKILL.md" } }] }
      : { status: 401, error: "second model request refused" },
  );
  const result = await runDelegate(callFrame(path, server.url), {}, 20_000);
  expect(result.error).toMatch(/401|second model request refused/);
  expect(result.tokenUsage).toMatchObject({
    prompt: 16,
    completion: 7,
    total: 23,
    cached: 3,
    numRequests: 2,
  });
  expect(result.cost).toBeGreaterThan(0);
  expect(object(result.metadata, "metadata").skillCalls).toEqual([
    {
      name: "example",
      path: join(path, ".agents/skills/example/SKILL.md"),
      source: "read-tool",
    },
  ]);
  expect(server.failures).toEqual([]);
}, 30_000);

test("Pi graders can read declared protected sources but not escaping links or workspace instructions", async () => {
  const path = await workspace();
  const protectedRoot = await workspace();
  const outside = await workspace();
  await writeFile(join(path, "AGENTS.md"), "unsafe-workspace-grader-instructions");
  await writeFile(join(path, "local.txt"), "candidate-local-evidence");
  await writeFile(join(protectedRoot, "input.txt"), "protected-source-evidence");
  await writeFile(join(outside, "private.txt"), "must-not-leak");
  await symlink(protectedRoot, join(path, "source"), "dir");
  await symlink(outside, join(path, "escape"), "dir");
  const server = await modelServer((request, index) => {
    if (index === 0) {
      assert.ok(!request.tools.includes("write") && !request.tools.includes("bash"));
      assert.ok(!JSON.stringify(request.system).includes("unsafe-workspace-grader-instructions"));
      return { tools: [{ id: "list", name: "ls", args: { path: "." } }] };
    }
    if (index === 1) {
      const listing = toolResults(request).find((result) => result.tool_use_id === "list");
      assert.ok(listing && !listing.is_error);
      assert.ok(JSON.stringify(listing).includes("local.txt"));
      assert.ok(JSON.stringify(listing).includes("source"));
      return {
        tools: [
          { id: "local", name: "read", args: { path: "local.txt" } },
          { id: "protected", name: "read", args: { path: "source/input.txt" } },
          { id: "outside", name: "read", args: { path: "escape/private.txt" } },
          { id: "outside-list", name: "ls", args: { path: "escape" } },
        ],
      };
    }
    const results = toolResults(request);
    assert.ok(JSON.stringify(results).includes("candidate-local-evidence"));
    assert.ok(JSON.stringify(results).includes("protected-source-evidence"));
    assert.ok(!JSON.stringify(results).includes("must-not-leak"));
    assert.ok(
      results.some((result) => result.tool_use_id === "outside" && result.is_error === true),
    );
    assert.ok(
      results.some((result) => result.tool_use_id === "outside-list" && result.is_error === true),
    );
    return { text: "grader read scope enforced" };
  });
  const frame = callFrame(path, server.url);
  frame.readOnly = { sourceRoots: ["source"] };
  const result = await runDelegate(frame, {}, 20_000);
  expect(result.output).toBe("grader read scope enforced");
  expect(server.failures).toEqual([]);
}, 30_000);

test("Pi guarded grader reads preserve screenshot image attachments", async () => {
  const path = await workspace();
  await writeFile(
    join(path, "screenshot.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const server = await modelServer((request, index) => {
    if (index === 0)
      return { tools: [{ id: "screenshot", name: "read", args: { path: "screenshot.png" } }] };
    assert.ok(JSON.stringify(toolResults(request)).includes('"media_type":"image/png"'));
    return { text: "screenshot inspected as image" };
  });
  const frame = callFrame(path, server.url);
  frame.readOnly = { sourceRoots: [] };
  const result = await runDelegate(frame, {}, 20_000);
  expect(result.output).toBe("screenshot inspected as image");
  expect(server.failures).toEqual([]);
}, 30_000);

test("Pi missing credentials cannot inherit ambient keys or leave private SDK storage behind", async () => {
  const path = await workspace();
  const scratch = join(path, "sdk-temp");
  await mkdir(scratch);
  const frame = callFrame(path, "http://127.0.0.1:1");
  delete frame.config.apiKey;
  const protocol = new URL("../packages/oh-my-promptfoo/src/protocol.ts", import.meta.url).href;
  const source = `
    import {readdir} from 'node:fs/promises';
    import {runDelegate} from ${JSON.stringify(protocol)};
    let error;
    try { await runDelegate(${JSON.stringify(frame)}, {}, 20000); }
    catch (failure) { error = failure.message; }
    console.log(JSON.stringify({error, entries:await readdir(process.env.TMPDIR)}));
  `;
  const child = spawn(
    process.execPath,
    ["--import", tsx, "--input-type=module", "--eval", source],
    {
      cwd: resolve("."),
      env: {
        ...process.env,
        TMPDIR: scratch,
        ANTHROPIC_API_KEY: "ambient-key-must-not-be-inherited",
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
  if (status !== 0) throw new Error(`Isolated Pi cleanup verification failed: ${stderr}`);
  const result = object(JSON.parse(stdout), "cleanup summary");
  expect(result.error).toMatch(/No Pi credentials/);
  expect(result.entries).toEqual([]);
}, 30_000);
