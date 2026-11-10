import { isDeepStrictEqual } from "node:util";

/** Inspect the actual captured artifact; answer claims cannot establish a finding. */
export default function checkFindings(_output, context) {
  const changes = context?.providerResponse?.metadata?.fileChanges;
  const entry = changes?.changedFiles?.["review.json"];
  let pass = false;
  try {
    if (
      changes?.status === "complete" &&
      Array.isArray(changes.deletedFiles) &&
      changes.deletedFiles.length === 0 &&
      Object.keys(changes.changedFiles).length === 1 &&
      entry?.kind === "file" &&
      typeof entry.content === "string"
    ) {
      const document = JSON.parse(Buffer.from(entry.content, "base64").toString("utf8"));
      pass =
        isDeepStrictEqual(Object.keys(document), ["findings"]) &&
        Array.isArray(document.findings) &&
        document.findings.every(
          (finding) =>
            Number.isSafeInteger(finding.line) &&
            finding.line > 0 &&
            ["summary", "reproduction", "fix"].every(
              (key) => typeof finding[key] === "string" && finding[key].trim(),
            ),
        ) &&
        isDeepStrictEqual(
          document.findings.map(({ line, severity }) => ({ line, severity })),
          context.vars.expectedFindings,
        );
    }
  } catch {}
  return {
    pass,
    score: pass ? 1 : 0,
    reason: pass ? "Finding contract satisfied" : "Finding contract not satisfied",
    tokensUsed: { total: 0, prompt: 0, completion: 0, cached: 0, numRequests: 0, cost: 0 },
  };
}
