import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

process.on("message", ({ id, method, params }) => {
  if (method !== "initialize") return;
  // A real descendant in the worker's process group, not an SDK echo server.
  const runtime = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  writeFileSync(join(params.directory, "auth-state"), "synthetic-private-state");
  writeFileSync(
    process.env.TEST_WORKER_RECORD,
    JSON.stringify({ worker: process.pid, descendant: runtime.pid, directory: params.directory }),
  );
  process.send({ id, ok: true });
});
