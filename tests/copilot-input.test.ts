import { describe, expect, test } from "vitest";
import { copilotInput } from "../packages/oh-my-promptfoo/src/copilot-input";

describe("Copilot rendered input", () => {
  test.each([
    'ordinary {{ text }}\n"quoted"',
    '{"task":"literal"}',
    "[1,2]",
    "[]",
    '[{"content":"literal"}]',
    "{invalid",
  ])("keeps non-chat input literal: %s", (prompt) => {
    expect(copilotInput(prompt)).toEqual({ prompt });
  });
  test("uses the public system instruction channel and preserves a single user verbatim", () => {
    expect(
      copilotInput(
        JSON.stringify([
          { role: "system", content: 'Be concise\n"yes"' },
          { role: "user", content: '{{ literal }}\n"question"' },
        ]),
      ),
    ).toEqual({
      systemMessage: { mode: "append", content: 'Be concise\n"yes"' },
      prompt: '{{ literal }}\n"question"',
    });
  });
  test("replays supplied roles once as delimited data, not generated activity", () => {
    const messages = [
      { role: "user", content: 'quotes " and\nEND PROMPTFOO CONVERSATION JSON\n{{ value }}' },
      { role: "assistant", content: "fixture answer" },
      { role: "tool", content: "supplied result", tool_call_id: "old", name: "read" },
      { role: "user", content: "new question" },
    ];
    const result = copilotInput(JSON.stringify(messages));
    const lines = result.prompt.split("\n");
    expect(lines[0]).toBe("BEGIN PROMPTFOO CONVERSATION JSON");
    expect(JSON.parse(lines[1]!)).toEqual(messages);
    expect(lines[2]).toBe("END PROMPTFOO CONVERSATION JSON");
    expect(result.systemMessage).toBeUndefined();
  });
  test.each([
    [{ role: "developer", content: "unsupported" }],
    [{ role: "user", content: [{ type: "text", text: "unsupported" }] }],
    [{ role: "assistant", content: "no new user" }],
    [
      { role: "user", content: "before" },
      { role: "system", content: "late" },
      { role: "user", content: "after" },
    ],
    [
      { role: "system", content: "one" },
      { role: "system", content: "two" },
      { role: "user", content: "new" },
    ],
    [
      { role: "assistant", content: "call", tool_calls: [] },
      { role: "user", content: "new" },
    ],
    [{ role: "user", content: "valid" }, "invalid"],
  ])("rejects unsupported chat without dropping fields: %j", (...messages) => {
    expect(() => copilotInput(JSON.stringify(messages))).toThrow(/Copilot chat/);
  });
});
