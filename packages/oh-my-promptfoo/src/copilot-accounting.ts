import type { JsonObject } from "./config.js";

/** Reported session usage, not an invoice or a token-price estimate. */
export interface CopilotAccounting {
  version: 1;
  source: "session.rpc.usage.getMetrics";
  scope: "session";
  unit: "nano-AIU";
  status: "complete" | "partial" | "unavailable";
  totalNanoAiu?: number;
  reason?:
    | "unsupported"
    | "timeout"
    | "capture_failed"
    | "missing_total"
    | "invalid_total"
    | "execution_incomplete"
    | "session_not_created";
  requestedModel?: string;
  currentModel?: string;
  totalPremiumRequestCost?: number;
  totalUserRequests?: number;
}

export const safeCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const safeMultiplier = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER;

const modelId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,255}$/.test(value);

const reasons = new Set([
  "unsupported",
  "timeout",
  "capture_failed",
  "missing_total",
  "invalid_total",
  "execution_incomplete",
  "session_not_created",
]);

/** Whitelist before copying provider records into the bounded judge-attempt ledger. */
export function readCopilotAccounting(value: unknown): CopilotAccounting | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    record.source !== "session.rpc.usage.getMetrics" ||
    record.scope !== "session" ||
    record.unit !== "nano-AIU" ||
    !["complete", "partial", "unavailable"].includes(record.status as string)
  )
    return;
  if (record.totalNanoAiu !== undefined && !safeCount(record.totalNanoAiu)) return;
  if (record.status === "complete" && !safeCount(record.totalNanoAiu)) return;
  if (record.status === "unavailable" && record.totalNanoAiu !== undefined) return;
  const result: CopilotAccounting = {
    version: 1,
    source: "session.rpc.usage.getMetrics",
    scope: "session",
    unit: "nano-AIU",
    status: record.status as CopilotAccounting["status"],
  };
  if (safeCount(record.totalNanoAiu)) result.totalNanoAiu = record.totalNanoAiu;
  if (typeof record.reason === "string" && reasons.has(record.reason))
    result.reason = record.reason as CopilotAccounting["reason"];
  if (modelId(record.requestedModel)) result.requestedModel = record.requestedModel;
  if (modelId(record.currentModel)) result.currentModel = record.currentModel;
  if (safeMultiplier(record.totalPremiumRequestCost))
    result.totalPremiumRequestCost = record.totalPremiumRequestCost;
  if (safeCount(record.totalUserRequests)) result.totalUserRequests = record.totalUserRequests;
  return result;
}

export function copilotUsageValue(accounting: CopilotAccounting): number | undefined {
  return accounting.status === "complete" && safeCount(accounting.totalNanoAiu)
    ? accounting.totalNanoAiu / 100_000_000_000
    : undefined;
}

export function sessionAccounting(
  metrics: unknown,
  complete: boolean,
  requestedModel: unknown,
): CopilotAccounting {
  const data =
    metrics && typeof metrics === "object" && !Array.isArray(metrics)
      ? (metrics as Record<string, unknown>)
      : {};
  const valid = safeCount(data.totalNanoAiu);
  return readCopilotAccounting({
    version: 1,
    source: "session.rpc.usage.getMetrics",
    scope: "session",
    unit: "nano-AIU",
    status: valid ? (complete ? "complete" : "partial") : "unavailable",
    ...(valid ? { totalNanoAiu: data.totalNanoAiu } : {}),
    ...(!valid
      ? { reason: data.totalNanoAiu === undefined ? "missing_total" : "invalid_total" }
      : !complete
        ? { reason: "execution_incomplete" }
        : {}),
    requestedModel,
    currentModel: data.currentModel,
    totalPremiumRequestCost: data.totalPremiumRequestCost,
    totalUserRequests: data.totalUserRequests,
  })!;
}

/** Preserve a captured snapshot when host validation/cancellation rejects the row. */
export function copilotFailure(response: JsonObject, error: string): JsonObject | undefined {
  const metadata = response.metadata as JsonObject | undefined;
  const copilot = metadata?.copilot as JsonObject | undefined;
  const accounting = readCopilotAccounting(copilot?.accounting);
  if (!accounting) return;
  if (accounting.status === "complete") {
    accounting.status = "partial";
    accounting.reason = "execution_incomplete";
  }
  return {
    error,
    ...(response.tokenUsage === undefined ? {} : { tokenUsage: response.tokenUsage }),
    metadata: { copilot: { ...copilot, accounting } },
  };
}
