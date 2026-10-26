import { isDeepStrictEqual } from "node:util";
import { CapturedWorkspace, type WorkspaceContext, workspacePath } from "./captured-workspace.js";
import { closed } from "./config.js";

export interface WorkspaceFileCriterion {
  path: string;
  equals?: string;
  contains?: string;
  regex?: string | { regex: string; flags?: string };
  isJson?: boolean;
  jsonPath?: string | { path: string; equals: unknown };
  absent?: boolean;
  byteLength?: number;
  encoding?: "utf8" | "utf16le" | "ascii" | "latin1";
}
export type WorkspaceFileConfig = WorkspaceFileCriterion | { files: WorkspaceFileCriterion[] };
interface FileResult {
  pass: boolean;
  score: number;
  reason: string;
  assertion: { type: "javascript"; metric: string };
  metadata: { graderError?: true };
}
function criterion(input: unknown): WorkspaceFileCriterion {
  const value = closed(
    input,
    [
      "path",
      "equals",
      "contains",
      "regex",
      "isJson",
      "jsonPath",
      "absent",
      "byteLength",
      "encoding",
    ],
    "workspace-file criterion",
  );
  workspacePath(value.path);
  for (const key of ["equals", "contains"])
    if (value[key] !== undefined && typeof value[key] !== "string")
      throw new Error(`${key} must be a string`);
  for (const key of ["isJson", "absent"])
    if (value[key] !== undefined && typeof value[key] !== "boolean")
      throw new Error(`${key} must be boolean`);
  if (
    value.byteLength !== undefined &&
    (!Number.isSafeInteger(value.byteLength) || (value.byteLength as number) < 0)
  )
    throw new Error("byteLength must be a nonnegative integer");
  if (
    value.encoding !== undefined &&
    !["utf8", "utf16le", "ascii", "latin1"].includes(String(value.encoding))
  )
    throw new Error("Unsupported workspace-file encoding");
  if (value.absent === true && Object.keys(value).some((key) => key !== "path" && key !== "absent"))
    throw new Error("absent: true cannot be combined with content clauses");
  if (value.jsonPath !== undefined) {
    const spec =
      typeof value.jsonPath === "string"
        ? { path: value.jsonPath }
        : closed(value.jsonPath, ["path", "equals"], "jsonPath");
    segments(spec.path);
  }
  if (value.regex !== undefined) pattern(value.regex);
  return value as unknown as WorkspaceFileCriterion;
}
function segments(path: unknown): string[] {
  if (typeof path !== "string") throw new Error("jsonPath requires a string path");
  if (path === "$" || path === "") return [];
  if (path.startsWith("/")) {
    if (/~(?![01])/.test(path)) throw new Error("Invalid JSON Pointer escape");
    return path
      .slice(1)
      .split("/")
      .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  }
  const parts = path.replace(/^\$\./, "").split(".");
  if (parts.some((part) => !part || /[[\]*]/.test(part)))
    throw new Error("jsonPath accepts JSON Pointer or dotted properties, not expressions");
  return parts;
}
function pattern(value: unknown): RegExp {
  if (typeof value === "string") return new RegExp(value);
  const spec = closed(value, ["regex", "flags"], "regex");
  if (
    typeof spec.regex !== "string" ||
    (spec.flags !== undefined && typeof spec.flags !== "string")
  )
    throw new Error("regex requires a pattern and optional string flags");
  return new RegExp(spec.regex, spec.flags as string | undefined);
}
function check(file: WorkspaceFileCriterion, bytes: Buffer | undefined): string[] {
  if (file.absent === true) return bytes === undefined ? [] : ["File exists"];
  if (bytes === undefined) throw new Error(`Workspace file ${file.path} is absent`);
  const failures: string[] = [];
  if (file.byteLength !== undefined && bytes.length !== file.byteLength)
    failures.push(`Expected ${file.byteLength} bytes, got ${bytes.length}`);
  if (
    file.encoding === undefined &&
    file.equals === undefined &&
    file.contains === undefined &&
    file.regex === undefined &&
    file.isJson === undefined &&
    file.jsonPath === undefined
  )
    return failures;
  const encoding = file.encoding ?? "utf8";
  let text: string;
  try {
    if (encoding === "ascii" && bytes.some((byte) => byte > 127))
      throw new Error("non-ASCII bytes");
    text =
      encoding === "latin1" || encoding === "ascii"
        ? bytes.toString(encoding)
        : new TextDecoder(encoding === "utf16le" ? "utf-16le" : "utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(bytes);
  } catch {
    return [...failures, `File is not valid ${encoding}`];
  }
  let selected: unknown = text;
  if (file.isJson !== undefined || file.jsonPath !== undefined) {
    let parsed: unknown;
    let validJson = true;
    try {
      parsed = JSON.parse(text);
    } catch {
      validJson = false;
      if (file.isJson !== false || file.jsonPath !== undefined)
        return [...failures, "File is not valid JSON"];
    }
    if (file.isJson === false && validJson) failures.push("File is valid JSON");
    if (file.jsonPath !== undefined) {
      const spec = typeof file.jsonPath === "string" ? { path: file.jsonPath } : file.jsonPath;
      selected = parsed;
      for (const part of segments(spec.path)) {
        if (selected === null || typeof selected !== "object" || !Object.hasOwn(selected, part))
          return [...failures, `JSON field ${spec.path} is absent`];
        selected = (selected as Record<string, unknown>)[part];
      }
      if ("equals" in spec && !isDeepStrictEqual(selected, spec.equals))
        failures.push(`JSON field ${spec.path} does not equal the expected value`);
    }
  }
  if (file.equals !== undefined && selected !== file.equals)
    failures.push("Content does not equal the expected string");
  if (
    file.contains !== undefined &&
    (typeof selected !== "string" || !selected.includes(file.contains))
  )
    failures.push("Content does not contain the expected string");
  if (
    file.regex !== undefined &&
    (typeof selected !== "string" || !pattern(file.regex).test(selected))
  )
    failures.push("Content does not match the regex");
  return failures;
}

/** Deterministic file criteria, all ANDed; evidence errors never certify a pass. */
export async function workspaceFile(
  _output: unknown,
  context?: WorkspaceContext & { config?: unknown },
) {
  const componentResults: FileResult[] = [];
  try {
    const config = context?.config;
    let files: WorkspaceFileCriterion[];
    if (config && typeof config === "object" && "files" in config) {
      const spec = closed(config, ["files"], "workspace-file config");
      if (!Array.isArray(spec.files) || !spec.files.length)
        throw new Error("files must be a nonempty list");
      files = spec.files.map(criterion);
    } else files = [criterion(config)];
    if (new Set(files.map((file) => file.path)).size !== files.length)
      throw new Error("files must have unique paths");
    const workspace = new CapturedWorkspace(context);
    for (const file of files) {
      try {
        const failures = check(file, await workspace.read(file.path));
        const pass = failures.length === 0;
        componentResults.push({
          pass,
          score: pass ? 1 : 0,
          reason: failures.join("; ") || "File criteria passed",
          assertion: { type: "javascript", metric: file.path },
          metadata: {},
        });
      } catch (cause) {
        componentResults.push({
          pass: false,
          score: 0,
          reason: cause instanceof Error ? cause.message : String(cause),
          assertion: { type: "javascript", metric: file.path },
          metadata: { graderError: true },
        });
      }
    }
    const pass = componentResults.every((result) => result.pass);
    return {
      pass,
      score: pass ? 1 : 0,
      reason: pass
        ? "All workspace file criteria passed"
        : componentResults
            .filter((result) => !result.pass)
            .map((result) => `${result.assertion.metric}: ${result.reason}`)
            .join("; "),
      namedScores: Object.fromEntries(
        componentResults.map((result) => [result.assertion.metric, result.score]),
      ),
      componentResults,
      metadata: componentResults.some((result) => result.metadata.graderError)
        ? { graderError: true as const }
        : {},
    };
  } catch (cause) {
    return {
      pass: false,
      score: 0,
      reason: cause instanceof Error ? cause.message : String(cause),
      namedScores: {},
      componentResults,
      metadata: { graderError: true as const },
    };
  }
}
