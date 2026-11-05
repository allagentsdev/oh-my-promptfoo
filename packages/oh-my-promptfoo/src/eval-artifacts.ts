import { readFile, writeFile } from "node:fs/promises";
import { sourceUrl } from "./eval-sources.js";
import { redact, secrets } from "./redaction.js";
import { record } from "./result-cost.js";

/** Create a credential-redacted native export for explicitly approved storage. */
export async function prepareResultArtifact(
  resultPath: string,
  destination: string,
  sensitiveValues: string[] = [],
): Promise<void> {
  const document: unknown = JSON.parse(await readFile(resultPath, "utf8"));
  if (!document || typeof document !== "object" || Array.isArray(document))
    throw new Error("A native result object is required");
  const sensitive = [
    ...sensitiveValues,
    ...secrets(
      record(document),
      Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    ),
  ]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const clean = (value: unknown): unknown => {
    if (typeof value === "string") return redact(value, sensitive);
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [redact(key, sensitive), clean(item)]),
      );
    return value;
  };
  await writeFile(destination, `${JSON.stringify(clean(document), null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
}

/** Render a link only after storage confirms the artifact was uploaded. */
export function renderResultArtifactLink(url: string, retentionDays?: number): string {
  const safe = sourceUrl(url);
  if (!safe || new URL(safe).hash)
    throw new Error("A credential-free HTTPS artifact URL is required");
  if (retentionDays !== undefined && (!Number.isSafeInteger(retentionDays) || retentionDays < 1))
    throw new Error("Artifact retention must be a positive whole number of days");
  const retention =
    retentionDays === undefined
      ? "retention follows repository settings"
      : `expires in ${retentionDays} ${retentionDays === 1 ? "day" : "days"}`;
  return `\nAgent output and judge reasons: [download the scored result](<${safe}>) (${retention}).\n`;
}
