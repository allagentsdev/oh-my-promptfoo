import { channel } from "node:diagnostics_channel";
import { safeCount, safeMultiplier } from "./copilot-accounting.js";
import { type EvaluationProgress, nativeTestOutcome } from "./reporting.js";
import { record } from "./result-cost.js";

const type = "oh-my-promptfoo:completed-test";
const workspaceType = "oh-my-promptfoo:workspace-timing";

/** Observe the public provider progress channel without sending paths or raw data. */
export function beforeAll(): void {
  if (!process.send) return;
  const starts = new Map<number, number>();
  channel("allagents.workspace.progress").subscribe((input) => {
    const event = record(input);
    if (!safeCount(event.caseIndex) || event.caseIndex < 1) return;
    if (event.phase === "case-start") {
      starts.set(event.caseIndex, performance.now());
      process.send?.({ type: workspaceType, caseIndex: event.caseIndex, phase: "start" }, () => {});
    } else if (event.phase === "workspace-ready" && starts.has(event.caseIndex)) {
      const elapsedMs = performance.now() - starts.get(event.caseIndex)!;
      starts.delete(event.caseIndex);
      process.send?.(
        { type: workspaceType, caseIndex: event.caseIndex, phase: "ready", elapsedMs },
        () => {},
      );
    }
  });
}

export function readWorkspaceTiming(
  input: unknown,
): { caseIndex: number; phase: "start" | "ready"; elapsedMs?: number } | undefined {
  const value = record(input);
  if (
    value.type !== workspaceType ||
    !safeCount(value.caseIndex) ||
    value.caseIndex < 1 ||
    !["start", "ready"].includes(value.phase) ||
    (value.phase === "ready" && !safeMultiplier(value.elapsedMs))
  )
    return;
  return {
    caseIndex: value.caseIndex,
    phase: value.phase,
    ...(value.phase === "ready" ? { elapsedMs: value.elapsedMs } : {}),
  };
}

/** Promptfoo's public afterEach hook. Raw result content never enters the IPC message. */
export async function afterEach(context: { result: unknown; test?: unknown }): Promise<void> {
  if (!process.send) return;
  const row = record(context.result);
  if (!safeCount(row.testIdx) || !safeCount(row.promptIdx)) return;
  const assertions = record(context.test).assert;
  const comparisonPending =
    Array.isArray(assertions) &&
    assertions.some((assertion) => ["select-best", "max-score"].includes(record(assertion).type));
  const outcome = nativeTestOutcome(row);
  const message = {
    type,
    test: row.testIdx + 1,
    column: row.promptIdx + 1,
    status: comparisonPending && outcome !== "error" ? "pending" : outcome,
    latencyMs: safeMultiplier(row.latencyMs) ? row.latencyMs : null,
  };
  await new Promise<void>((resolve, reject) =>
    process.send!(message, (error) => (error ? reject(error) : resolve())),
  );
}

/** Ignore unrelated IPC; accept only bounded numeric identities and fixed outcomes. */
export function readProgress(input: unknown): EvaluationProgress | undefined {
  const value = record(input);
  if (
    value.type !== type ||
    !safeCount(value.test) ||
    value.test < 1 ||
    !safeCount(value.column) ||
    value.column < 1 ||
    !["pass", "fail", "error", "unknown", "pending"].includes(value.status) ||
    (value.latencyMs !== null && !safeMultiplier(value.latencyMs))
  )
    return;
  return {
    test: value.test,
    column: value.column,
    status: value.status,
    latencyMs: value.latencyMs,
  };
}
