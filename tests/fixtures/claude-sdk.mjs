import { writeFile } from "node:fs/promises";
import { join } from "node:path";
export async function* query({ prompt, options }) {
  if (options.env.ALLAGENTS_GIT_TOKEN) throw Error("Source credential leaked");
  await writeFile(join(options.cwd, "result.txt"), prompt);
  yield {
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "skill1", name: "Skill", input: { skill: "demo" } }],
    },
  };
  yield {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "skill1", content: "loaded" }] },
  };
  yield {
    type: "result",
    subtype: prompt === "native-error" ? "error_max_turns" : "success",
    result: JSON.stringify({ task: prompt, ok: true }),
    usage: { input_tokens: 11, output_tokens: 7 },
    total_cost_usd: 0.001,
    session_id: "fixture-claude",
    num_turns: 1,
    duration_ms: 2,
    duration_api_ms: 1,
  };
}
