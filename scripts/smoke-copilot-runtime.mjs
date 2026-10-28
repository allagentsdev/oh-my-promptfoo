import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";

const expectedSdkVersion = process.argv[2];
if (!expectedSdkVersion || process.argv.length !== 3)
  throw new Error("Usage: node smoke-copilot-runtime.mjs <expected SDK version>");

test("the published Copilot SDK starts its declared bundled runtime", {
  timeout: 30_000,
}, async (t) => {
  const sdk = JSON.parse(await readFile("node_modules/@github/copilot-sdk/package.json", "utf8"));
  assert.equal(sdk.version, expectedSdkVersion, "installed SDK must match the public peer");
  assert.equal(typeof sdk.copilotCliVersion, "string");
  assert.notEqual(sdk.copilotCliVersion, "");
  const directory = await mkdtemp(join(tmpdir(), "copilot-runtime-smoke-"));
  let client;
  t.after(
    async () => {
      try {
        await client?.forceStop();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    { timeout: 5_000 },
  );
  const environment = {
    HOME: directory,
    USERPROFILE: directory,
    TMPDIR: directory,
    TEMP: directory,
    TMP: directory,
  };
  for (const name of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"])
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  client = new CopilotClient({
    connection: RuntimeConnection.forStdio({ env: environment }),
    workingDirectory: directory,
    baseDirectory: join(directory, "copilot"),
    useLoggedInUser: false,
    logLevel: "error",
  });
  await client.start();
  const status = await client.getStatus();
  assert.ok(Number.isInteger(status.protocolVersion) && status.protocolVersion > 0);
  assert.equal(
    status.version,
    sdk.copilotCliVersion,
    "bundled runtime must match the SDK declaration",
  );
  const message = randomUUID();
  const reply = await client.ping(message);
  assert.equal(typeof reply.message, "string");
  assert.ok(reply.message.includes(message), "ping must round-trip through the real runtime");
  assert.equal(reply.protocolVersion, status.protocolVersion);
  assert.deepEqual(await client.stop(), [], "runtime must stop without cleanup errors");
  await assert.rejects(client.ping(message), "a stopped runtime must not accept another RPC");
  console.log(
    `Copilot SDK ${sdk.version} / runtime ${status.version} / protocol ${status.protocolVersion} passed`,
  );
});
