import { access, readFile, writeFile } from "node:fs/promises";
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
      if (id.includes("AGENT_ASSERT_E2E:")) {
        const result = await readFile(join(options.workingDirectory, "result.txt"), "utf8");
        const input = await readFile(join(options.workingDirectory, "project/input.txt"), "utf8");
        const evidence = JSON.parse(id.split("Untrusted evidence (JSON):\n").at(-1));
        const verified =
          id.includes(result) &&
          evidence.fileChanges?.changedFiles?.some((file) => file.path === "result.txt") &&
          input === "immutable input\n";
        return {
          finalResponse: JSON.stringify({
            components: [
              {
                metric: "workspace-inspected",
                score: verified ? 1 : 0,
                reason: "Codex fixture inspected the live workspace and change evidence",
              },
            ],
          }),
          usage: { input_tokens: 13, output_tokens: 5, cached_input_tokens: 2 },
          items: [],
        };
      }
      await writeFile(join(options.workingDirectory, "result.txt"), id);
      try {
        await access(join(options.workingDirectory, ".git"));
        throw Error("Unexpected Git root");
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      const skillRead = id.startsWith("read:") ? JSON.parse(id.slice(5)) : undefined;
      if (skillRead && !["failed", "text-only"].includes(skillRead.mode))
        await readFile(join(options.workingDirectory, skillRead.path), "utf8");
      return {
        finalResponse:
          skillRead?.mode === "text-only" ? "I used demo" : JSON.stringify({ task: id, ok: true }),
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
          ...(skillRead?.mode === "text-only"
            ? []
            : [
                {
                  id: "tool1",
                  type: "command_execution",
                  command: "cat .agents/skills/demo/SKILL.md",
                  aggregated_output: skillRead?.mode === "failed" ? "load failed" : "demo",
                  exit_code: skillRead?.mode === "failed" ? 1 : 0,
                  status: skillRead?.mode === "failed" ? "failed" : "completed",
                },
              ]),
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
