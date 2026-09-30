import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
        if (prompt.startsWith("read:")) {
          const request = JSON.parse(prompt.slice(5));
          if (request.mode !== "text-only") {
            callback({
              type: "tool.execution_start",
              data: {
                toolCallId: "read1",
                toolName: request.toolName ?? "read_file",
                arguments: { [request.argumentKey ?? "path"]: request.path },
                ...(request.mcpServerName ? { mcpServerName: request.mcpServerName } : {}),
              },
            });
            if (request.mode !== "started-only") {
              let success = false;
              if (request.mode !== "failed") {
                try {
                  await readFile(resolve(config.workingDirectory, request.path), "utf8");
                  success = true;
                } catch {
                  // A failed read still emits a completion event.
                }
              }
              callback({
                type: "tool.execution_complete",
                data: { toolCallId: "read1", success },
              });
            }
          }
          const content = request.mode === "text-only" ? "I read SKILL.md" : "read attempted";
          callback({ type: "assistant.message", data: { content } });
          return { data: { content } };
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
