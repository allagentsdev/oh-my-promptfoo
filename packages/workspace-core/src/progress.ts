import { channel } from "node:diagnostics_channel";

const progress = channel("allagents.workspace.progress");
let lastCaseIndex = 0;

export function nextCaseIndex(): number | undefined {
  if (!progress.hasSubscribers) return undefined;
  lastCaseIndex = lastCaseIndex === Number.MAX_SAFE_INTEGER ? 1 : lastCaseIndex + 1;
  return lastCaseIndex;
}

export type ProgressPhase =
  | "case-start"
  | "seed-start"
  | "seed-cache-hit"
  | "source-start"
  | "source-finished"
  | "git-fetch-start"
  | "git-fetch-finished"
  | "seed-ready"
  | "protected-copy-start"
  | "protected-copy-finished"
  | "protected-git-check-start"
  | "protected-git-check-finished"
  | "protected-stamp-start"
  | "protected-stamp-finished"
  | "workspace-ready"
  | "agent-start"
  | "agent-finished"
  | "case-finished";

/** Only ordinals and fixed labels may cross the evaluation's progress channel. */
export function publishProgress(
  phase: ProgressPhase,
  caseIndex?: number,
  sourceIndex?: number,
  sourceCount?: number,
  outcome?: "ok" | "error",
): void {
  if (!progress.hasSubscribers) return;
  const event: {
    phase: ProgressPhase;
    caseIndex?: number;
    sourceIndex?: number;
    sourceCount?: number;
    outcome?: "ok" | "error";
  } = { phase };
  if (caseIndex !== undefined && Number.isSafeInteger(caseIndex) && caseIndex >= 1)
    event.caseIndex = caseIndex;
  if (sourceIndex !== undefined && Number.isSafeInteger(sourceIndex) && sourceIndex >= 1)
    event.sourceIndex = sourceIndex;
  if (sourceCount !== undefined && Number.isSafeInteger(sourceCount) && sourceCount >= 0)
    event.sourceCount = sourceCount;
  if (outcome !== undefined) event.outcome = outcome;
  progress.publish(event);
}
