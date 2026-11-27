import { expect, test } from "vitest";
import { "file-read" as fileRead } from "../packages/oh-my-promptfoo/src/assertions.js";
import type { ToolCall } from "../packages/oh-my-promptfoo/src/tool-inventory.js";

const filename = "guide.md";
const read = { name: "view", arguments: { path: `docs/${filename}` } };
const bash = (command: string, success = true) => ({
  name: "bash",
  arguments: { command },
  success,
});

function grade(calls: Partial<ToolCall>[], config: unknown = { filename }, complete = true) {
  return fileRead("", {
    config,
    providerResponse: {
      metadata: {
        toolInventory: {
          schemaVersion: 1,
          status: complete ? "complete" : "incomplete",
          incompleteReasons: complete ? [] : ["session-aborted"],
          skillInventory: "sdk",
          loadedSkills: [],
          calls: calls.map((call, index) => ({
            id: `tool-${index}`,
            argumentsTruncated: false,
            startedAt: "2026-11-23T10:00:00Z",
            endedAt: "2026-11-23T10:00:01Z",
            success: true,
            ...call,
          })),
        },
      },
    },
  });
}

test.each(["view", "read", "read_file"])("matches successful %s by basename", (name) => {
  expect(grade([{ name, arguments: { path: `/workspace/docs/${filename}` } }])).toMatchObject({
    pass: true,
    score: 1,
    metadata: { matchedCallIds: ["tool-0"] },
  });
});

test.each([
  `cat 'docs with spaces/${filename}'`,
  `cd docs && cat ${filename}; ls ../tools; cat other.md`,
  `/bin/cat -- docs/${filename} | head -20`,
  `cat -n --number-nonblank docs/${filename}`,
  `cat -e docs/${filename}`,
  `exec /bin/cat docs/${filename}`,
  `exec /usr/bin/true | /usr/bin/true; cat docs/${filename}`,
  `/usr/bin/true | exec /usr/bin/true; cat docs/${filename}`,
])("recognizes a Bash file operand: %s", (command) => {
  expect(grade([bash("ls *.md"), bash(command)])).toMatchObject({
    pass: true,
    score: 1,
    metadata: { matchedCallIds: ["tool-1"] },
  });
});

test.each([
  { ...read, success: false },
  { ...read, mcpServer: "fixture" },
  { ...read, arguments: { path: `other-${filename}` } },
  bash(`cat ${filename}`, false),
  bash(`printf '%s\\n' 'cat ${filename}'`),
  bash(`echo hello # cat ${filename}`),
  bash(`cat other.md > ${filename}`),
  bash(`cat --help ${filename}`),
  bash(`cat --not-a-cat-option ${filename}; true`),
  bash(`exec /usr/bin/true; cat ${filename}`),
  bash(`false && cat ${filename}; true`),
  bash(`cd docs || cat ${filename}`),
])("does not count a failed or unrelated call: %j", (call) => {
  expect(grade([call])).toMatchObject({ pass: false, score: 0 });
});

test("reports invalid configuration and incomplete inventory as grader errors", () => {
  expect(grade([read], { filename: `docs/${filename}` })).toMatchObject({
    pass: false,
    metadata: { graderError: true },
  });
  expect(grade([read], { filename }, false)).toMatchObject({
    pass: false,
    metadata: { graderError: true },
  });
});
