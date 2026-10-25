import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  completedShellSkillRead,
  observedShellSkillRead,
} from "../packages/oh-my-promptfoo/src/skill-evidence";

const skill = ".agents/skills/example/SKILL.md";
const body = "---\nname: example\n---\n# Example\n\nRead the schema before proposing changes.\n";
let root: string;
let outside: string;
beforeEach(async () => {
  root = await mkdtemp(join(realpathSync.native(tmpdir()), "shell-skill-"));
  outside = join(root, "outside");
  await mkdir(join(root, "workspace", dirname(skill)), { recursive: true });
  await mkdir(join(outside, dirname(skill)), { recursive: true });
  await writeFile(join(root, "workspace", skill), body);
  await writeFile(join(outside, skill), body);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const workspace = () => join(root, "workspace");
const completion = (content = body) => ({ success: true, result: { content } });

describe("literal shell skill reads", () => {
  test.skipIf(process.platform === "win32")("credits actual POSIX cat and ls output", async () => {
    const command = `cat ${skill}; ls .agents/skills/example/`;
    const read = observedShellSkillRead("bash", { command }, workspace())!;
    const { stdout } = await promisify(execFile)("sh", ["-c", command], { cwd: workspace() });
    expect(completedShellSkillRead(read, completion(stdout), workspace())).toEqual(read.skill);
  });
  test.each([
    ["bash", `cat ${skill}`],
    ["bash", ` cat -- '${skill}' `],
    ["bash", `cat "./${skill}"`],
    ["bash", `cat ${skill}; ls .agents/skills/example/`],
    ["bash", `cat '${skill}';ls '.agents/skills/example'`],
    ["powershell", `Get-Content ${skill}`],
    ["powershell", `get-content -Raw -LiteralPath '${skill}'`],
    ["powershell", `Get-Content -Path "${skill}" -Raw`],
    ["powershell", "Get-Content .agents\\skills\\example\\SKILL.md"],
  ])("credits %s: %s with the complete returned file", (tool, command) => {
    const read = observedShellSkillRead(tool, { command }, workspace());
    expect(read).toBeDefined();
    expect(
      completedShellSkillRead(read!, completion(`Output:\n${body}\nSKILL.md\n`), workspace()),
    ).toEqual({ name: "example", path: join(workspace(), skill), source: "read-tool" });
  });

  test.each([".agents", ".claude", ".github"])(
    "preserves the supported %s root",
    async (parent) => {
      const path = join(workspace(), parent, "skills", "with spaces", "SKILL.md");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
      const read = observedShellSkillRead(
        "powershell",
        { command: `Get-Content -LiteralPath '${path}'` },
        workspace(),
      );
      expect(completedShellSkillRead(read!, completion(), workspace())?.path).toBe(path);
    },
  );

  test("resolves explicit cwd and absolute arguments inside the workspace", () => {
    for (const args of [
      { command: "cat SKILL.md", cwd: ".agents/skills/example" },
      { command: "cat SKILL.md", cwd: dirname(join(workspace(), skill)) },
      { command: `cat '${join(workspace(), skill).replace(/\\/g, "/")}'` },
    ]) {
      const read = observedShellSkillRead("bash", args, workspace());
      expect(read).toBeDefined();
      expect(completedShellSkillRead(read!, completion(), workspace())?.path).toBe(
        join(workspace(), skill),
      );
    }
  });

  test("accepts CRLF output and files without changing the visible body", async () => {
    await writeFile(join(workspace(), skill), body.replace(/\n/g, "\r\n"));
    const read = observedShellSkillRead("bash", { command: `cat ${skill}` }, workspace());
    expect(
      completedShellSkillRead(read!, completion(body.replace(/\n/g, "\r\n")), workspace()),
    ).toBeDefined();
  });

  test.each([
    `echo cat ${skill}`,
    `printf '%s' '${skill}'`,
    `ls ${skill}`,
    `head ${skill}`,
    `cat -n ${skill}`,
    `cat ${skill} README.md`,
    `cat < ${skill}`,
    `cat ${skill} > /dev/null`,
    `cat ${skill} 2>&1`,
    `cat ${skill} | wc -l`,
    `cat ${skill} && true`,
    `false && cat ${skill}`,
    `true || cat ${skill}`,
    `cat ${skill} &`,
    `cat ${skill}; true`,
    `cat ${skill}; ls /`,
    `cat ${skill}; ls .agents/skills/example; true`,
    `cat ${skill}\ntrue`,
    `cat ${skill} # read the skill`,
    `cat '${skill}`, // unmatched quote
    `cat '.agents/'skills/example/SKILL.md`, // quote concatenation
    `cat .agents/skills/*/SKILL.md`,
    `cat $SKILL`,
    `cat $(echo ${skill})`,
    "cat `echo SKILL.md`",
    `env cat ${skill}`,
    `bash -c 'cat ${skill}'`,
    `cd .agents/skills/example; cat SKILL.md`,
    `cat .agents/skills/example/../example/SKILL.md`,
    `cat ~/.agents/skills/example/SKILL.md`,
  ])("rejects misleading or unsupported POSIX command: %s", (command) => {
    expect(observedShellSkillRead("bash", { command }, workspace())).toBeUndefined();
  });

  test.each([
    `Get-Content -TotalCount 1 ${skill}`,
    `Get-Content -Tail 1 ${skill}`,
    `Get-Content -Wait ${skill}`,
    `Get-Content -Stream foo ${skill}`,
    `Get-Content ${skill} | Select-Object -First 1`,
    `Get-Content ${skill}; Write-Output done`,
    `Get-Content ${skill},README.md`,
    `Get-Content .agents/skills/*/SKILL.md`,
    `Get-Content "${skill}:stream"`,
    `Get-Content $skill`,
    `Get-Content ${skill} -Raw -Raw`,
    `Get-Content -Path -LiteralPath ${skill}`,
    `Get-Content -Path 'FileSystem::${skill}'`,
    `"Get-Content" ${skill}`,
    `Write-Output 'Get-Content ${skill}'`,
    `cat ${skill}`,
    `gc ${skill}`,
    `powershell -Command 'Get-Content ${skill}'`,
  ])("rejects misleading or unsupported PowerShell command: %s", (command) => {
    expect(observedShellSkillRead("powershell", { command }, workspace())).toBeUndefined();
  });

  test("rejects missing, outside, non-skill, malformed and ambiguous paths", async () => {
    await mkdir(join(workspace(), "docs"));
    await writeFile(join(workspace(), "docs", "SKILL.md"), body);
    for (const args of [
      null,
      [],
      {},
      { command: [] },
      { command: `cat ${skill}`, cwd: 7 },
      { command: `cat ${skill}`, cwd: "missing" },
      { command: `cat ${skill}`, cwd: "../workspace" },
      { command: `cat '${join(workspace(), skill)}'`, cwd: outside },
      { command: `cat ${skill}`, workdir: "." },
      { command: `cat ${skill}`, working_dir: "." },
      { command: `cat ${skill}`, workingDirectory: "." },
      { command: `cat '${join(outside, skill)}'` },
      { command: "cat .agents/skills/missing/SKILL.md" },
      { command: "cat docs/SKILL.md" },
      { command: "cat .agents/skills/example" },
      { command: `cat ${" ".repeat(8192)}${skill}` },
    ])
      expect(
        observedShellSkillRead("bash", args, workspace()),
        JSON.stringify(args),
      ).toBeUndefined();
    expect(
      observedShellSkillRead("unknown-shell", { command: `cat ${skill}` }, workspace()),
    ).toBeUndefined();
  });

  test.each([
    ["empty", ""],
    ["blank", " \n\t"],
    ["oversized", "x".repeat(1024 * 1024 + 1)],
  ])("rejects %s evidence", async (_label, content) => {
    await writeFile(join(workspace(), skill), content);
    expect(
      observedShellSkillRead("bash", { command: `cat ${skill}` }, workspace()),
    ).toBeUndefined();
  });
});

describe("shell read completion evidence", () => {
  test("rejects failures, absent/partial/redacted output, UI-only output, and contradictory exit/cwd facts", () => {
    const read = observedShellSkillRead("bash", { command: `cat ${skill}` }, workspace())!;
    for (const data of [
      undefined,
      {},
      { success: true },
      { result: { content: body } },
      { ...completion(), success: false },
      { ...completion(), error: { message: "failed" } },
      completion("I read SKILL.md"),
      completion(body.slice(1)),
      completion(body.replace("schema", "******")),
      { success: true, result: { content: "truncated", detailedContent: body } },
      { ...completion(), shellExecution: { exitCode: 1 } },
      { ...completion(), shellExecution: {} },
      { success: true, result: { content: body, contents: {} } },
      ...[
        { type: "terminal", text: body }, // a still-running command has no exit code
        { type: "shell_exit", exitCode: 1 },
        { type: "terminal", exitCode: 1 },
        { type: "shell_exit", exitCode: 0, cwd: outside },
      ].map((block) => ({ success: true, result: { content: body, contents: [block] } })),
    ])
      expect(
        completedShellSkillRead(read, data, workspace()),
        JSON.stringify(data),
      ).toBeUndefined();
    expect(
      completedShellSkillRead(
        read,
        {
          ...completion(),
          shellExecution: { exitCode: 0 },
          result: {
            content: body,
            contents: [
              { type: "terminal", text: body, cwd: workspace() },
              { type: "shell_exit", exitCode: 0, cwd: workspace() },
            ],
          },
        },
        workspace(),
      ),
    ).toBeDefined();
  });

  test("rejects a failed cat followed by successful ls without the skill body", () => {
    const read = observedShellSkillRead(
      "bash",
      { command: `cat ${skill}; ls .agents/skills/example` },
      workspace(),
    )!;
    expect(
      completedShellSkillRead(read, completion("cat: permission denied\nSKILL.md\n"), workspace()),
    ).toBeUndefined();
  });

  test("rejects changed or removed files between start and completion", async () => {
    const read = observedShellSkillRead("bash", { command: `cat ${skill}` }, workspace())!;
    await writeFile(join(workspace(), skill), "changed body");
    expect(completedShellSkillRead(read, completion(), workspace())).toBeUndefined();
    await unlink(join(workspace(), skill));
    expect(completedShellSkillRead(read, completion(), workspace())).toBeUndefined();
  });

  test("rejects file symlinks at start and completion even when contents match", async () => {
    const read = observedShellSkillRead("bash", { command: `cat ${skill}` }, workspace())!;
    await unlink(join(workspace(), skill));
    await symlink(join(outside, skill), join(workspace(), skill));
    expect(
      observedShellSkillRead("bash", { command: `cat ${skill}` }, workspace()),
    ).toBeUndefined();
    expect(completedShellSkillRead(read, completion(), workspace())).toBeUndefined();
  });

  test.skipIf(process.platform === "win32")(
    "rejects symlinked ancestors/cwd and traversal, but preserves the protected working-root alias",
    async () => {
      const alias = join(workspace(), "alias");
      await symlink(dirname(join(workspace(), skill)), alias);
      expect(
        observedShellSkillRead("bash", { command: "cat SKILL.md", cwd: "alias" }, workspace()),
      ).toBeUndefined();
      expect(
        observedShellSkillRead(
          "bash",
          { command: `cat ${skill}`, cwd: "alias/../../.." },
          workspace(),
        ),
      ).toBeUndefined();
      await symlink(dirname(join(workspace(), skill)), join(workspace(), ".agents/skills/linked"));
      expect(
        observedShellSkillRead(
          "bash",
          { command: "cat .agents/skills/linked/SKILL.md" },
          workspace(),
        ),
      ).toBeUndefined();
      const rootAlias = join(root, "protected-source");
      await symlink(workspace(), rootAlias);
      const read = observedShellSkillRead("bash", { command: `cat ${skill}` }, rootAlias);
      expect(completedShellSkillRead(read!, completion(), rootAlias)?.path).toBe(
        join(rootAlias, skill),
      );
      // Verify the reference bytes also remain intact after the checks.
      expect(await readFile(join(outside, skill), "utf8")).toBe(body);
    },
  );
});
