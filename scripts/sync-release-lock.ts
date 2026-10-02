import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { applyEdits, modify, type ParseError, parse } from "jsonc-parser";

const workspacePath = "packages/oh-my-promptfoo";
const projectRoot = resolve(process.argv[2] ?? process.cwd());
const root = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
const manifest = JSON.parse(
  await readFile(resolve(projectRoot, workspacePath, "package.json"), "utf8"),
);
if (root.version !== manifest.version)
  throw new Error(`Root version ${root.version} differs from package version ${manifest.version}`);

const lockPath = resolve(projectRoot, "bun.lock");
const original = await readFile(lockPath, "utf8");
const errors: ParseError[] = [];
const lock = parse(original, errors, { allowTrailingComma: true });
if (errors.length) throw new Error("Cannot update an invalid Bun lockfile");
const workspace = lock.workspaces?.[workspacePath];
if (workspace?.name !== manifest.name || typeof workspace.version !== "string")
  throw new Error("Public workspace is missing from the Bun lockfile");
if (workspace.version !== manifest.version) {
  const updated = applyEdits(
    original,
    modify(original, ["workspaces", workspacePath, "version"], manifest.version, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
    }),
  );
  const updatedErrors: ParseError[] = [];
  const parsed = parse(updated, updatedErrors, { allowTrailingComma: true });
  if (updatedErrors.length || parsed.workspaces?.[workspacePath]?.version !== manifest.version)
    throw new Error("Failed to update the public workspace version in bun.lock");
  await writeFile(lockPath, updated);
}
