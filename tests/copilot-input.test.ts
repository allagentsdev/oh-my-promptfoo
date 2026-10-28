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
      { role: "assistant", content: "call", tool_calls: [] },
      { role: "user", content: "new" },
    ],
    [{ role: "user", content: "valid" }, "invalid"],
  ])("rejects unsupported chat without dropping fields: %j", (...messages) => {
    expect(() => copilotInput(JSON.stringify(messages), "chat")).toThrow(/Copilot chat/);
  });
  test.each([
    '[{"role":"admin","permissions":["read"]}]',
    '[{"role":"user"}]',
    '[{"role":"user","content":"complete"},{"role":"assistant"}]',
  ])("keeps incomplete or business role data literal in auto: %s", (prompt) => {
    expect(copilotInput(prompt)).toEqual({ prompt });
    expect(() => copilotInput(prompt, "chat")).toThrow(/Copilot chat/);
  });
  test("text bypasses even valid chat and malformed YAML exactly", () => {
    for (const prompt of [
      ' [{"role":"system","content":"data"},{"role":"user","content":"literal"}]\n',
      "- role: user\n  content: [",
    ])
      expect(copilotInput(prompt, "text")).toEqual({ prompt });
  });
  test.each([
    "ordinary text",
    "[]",
    '{"role":"user","content":"not an array"}',
    "- role: user\n  content: [",
  ])("chat requires supported input: %s", (prompt) => {
    expect(() => copilotInput(prompt, "chat")).toThrow(/Copilot chat/);
  });
  test("preserves names and consolidates every system message in encounter order", () => {
    const messages = [
      { role: "system", content: 'first\n"instruction"', name: "policy" },
      { role: "user", content: "old", name: "alice" },
      { role: "assistant", content: "reply", name: "helper" },
      { role: "system", content: "later {{ literal }}" },
      { role: "tool", content: "supplied", name: "read", tool_call_id: "old-id" },
      { role: "user", content: "new", name: "bob" },
      { role: "system", content: "last" },
    ];
    const result = copilotInput(JSON.stringify(messages), "chat");
    expect(JSON.parse(result.systemMessage!.content.split("\n")[1]!)).toEqual(
      messages.filter((m) => m.role === "system"),
    );
    expect(JSON.parse(result.prompt.split("\n")[1]!)).toEqual(
      messages.filter((m) => m.role !== "system"),
    );
  });
  test("raw YAML is literal; Promptfoo owns YAML-file rendering before this boundary", () => {
    const prompt = "- role: user\n  content: question\n";
    expect(copilotInput(prompt)).toEqual({ prompt });
    expect(() => copilotInput(prompt, "chat")).toThrow(/rendered JSON message array/);
  });
  test("a named single user is not flattened and stripped of its name", () => {
    const messages = [{ role: "user", name: "alice", content: "question" }];
    expect(JSON.parse(copilotInput(JSON.stringify(messages)).prompt.split("\n")[1]!)).toEqual(
      messages,
    );
  });
});
