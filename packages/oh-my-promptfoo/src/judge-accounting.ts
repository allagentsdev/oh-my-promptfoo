import { AsyncLocalStorage } from "node:async_hooks";
import {
  type CopilotAccounting,
  copilotUsageValue,
  readCopilotAccounting,
  safeCount,
  safeMultiplier,
} from "./copilot-accounting.js";

export interface JudgeAttemptAccounting {
  cached: boolean;
  accounting?: CopilotAccounting;
}

export interface JudgeAccountingLedger {
  version: 1;
  attempts: JudgeAttemptAccounting[];
}

interface JudgeFailureEvidence {
  error: unknown;
  ledger: JudgeAccountingLedger;
  usage: Record<string, number>;
}

// Providers and assertions are independently bundled in ESM and CJS. Share only the
// async context; each invocation owns its evidence, never the thrown value.
const failureKey = Symbol.for("oh-my-promptfoo.JudgeFailureContext");
const shared = globalThis as typeof globalThis & {
  [failureKey]?: AsyncLocalStorage<JudgeFailureContext>;
};
shared[failureKey] ??= new AsyncLocalStorage<JudgeFailureContext>();
const failureContexts = shared[failureKey];

export class JudgeFailureContext {
  evidence?: JudgeFailureEvidence;

  forError(error: unknown): JudgeFailureEvidence | undefined {
    return this.evidence && Object.is(this.evidence.error, error) ? this.evidence : undefined;
  }

  run<T>(request: () => Promise<T>): Promise<T> {
    return failureContexts.run(this, request);
  }
}

/** Carry a native-only permanent failure to an enclosing judge without wrapping it. */
export function preserveJudgeFailure(evidence: JudgeFailureEvidence): void {
  const context = failureContexts.getStore();
  if (context) context.evidence = evidence;
}

/** Diagnostics must not replace a throwing provider's original failure. */
export function judgeFailureMessage(error: unknown): string {
  try {
    const message = error instanceof Error ? error.message : String(error);
    if (typeof message === "string" && message.trim()) return message;
  } catch {
    // Opaque thrown values need not support string coercion.
  }
  return "Judge execution failed";
}

const MAX_ATTEMPTS = 1024;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface ReplyAccounting {
  attempts: JudgeAttemptAccounting[];
  copilot: boolean;
  valid: boolean;
}

function replyAccounting(metadata: unknown, cached: boolean): ReplyAccounting {
  const invalidLedger = () => ({ attempts: [{ cached: false }], copilot: false, valid: false });
  if (!isRecord(metadata)) return { attempts: [{ cached }], copilot: false, valid: true };
  // A wrapper ledger owns its leaves. Never add its final provider snapshot again.
  if (metadata.judgeAccounting !== undefined) {
    const ledger = metadata.judgeAccounting;
    if (
      !isRecord(ledger) ||
      ledger.version !== 1 ||
      !Array.isArray(ledger.attempts) ||
      ledger.attempts.length === 0 ||
      ledger.attempts.length > MAX_ATTEMPTS
    )
      return invalidLedger();
    const attempts: JudgeAttemptAccounting[] = [];
    let copilot = false;
    let valid = true;
    for (const entry of ledger.attempts) {
      if (!isRecord(entry) || typeof entry.cached !== "boolean") return invalidLedger();
      const accounting = readCopilotAccounting(entry.accounting);
      if (!cached && !entry.cached) {
        copilot ||= entry.accounting !== undefined;
        valid &&= entry.accounting === undefined || accounting !== undefined;
      }
      attempts.push({ cached: cached || entry.cached, ...(accounting ? { accounting } : {}) });
    }
    return { attempts, copilot, valid };
  }
  const copilot = isRecord(metadata.copilot) ? metadata.copilot : undefined;
  const accounting = readCopilotAccounting(copilot?.accounting);
  return {
    attempts: [{ cached, ...(accounting ? { accounting } : {}) }],
    copilot: metadata.copilot !== undefined,
    valid: metadata.copilot === undefined || accounting !== undefined,
  };
}

/** One authoritative leaf ledger and a scalar only when every reply has the same known unit. */
export class JudgeAccountingCollector {
  readonly ledger: JudgeAccountingLedger = { version: 1, attempts: [] };
  private unit?: "native" | "copilot";
  private complete = true;
  private overflow = false;
  private nanoAiu = 0;
  private nativeCost = 0;
  private copilotAccountingSeen = false;

  get hasCopilotAccounting(): boolean {
    return this.copilotAccountingSeen;
  }

  record(metadata: unknown, cached = false, cost?: unknown): void {
    if (this.overflow && this.copilotAccountingSeen) return;
    const reply = replyAccounting(metadata, cached);
    this.copilotAccountingSeen ||= reply.attempts.some((leaf) => leaf.accounting !== undefined);
    if (this.overflow) return;
    if (this.ledger.attempts.length + reply.attempts.length > MAX_ATTEMPTS) {
      // A prefix would look complete to consumers. One unknown leaf fails all totals closed.
      this.ledger.attempts = [{ cached: false }];
      this.complete = false;
      this.overflow = true;
      return;
    }
    for (const attempt of reply.attempts) this.ledger.attempts.push(attempt);
    if (reply.attempts.every((attempt) => attempt.cached)) return;
    this.complete &&= reply.valid;
    const unit = reply.copilot ? "copilot" : "native";
    if (this.unit !== undefined && this.unit !== unit) this.complete = false;
    this.unit = unit;
    if (unit === "copilot") {
      for (const attempt of reply.attempts) {
        // Cached snapshots remain evidence, not new runtime spend.
        if (attempt.cached) continue;
        if (!attempt.accounting || copilotUsageValue(attempt.accounting) === undefined) {
          this.complete = false;
          continue;
        }
        this.nanoAiu += attempt.accounting.totalNanoAiu!;
        if (!safeCount(this.nanoAiu)) this.complete = false;
      }
    } else {
      // Retain native-only units, but never silently sum around a missing executed reply.
      if (!safeMultiplier(cost)) this.complete = false;
      else this.nativeCost += cost;
      if (!safeMultiplier(this.nativeCost)) this.complete = false;
    }
  }

  get cost(): number | undefined {
    if (!this.complete || this.unit === undefined) return undefined;
    return this.unit === "copilot" ? this.nanoAiu / 100_000_000_000 : this.nativeCost;
  }
}
