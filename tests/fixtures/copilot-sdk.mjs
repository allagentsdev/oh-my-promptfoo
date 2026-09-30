import { writeFile } from "node:fs/promises";
import { join } from "node:path";
export class CopilotClient {
  constructor(options) {
    this.options = options;
    if (options.env.ALLAGENTS_GIT_TOKEN) throw Error("Source credential leaked");
  }
  async createSession(config) {
    if (config.provider && typeof config.provider !== "object")
      throw Error("Endpoint must be object");
    let callback = () => {};
    return {
      on(fn) {
        callback = fn;
        return () => {};
      },
      async sendAndWait({ prompt }) {
        if (prompt === "hang") {
          await new Promise(() => {});
        }
        callback({
          type: "tool.execution_start",
          data: { toolCallId: "write1", toolName: "write_file", arguments: { path: "result.txt" } },
        });
        await writeFile(join(config.workingDirectory, "result.txt"), prompt);
        callback({
          type: "tool.execution_complete",
          data: { toolCallId: "write1", success: true },
        });
        callback({
          type: "assistant.usage",
          data: { inputTokens: 11, outputTokens: 7, cost: 0.001 },
        });
        const content = JSON.stringify({ task: prompt, ok: true });
        callback({ type: "assistant.message", data: { content } });
        return { data: { content } };
      },
      async abort() {},
      async disconnect() {},
    };
  }
  async stop() {
    return [];
  }
  async forceStop() {}
}
