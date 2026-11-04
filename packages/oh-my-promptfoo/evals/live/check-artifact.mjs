import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";

/** Grade captured file contents, independently of the candidate's final answer. */
export default function checkArtifact(_output, context) {
  const changes = context?.providerResponse?.metadata?.fileChanges;
  const vars = context?.vars;
  const entry = changes?.changedFiles?.[vars?.artifact];
  if (
    changes?.status !== "complete" ||
    entry?.kind !== "file" ||
    typeof entry.content !== "string" ||
    !["json", "yaml"].includes(vars?.format) ||
    !vars?.expected
  )
    return { pass: false, score: 0, reason: "Required artifact was not captured completely" };
  try {
    const content = Buffer.from(entry.content, "base64").toString("utf8");
    const actual = vars.format === "json" ? JSON.parse(content) : parse(content);
    const pass = isDeepStrictEqual(actual, vars.expected);
    return {
      pass,
      score: pass ? 1 : 0,
      reason: pass
        ? "Artifact matches the authored contract"
        : "Artifact differs from the authored contract",
    };
  } catch {
    return { pass: false, score: 0, reason: "Artifact is not valid for its required format" };
  }
}
