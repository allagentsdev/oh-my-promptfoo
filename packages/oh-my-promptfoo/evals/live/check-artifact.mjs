import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";

// This synchronous parser/comparator makes no model requests, including on failure.
const result = (pass, reason) => ({
  pass,
  score: pass ? 1 : 0,
  reason,
  tokensUsed: { total: 0, prompt: 0, completion: 0, cached: 0, numRequests: 0, cost: 0 },
});

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
    return result(false, "Required artifact was not captured completely");
  try {
    const content = Buffer.from(entry.content, "base64").toString("utf8");
    const actual = vars.format === "json" ? JSON.parse(content) : parse(content);
    const pass = isDeepStrictEqual(actual, vars.expected);
    return result(
      pass,
      pass
        ? "Artifact matches the authored contract"
        : "Artifact differs from the authored contract",
    );
  } catch {
    return result(false, "Artifact is not valid for its required format");
  }
}
