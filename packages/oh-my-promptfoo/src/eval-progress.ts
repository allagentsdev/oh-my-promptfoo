import { safeCount, safeMultiplier } from "./copilot-accounting.js";
import { type EvaluationProgress, nativeTestOutcome } from "./reporting.js";
import { record } from "./result-cost.js";

const type = "oh-my-promptfoo:completed-test";

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
