import { existsSync } from "node:fs";
import { setTimeout } from "node:timers/promises";

export default class CiProvider {
  constructor(options = {}) {
    this.config = options.config ?? {};
  }

  id() {
    return "ci-fixture";
  }

  async callApi(prompt, context) {
    const mode = context?.vars?.mode ?? this.config.mode;
    if (mode === "send-noise")
      process.send?.({
        type: "oh-my-promptfoo:completed-test",
        test: "PRIVATE_ANSWER",
        column: 1,
        status: "pass",
        latencyMs: 0,
      });
    if (mode === "wait-for-progress") {
      const deadline = Date.now() + 20_000;
      while (!existsSync(context.vars.releaseFile)) {
        if (Date.now() > deadline)
          throw new Error("Live progress did not release the blocked case");
        await setTimeout(25);
      }
    }
    if (mode === "throw") throw new Error("PRIVATE_TRANSPORT_REASON");
    if (mode === "error") return { error: "PRIVATE_PROVIDER_REASON" };
    if (mode === "grader-error") return { output: "PRIVATE_INVALID_GRADE" };
    return { output: prompt };
  }
}
