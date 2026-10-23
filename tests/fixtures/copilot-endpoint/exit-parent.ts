import { existsSync } from "node:fs";
import { join } from "node:path";
import { startCopilotEndpointClient } from "../../../packages/oh-my-promptfoo/src/copilot-endpoint.ts";

// Deliberately omit close(), just like framework-created providers that are never cleaned up.
startCopilotEndpointClient("parent-exit-fixture", join(import.meta.dirname, "exit-worker.mjs"), "");
if (process.argv[2] === "explicit-exit") {
  const timer = setInterval(() => {
    if (existsSync(process.env.TEST_WORKER_RECORD!)) {
      clearInterval(timer);
      process.exit(0);
    }
  }, 10);
}
