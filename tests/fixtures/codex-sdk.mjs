import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
export class Codex {
  constructor(options) {
    this.options = options;
  }
  startThread(options) {
    if (!options.skipGitRepoCheck) throw Error("Git root bypass was not forced");
    if (this.options.env.ALLAGENTS_GIT_TOKEN || this.options.env.ALLAGENTS_ORAS_AUTH_FILE)
      throw Error("Acquisition credentials leaked");
    const task = async (prompt) => {
      const id = typeof prompt === "string" ? prompt : prompt.map((p) => p.text).join("");
      await writeFile(join(options.workingDirectory, "result.txt"), id);
      try {
        await access(join(options.workingDirectory, ".git"));
        throw Error("Unexpected Git root");
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      return {
        finalResponse: JSON.stringify({ task: id, ok: true }),
        usage: { input_tokens: 11, output_tokens: 7, cached_input_tokens: 2 },
        items: [
          {
            id: "mcp1",
            type: "mcp_tool_call",
            server: "fixture",
            tool: "probe",
            arguments: { target: "result.txt" },
            result: { ok: true },
            status: "completed",
          },
          {
            id: "tool1",
            type: "command_execution",
            command: "cat .agents/skills/demo/SKILL.md",
            aggregated_output: "demo",
            exit_code: 0,
            status: "completed",
          },
        ],
      };
    };
    return {
      id: "fixture-thread",
      run: task,
      runStreamed: async (prompt) => {
        const result = await task(prompt);
        return {
          events: (async function* () {
            yield { type: "thread.started", thread_id: "fixture-thread" };
            yield { type: "turn.started" };
            for (const item of result.items) {
              yield { type: "item.started", item: { ...item, status: "in_progress" } };
              yield { type: "item.completed", item };
            }
            yield {
              type: "item.completed",
              item: { id: "message1", type: "agent_message", text: result.finalResponse },
            };
            yield { type: "turn.completed", usage: result.usage };
          })(),
        };
      },
    };
  }
}
