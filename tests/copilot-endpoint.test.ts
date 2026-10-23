import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import {
  type CopilotEndpointClient,
  createCopilotEndpointClient,
  isolatedEnvironment,
  startCopilotEndpointClient,
} from "../packages/oh-my-promptfoo/src/copilot-endpoint";

const fixtures = join(import.meta.dirname, "fixtures", "copilot-endpoint");
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A client whose worker is an adversarial IPC peer selected by the token. */
function fixture(behavior: string): CopilotEndpointClient {
  const client = startCopilotEndpointClient(behavior, join(fixtures, "lifecycle-worker.mjs"), "");
  cleanups.push(() => client.close());
  return client;
}

// The worker's runtime shares its process group, which only POSIX can signal as a whole;
// parent-exit checks read /proc.
const onPosix = process.platform === "win32" ? test.skip : test;
const onLinux = process.platform === "linux" ? test : test.skip;

test("a missing explicit token fails before any SDK worker is started", () => {
  for (const token of ["", " ", "token\ncredential", null as unknown as string])
    assert.throws(() => createCopilotEndpointClient({ token }), /requires an explicit GH_TOKEN/);
});

test("the worker environment excludes alternate credentials and preloads but keeps Actions identity", () => {
  const env = isolatedEnvironment("/private", {
    GH_TOKEN: "secret",
    GITHUB_TOKEN: "secret",
    COPILOT_GITHUB_TOKEN: "secret",
    OPENAI_API_KEY: "secret",
    AZURE_OPENAI_KEY: "secret",
    NODE_OPTIONS: "--require malicious",
    NODE_PATH: "/malicious",
    GITHUB_REPOSITORY: "owner/repo",
    GITHUB_RUN_ID: "123",
    PATH: "/bin",
    HOME: "/personal",
  });
  assert.deepEqual(
    Object.keys(env).filter((key) => /TOKEN|KEY|NODE_/i.test(key)),
    [],
  );
  assert.equal(env.GITHUB_REPOSITORY, "owner/repo");
  assert.equal(env.GITHUB_RUN_ID, "123");
  assert.equal(env.HOME, "/private");
  assert.equal(env.XDG_CONFIG_HOME, join("/private", "config"));
});

onPosix("startup death rejects all concurrent consumers and close remains idempotent", async () => {
  const client = fixture("die");
  const results = await Promise.allSettled([
    client.models(),
    client.endpoint("a"),
    client.endpoint("b"),
  ]);
  assert.ok(results.every((result) => result.status === "rejected"));
  await Promise.all([client.close(), client.close()]);
  await assert.rejects(client.models(), /worker exited|client is closed/);
});

onPosix("worker death during concurrent RPC rejects every pending request", async () => {
  const client = fixture("ready");
  const results = await Promise.allSettled([
    client.models(),
    client.endpoint("a"),
    client.endpoint("b"),
  ]);
  assert.ok(results.every((result) => result.status === "rejected"));
  await client.close();
});

onPosix(
  "close interrupts stuck initialization rather than waiting for the startup deadline",
  async () => {
    const client = fixture("hang");
    const rejected = assert.rejects(client.models(), /client is closed|worker exited/);
    await client.close();
    await rejected;
  },
);

onPosix("IPC errors cannot disclose credentials or SDK stack traces", async () => {
  const client = fixture("fail-secret");
  await assert.rejects(client.endpoint("a"), (error: Error) => {
    assert.doesNotMatch(`${error.stack}`, /secret-credential|private-stack/);
    return true;
  });
});

onPosix(
  "the shutdown deadline kills a worker that ignores close and rejects startup consumers",
  {
    timeout: 12_000,
  },
  async () => {
    const client = fixture("hang-close");
    const rejected = assert.rejects(
      client.models(),
      /operation timed out|client is closed|worker exited/,
    );
    await client.close();
    await rejected;
  },
);

onPosix("the shipped worker fails closed when the SDK peer cannot load", async () => {
  const entries = process.env.OH_MY_PROMPTFOO_TEST_ENTRIES;
  assert.ok(entries, "Vitest global setup bundles the process entries");
  const client = startCopilotEndpointClient(
    "unused-token",
    join(entries, "copilot-endpoint-worker.js"),
    join(tmpdir(), "absent-copilot-sdk", "index.js"),
  );
  cleanups.push(() => client.close());
  await assert.rejects(client.endpoint("a"), (error: Error) => {
    assert.equal(error.message, "Copilot endpoint operation failed.");
    return true;
  });
  await assert.rejects(client.models(), /client is closed|worker exited|operation failed/);
});

for (const mode of ["idle", "explicit-exit"])
  onLinux(
    `${mode} parent exit kills worker descendants and removes private auth state without cleanup`,
    {
      timeout: 12_000,
    },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "copilot-parent-exit-test-"));
      const record = join(root, "record.json");
      cleanups.push(() => {
        if (existsSync(record)) {
          const { worker, directory } = JSON.parse(readFileSync(record, "utf8"));
          try {
            process.kill(-worker, "SIGKILL");
          } catch {
            // Already terminated.
          }
          rmSync(directory, { recursive: true, force: true });
        }
        rmSync(root, { recursive: true, force: true });
      });
      const parent = spawn(
        process.execPath,
        ["--import", "tsx", join(fixtures, "exit-parent.ts"), mode],
        { env: { ...process.env, TEST_WORKER_RECORD: record }, stdio: "ignore" },
      );
      cleanups.push(() => parent.kill("SIGKILL"));
      const result = await new Promise((resolve, reject) => {
        parent.once("error", reject);
        parent.once("exit", (code, signal) => resolve({ code, signal }));
      });
      assert.deepEqual(result, { code: 0, signal: null });
      const { worker, descendant, directory } = JSON.parse(readFileSync(record, "utf8"));
      assert.equal(existsSync(directory), false, "private auth state must not survive parent exit");
      const running = (pid: number) => {
        try {
          // A killed orphan may await reaping by init; zombies are not live runtimes.
          return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      };
      // Other processes' termination has no event to await here; poll the kernel briefly.
      const until = Date.now() + 2_000;
      while ((running(worker) || running(descendant)) && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(running(worker), false, "worker must terminate");
      assert.equal(running(descendant), false, "runtime descendant must terminate");
    },
  );
