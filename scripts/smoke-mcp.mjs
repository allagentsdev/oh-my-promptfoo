import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Pass an already-installed tarball consumer; this script never installs peers or
// contacts a model. The real Promptfoo provider consumes the Claude translation.
const consumer = resolve(process.argv[2] ?? ".");
const require = createRequire(join(consumer, "package.json"));
const cjsEntry = require.resolve("oh-my-promptfoo/providers");
const esm = await import(pathToFileURL(join(dirname(cjsEntry), "providers.js")).href);
const cjs = require("oh-my-promptfoo/providers");
const root = await mkdtemp(join(consumer, ".mcp-smoke-"));
try {
  for (const name of ["@github/copilot-sdk", "@anthropic-ai/claude-agent-sdk"]) {
    const directory = join(root, "node_modules", name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name, version: "0.1.0", type: "module", exports: "./index.js" }),
    );
    await copyFile(
      new URL("../tests/fixtures/mcp-consumer.mjs", import.meta.url),
      join(directory, "index.js"),
    );
  }
  await mkdir(join(root, "mocks"));
  await copyFile(
    new URL("../tests/fixtures/mock-mcp.mjs", import.meta.url),
    join(root, "mocks", "server.mjs"),
  );
  await writeFile(join(root, "mocks", "native.txt"), "native read executed");
  const repository = join(root, "mocks");
  execFileSync("git", ["init", "-q", repository]);
  execFileSync("git", ["-C", repository, "add", "--all"]);
  execFileSync("git", [
    "-C",
    repository,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "MCP fixture",
  ]);
  const ref = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  for (const [format, { Agent }] of [
    ["esm", esm],
    ["cjs", cjs],
  ]) {
    for (const id of ["copilot-sdk", "anthropic:claude-agent-sdk"]) {
      assert.throws(
        () =>
          new Agent({
            config: {
              delegate: {
                id,
                config: {
                  mcpServers: {
                    fixture: { path: "server.mjs", env: { Node_Options: "--require unsafe" } },
                  },
                },
              },
              workspace: { sources: [] },
            },
          }),
        /reserved/,
      );
      if (id === "anthropic:claude-agent-sdk")
        assert.throws(
          () =>
            new Agent({
              config: {
                delegate: {
                  id,
                  config: {
                    mcpServers: { a: { path: "server.mjs" }, a__b: { path: "server.mjs" } },
                  },
                },
                workspace: { sources: [] },
              },
            }),
          /ambiguous.*namespace/i,
        );
      const provider = new Agent({
        config: {
          basePath: root,
          delegate: {
            id,
            env: { DELEGATE_SECRET: "private-smoke-fixture" },
            config: {
              ...(id === "anthropic:claude-agent-sdk"
                ? {
                    apiKeyRequired: false,
                    custom_allowed_tools: ["Read"],
                    disallowed_tools: ["Write"],
                  }
                : {}),
              mcpServers: {
                fixture: {
                  path: ".eval-mocks/server.mjs",
                  tools: ["search_code"],
                  env: { MOCK_MODE: "canned" },
                  timeoutMs: 5000,
                },
              },
            },
          },
          workspace: {
            sources: [
              {
                type: "git",
                repository: pathToFileURL(repository).href,
                ref,
                destination: ".eval-mocks",
                permissions: "read-only",
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
        const response = await provider.callApi(
          `mcp:${JSON.stringify({ control: true, native: id === "anthropic:claude-agent-sdk" })}`,
        );
        assert.equal(response.error, undefined, `${format} ${id}: ${response.error}`);
        const output = JSON.parse(response.output);
        assert.equal(output.result, "canned code match");
        assert.deepEqual(output.env, { MOCK_MODE: "canned" });
        if (id === "anthropic:claude-agent-sdk") {
          assert.deepEqual(output.native, {
            read: "native read executed",
            write: "denied",
            edit: "denied",
          });
          assert.equal(
            existsSync(join(response.metadata.workspace.path, "native-write.txt")),
            false,
          );
        }
        assert.equal(
          existsSync(output.control.file),
          false,
          "private configuration leaked after execution",
        );
        assert.equal(output.control.args.join(" ").includes("canned"), false);
        const denied = await provider.callApi('mcp:{"tool":"restricted","bypassPermission":true}');
        assert.match(denied.error, /allow-list/);
        console.log(
          `${format} ${id}: packed contained MCP round trip, literal env and tool denial passed`,
        );
      } finally {
        await provider.cleanup();
      }
    }
  }
} finally {
  // Let the installed cache owner remove protected seeds before ordinary rm.
  const cleaned = spawnSync(
    process.execPath,
    [join(dirname(cjsEntry), "cli.js"), "cache", "prune", "--all"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ALLAGENTS_CACHE_ROOT: join(root, "cache"),
        ALLAGENTS_WORKSPACE_ROOT: join(root, "runtime"),
      },
    },
  );
  assert.equal(cleaned.status, 0, `Packed MCP cache cleanup failed: ${cleaned.stderr}`);
  await rm(root, { recursive: true, force: true });
}
