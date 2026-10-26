import { expect, test } from "vitest";
import { toolCalled, toolNotCalled } from "../packages/oh-my-promptfoo/src/tool-assertions.js";

function context(commands: unknown[], match: unknown, before?: unknown) {
  return {
    config: {
      name: "bash",
      argumentsMatch: { path: "command", shell: true, command: match },
      ...(before ? { before } : {}),
    },
    providerResponse: {
      metadata: {
        toolInventory: {
          schemaVersion: 1,
          status: "complete",
          incompleteReasons: [],
          skillInventory: "sdk",
          loadedSkills: [],
          calls: commands.map((command, i) => ({
            id: `c${i}`,
            name: "bash",
            arguments: { command },
            argumentsTruncated: false,
            startedAt: "2026-10-26T00:00:00Z",
            endedAt: "2026-10-26T00:00:01Z",
            success: true,
          })),
        },
      },
    },
  };
}
test("shell selectors match executable tokens, not quoted data", () => {
  expect(
    toolCalled("", context(['"/usr/bin/git" pull'], { program: "git", args: ["pull"] })),
  ).toMatchObject({ pass: true });
  expect(
    toolNotCalled("", context(["printf '%s\\n' '; git pull'"], { program: "git" })),
  ).toMatchObject({ pass: true });
  expect(toolCalled("", context(["git puller"], { program: "git", args: ["pull"] }))).toMatchObject(
    { pass: false },
  );
});
test("conditional commands are visible but excluded unless explicitly requested", () => {
  const ctx = context(["false && git pull; true || git fetch"], { program: "git" });
  const result = toolNotCalled("", ctx);
  expect(result).toMatchObject({
    pass: true,
    metadata: {
      parsedCommands: [
        { callId: "c0", program: "false", conditional: false },
        { callId: "c0", program: "git", args: ["pull"], conditional: true },
        { callId: "c0", program: "true", conditional: false },
        { callId: "c0", program: "git", args: ["fetch"], conditional: true },
      ],
    },
  });
  ctx.config.argumentsMatch = {
    ...ctx.config.argumentsMatch,
    includeConditional: true,
  } as typeof ctx.config.argumentsMatch;
  expect(toolCalled("", ctx)).toMatchObject({ pass: true });
  expect(
    toolCalled(
      "",
      context(["printf foo | git pull\ngit fetch"], { program: "git", args: ["pull"] }),
    ),
  ).toMatchObject({ pass: true });
});
test.each([
  "dotnet build --framework net48",
  "dotnet build --framework=net48",
  "dotnet build -p:TargetFramework=net48",
  "dotnet build -f net48",
])("normalizes framework option tokens: %s", (command) => {
  expect(
    toolCalled("", context([command], { program: "dotnet", args: ["--framework", "net48"] })),
  ).toMatchObject({ pass: true });
});
test("unsupported syntax fails closed, even for an absence assertion", () => {
  for (const command of [
    "git $(printf pull)",
    "git `printf pull`",
    "if true; then git pull; fi",
    "git 'pull",
    "cat <<EOF\ngit pull\nEOF",
    "echo ok & git pull",
  ])
    expect(toolNotCalled("", context([command], { program: "git" }))).toMatchObject({
      pass: false,
      metadata: { graderError: true },
    });
});
test("redirects, assignments, escapes and comments preserve executable boundaries", () => {
  expect(
    toolCalled(
      "",
      context(["X=value /usr/bin/git p\\ull > log # ignored ; git fetch"], {
        program: { regex: "^git$" },
        args: ["pull"],
      }),
    ),
  ).toMatchObject({ pass: true });
  expect(toolNotCalled("", context(["echo git > pull"], { program: "git" }))).toMatchObject({
    pass: true,
  });
});

test.each(["'777'", '"777"', "\\777", '7"7"7', "77\\7", "''777"])(
  "quoted or escaped redirect-adjacent numbers remain arguments: %s",
  (mode) => {
    const ctx = context([`chmod ${mode}>log file`], { program: "chmod", args: ["777"] });
    expect(toolCalled("", ctx)).toMatchObject({
      pass: true,
      metadata: { parsedCommands: [{ program: "chmod", args: ["777", "file"] }] },
    });
    expect(toolNotCalled("", ctx)).toMatchObject({ pass: false });
  },
);
test("only unquoted adjacent numbers are redirect descriptors", () => {
  expect(
    toolNotCalled("", context(["chmod 777>log file"], { program: "chmod", args: ["777"] })),
  ).toMatchObject({
    pass: true,
    metadata: { parsedCommands: [{ program: "chmod", args: ["file"] }] },
  });
  expect(
    toolCalled("", context(["chmod 777 >log file"], { program: "chmod", args: ["777"] })),
  ).toMatchObject({ pass: true });
});
test.each(["'X=1'", '"X=1"', "X\\=1", "\\X=1", "X''=1", 'X"="1'])(
  "quoted or escaped assignment names are executable words: %s",
  (program) => {
    const command = `${program} git pull`;
    expect(toolNotCalled("", context([command], { program: "git" }))).toMatchObject({
      pass: true,
      metadata: { parsedCommands: [{ program: "X=1", args: ["git", "pull"] }] },
    });
    expect(
      toolCalled("", context([command], { program: "X=1", args: ["git", "pull"] })),
    ).toMatchObject({ pass: true });
  },
);
test.each(['X="1"', "X='1'", "X=\\1", "X='value with spaces'", "X\\\n=1"])(
  "assignment values may be quoted or escaped: %s",
  (assignment) => {
    expect(
      toolCalled("", context([`${assignment} git pull`], { program: "git", args: ["pull"] })),
    ).toMatchObject({ pass: true });
  },
);
test.each([
  "command git pull",
  "command -- git pull",
  "command -p git pull",
  "command -p -- git pull",
  "command command git pull",
  "command exec -- git pull",
  "exec git pull",
  "exec -- /usr/bin/git pull",
  "X='value' command git pull",
  '"command" git pull',
  "e\\xec git pull",
])("supported execution builtins expose their executable: %s", (command) => {
  const ctx = context([command], { program: "git", args: ["pull"] });
  expect(toolCalled("", ctx)).toMatchObject({
    pass: true,
    metadata: { parsedCommands: [{ program: "git", args: ["pull"], conditional: false }] },
  });
  expect(toolNotCalled("", ctx)).toMatchObject({ pass: false });
});
test.each(["command", "exec"])("%s operands are not assignment prefixes", (builtin) => {
  const command = `${builtin} X=1 git pull`;
  expect(toolNotCalled("", context([command], { program: "git" }))).toMatchObject({
    pass: true,
    metadata: { parsedCommands: [{ program: "X=1", args: ["git", "pull"] }] },
  });
});
test("exec operands are external executables, not another builtin dispatch", () => {
  expect(toolNotCalled("", context(["exec command git pull"], { program: "git" }))).toMatchObject({
    pass: true,
    metadata: { parsedCommands: [{ program: "command", args: ["git", "pull"] }] },
  });
});
test.each([
  "eval 'git pull'",
  "'eval' 'git pull'",
  "source ./script.sh",
  ". ./script.sh",
  "builtin eval 'git pull'",
  "command eval 'git pull'",
  "trap 'git pull' EXIT",
  "alias sync='git pull'; sync",
  "unalias sync; sync",
  "enable -f ./custom.so custom",
  "hash -p /usr/bin/git sync; sync pull",
  "bind -x 'key:git pull'",
  "fc -s",
  "command -v git",
  "command -V git",
  "command -pv git",
  "exec -a renamed git pull",
  "exec -c git pull",
  "command",
  "exec >log",
])("unmodeled builtin execution fails closed: %s", (command) => {
  for (const assertion of [toolCalled, toolNotCalled])
    expect(assertion("", context([command], { program: "git" }))).toMatchObject({
      pass: false,
      metadata: { graderError: true },
    });
});
test("builtin names in ordinary arguments do not imply execution", () => {
  expect(
    toolNotCalled("", context(["printf '%s' eval source . builtin trap"], { program: "git" })),
  ).toMatchObject({ pass: true });
});
test("builtin normalization preserves conditional and pipeline classification", () => {
  const ctx = context(["false && command git pull | exec git fetch; command git status"], {
    program: "git",
    args: ["pull"],
  });
  expect(toolNotCalled("", ctx)).toMatchObject({
    pass: true,
    metadata: {
      parsedCommands: [
        { program: "false", conditional: false },
        { program: "git", args: ["pull"], conditional: true },
        { program: "git", args: ["fetch"], conditional: true },
        { program: "git", args: ["status"], conditional: false },
      ],
    },
  });
  ctx.config.argumentsMatch = {
    ...ctx.config.argumentsMatch,
    includeConditional: true,
  } as typeof ctx.config.argumentsMatch;
  expect(toolCalled("", ctx)).toMatchObject({ pass: true });
});
test("shell before selectors use invocation order and normalized executable tokens", () => {
  const before = {
    name: "bash",
    argumentsMatch: {
      path: "command",
      shell: true,
      command: { program: "dotnet", args: ["build"] },
    },
  };
  const commands = ["command git pull", "exec dotnet build", "git fetch"];
  expect(
    toolCalled("", context(commands, { program: "git", args: ["pull"] }, before)),
  ).toMatchObject({ pass: true, metadata: { matchedCallIds: ["c0"] } });
  expect(
    toolNotCalled("", context(commands, { program: "git", args: ["fetch"] }, before)),
  ).toMatchObject({ pass: true, metadata: { matchedCallIds: [] } });
  expect(
    toolNotCalled("", context(["git pull; dotnet build"], { program: "git" }, before)),
  ).toMatchObject({ pass: true, metadata: { matchedCallIds: [] } });
});
test("conditionally excluded before references are chronology errors", () => {
  const before = {
    name: "bash",
    argumentsMatch: { path: "command", shell: true, command: { program: "dotnet" } },
  };
  const commands = ["git pull", "false && command dotnet build"];
  for (const assertion of [toolCalled, toolNotCalled])
    expect(assertion("", context(commands, { program: "git" }, before))).toMatchObject({
      pass: false,
      reason: expect.stringContaining("no observed invocation"),
      metadata: { graderError: true },
    });
  expect(
    toolCalled(
      "",
      context(
        commands,
        { program: "git" },
        {
          ...before,
          argumentsMatch: { ...before.argumentsMatch, includeConditional: true },
        },
      ),
    ),
  ).toMatchObject({ pass: true, metadata: { matchedCallIds: ["c0"] } });
});
test.each([
  { command: null },
  { command: false },
  { command: 42 },
  { command: [] },
  { command: { text: "git pull" } },
])("non-string shell command values fail closed: $command", ({ command }) => {
  for (const assertion of [toolCalled, toolNotCalled])
    expect(assertion("", context([command], { program: "git" }))).toMatchObject({
      pass: false,
      reason: expect.stringContaining("must be a string"),
      metadata: { graderError: true },
    });
});
test("missing shell command values fail closed", () => {
  const ctx = context(["git pull"], { program: "git" });
  Reflect.deleteProperty(ctx.providerResponse.metadata.toolInventory.calls[0].arguments, "command");
  for (const assertion of [toolCalled, toolNotCalled])
    expect(assertion("", ctx)).toMatchObject({
      pass: false,
      reason: expect.stringContaining("argument path is missing"),
      metadata: { graderError: true },
    });
});
test("before shell selectors also reject missing or non-string command values", () => {
  const before = {
    name: "bash",
    argumentsMatch: { path: "command", shell: true, command: { program: "dotnet" } },
  };
  const invalid = context([null], { program: "git" }, before);
  const missing = context(["dotnet build"], { program: "git" }, before);
  Reflect.deleteProperty(
    missing.providerResponse.metadata.toolInventory.calls[0].arguments,
    "command",
  );
  for (const ctx of [invalid, missing])
    for (const assertion of [toolCalled, toolNotCalled])
      expect(assertion("", ctx)).toMatchObject({ pass: false, metadata: { graderError: true } });
});
test("unmodeled execution cannot become a false absence or chronology reference", () => {
  expect(
    toolNotCalled("", context(["false && eval 'git pull'"], { program: "git" })),
  ).toMatchObject({ pass: false, metadata: { graderError: true } });
  expect(
    toolNotCalled(
      "",
      context(
        ["git pull", "source ./build.sh"],
        { program: "git" },
        {
          name: "bash",
          argumentsMatch: { path: "command", shell: true, command: { program: "dotnet" } },
        },
      ),
    ),
  ).toMatchObject({ pass: false, metadata: { graderError: true } });
});

test("builtin normalization preserves exact argument boundaries and regex selectors", () => {
  expect(
    toolNotCalled("", context(["command git 'pull all'"], { program: "git", args: ["pull"] })),
  ).toMatchObject({ pass: true });
  expect(
    toolCalled("", context(["exec git 'pull all'"], { program: "git", args: ["pull all"] })),
  ).toMatchObject({ pass: true });
  expect(
    toolCalled(
      "",
      context(["command git pull", "exec git pull"], {
        program: { regex: "^git$", flags: "g" },
        args: [{ regex: "^pull$", flags: "g" }],
        regex: { regex: "^git pull$", flags: "g" },
      }),
    ),
  ).toMatchObject({ pass: true, metadata: { matchedCallIds: ["c0", "c1"] } });
  expect(
    toolCalled(
      "",
      context(["command dotnet build -f net48"], {
        program: "dotnet",
        args: ["--framework", "net48"],
      }),
    ),
  ).toMatchObject({ pass: true });
});
