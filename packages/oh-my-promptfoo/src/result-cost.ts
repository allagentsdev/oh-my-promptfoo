import {
  copilotUsageValue,
  readCopilotAccounting,
  safeCount,
  safeMultiplier,
} from "./copilot-accounting.js";
import { JudgeAccountingCollector } from "./judge-accounting.js";

export const record = (value: unknown): Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};

export interface ResultCost {
  usd: number | null;
  basis: "native" | "session" | "estimate" | "cache" | null;
  unavailableReasons?: MeasurementUnavailableReason[];
}

export type MeasurementUnavailableReason =
  | "not-reported"
  | "provider-error"
  | "grader-error"
  | "evaluation-error"
  | "incomplete-accounting"
  | "pricing-unavailable";

export const unknownCost = (reason: MeasurementUnavailableReason): ResultCost => ({
  usd: null,
  basis: null,
  unavailableReasons: [reason],
});

/** Implements docs/copilot-cost-methodology.md using only prices recorded with a reply. */
export function estimateCopilotCost(
  usage: unknown,
  prices: unknown,
  model: unknown,
): number | undefined {
  const tokens = record(usage);
  const rates = record(prices);
  const details = record(tokens.completionDetails);
  const read = details.cacheReadInputTokens ?? 0;
  const write = details.cacheCreationInputTokens ?? 0;
  if (
    typeof model !== "string" ||
    !model ||
    rates.model !== model ||
    (tokens.completionDetails !== undefined &&
      (tokens.completionDetails === null ||
        typeof tokens.completionDetails !== "object" ||
        Array.isArray(tokens.completionDetails))) ||
    !safeCount(tokens.prompt) ||
    !safeCount(tokens.completion) ||
    !safeCount(read) ||
    !safeCount(write) ||
    read + write > tokens.prompt ||
    !safeCount(rates.batchSize) ||
    rates.batchSize === 0
  )
    return;
  const standard = record(rates.default);
  const long = record(rates.longContext);
  const tier =
    safeCount(standard.maxPromptTokens) &&
    standard.maxPromptTokens > 0 &&
    tokens.prompt <= standard.maxPromptTokens
      ? standard
      : safeCount(standard.maxPromptTokens) &&
          standard.maxPromptTokens > 0 &&
          tokens.numRequests === 1 &&
          safeCount(long.maxPromptTokens) &&
          long.maxPromptTokens > 0 &&
          tokens.prompt <= long.maxPromptTokens
        ? long
        : undefined;
  if (!tier || ![tier.cacheReadPrice, tier.cacheWritePrice, tier.outputPrice].every(safeMultiplier))
    return;
  const remainder = tokens.prompt - read - write;
  if (write > 0 && remainder > 0 && !safeMultiplier(tier.inputPrice)) return;
  const input =
    write > 0
      ? write * tier.cacheWritePrice + remainder * (tier.inputPrice ?? 0)
      : (tokens.prompt - read) * tier.cacheWritePrice;
  const usd =
    (input + read * tier.cacheReadPrice + tokens.completion * tier.outputPrice) /
    (rates.batchSize * 100);
  return safeMultiplier(usd) ? usd : undefined;
}

/** Result-row cost is zero-filled upstream; only the original response establishes a measurement. */
export function responseCost(value: unknown, model: unknown, failed = false): ResultCost {
  const reply = record(value);
  const metadata = record(reply.metadata);
  const unknown = unknownCost(
    failed ? "grader-error" : reply.error ? "provider-error" : "not-reported",
  );
  if (failed) return unknown;
  // An authoritative attempt ledger takes precedence over the answering snapshot.
  if (metadata.judgeAccounting !== undefined) {
    const collector = new JudgeAccountingCollector();
    collector.record(metadata, reply.cached === true, reply.cost);
    if (collector.cost !== undefined)
      return { usd: collector.cost, basis: collector.hasCopilotAccounting ? "session" : "native" };
    const ledger = record(metadata.judgeAccounting);
    if (
      ledger.version === 1 &&
      ledger.copilotAccountingSeen === undefined &&
      Array.isArray(ledger.attempts) &&
      ledger.attempts.length > 0 &&
      ledger.attempts.length <= 1024 &&
      ledger.attempts.every((attempt: unknown) => record(attempt).cached === true)
    )
      return { usd: 0, basis: "cache" };
    // Token pricing can cover complete non-session attempts, including retries. An
    // unknown session or a partly cached batch cannot be reconstructed from summed tokens.
    if (
      ledger.version !== 1 ||
      ledger.copilotAccountingSeen !== undefined ||
      !Array.isArray(ledger.attempts) ||
      !ledger.attempts.length ||
      ledger.attempts.length > 1024 ||
      ledger.attempts.some(
        (attempt: unknown) =>
          record(attempt).cached !== false || record(attempt).accounting !== undefined,
      )
    )
      return unknownCost("incomplete-accounting");
  } else if (metadata.copilot !== undefined) {
    const accounting = readCopilotAccounting(record(metadata.copilot).accounting);
    const usd = accounting && copilotUsageValue(accounting);
    if (reply.cached === true) return { usd: 0, basis: "cache" };
    return usd === undefined ? unknownCost("incomplete-accounting") : { usd, basis: "session" };
  }
  if (reply.cached === true) return { usd: 0, basis: "cache" };
  if (metadata.copilotTokenPrices !== undefined) {
    const usd = estimateCopilotCost(reply.tokenUsage, metadata.copilotTokenPrices, model);
    return usd === undefined ? unknownCost("pricing-unavailable") : { usd, basis: "estimate" };
  }
  return safeMultiplier(reply.cost) ? { usd: reply.cost, basis: "native" } : unknown;
}

export function sumCosts(costs: ResultCost[]): ResultCost {
  if (!costs.length) return unknownCost("incomplete-accounting");
  if (costs.some((cost) => cost.usd === null))
    return {
      usd: null,
      basis: null,
      unavailableReasons: [
        ...new Set(
          costs
            .filter((cost) => cost.usd === null)
            .flatMap((cost) => cost.unavailableReasons ?? ["not-reported" as const]),
        ),
      ],
    };
  const usd = costs.reduce((sum, cost) => sum + cost.usd!, 0);
  return safeMultiplier(usd)
    ? { usd, basis: costs.some((cost) => cost.basis === "estimate") ? "estimate" : "native" }
    : unknownCost("incomplete-accounting");
}
