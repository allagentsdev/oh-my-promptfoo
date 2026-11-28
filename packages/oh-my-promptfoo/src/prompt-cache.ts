import { safeCount } from "./copilot-accounting.js";

export interface PromptCacheUsage {
  read?: number;
  write?: number;
}

// Promptfoo's token accumulators fill absent counters with zeros. Metadata
// preserves which counters were actually reported for every request.
export function readPromptCache(metadata: unknown): PromptCacheUsage | undefined {
  const cache = (metadata as { copilotPromptCache?: PromptCacheUsage } | undefined)
    ?.copilotPromptCache;
  if (!cache) return undefined;
  const { read, write } = cache;
  return {
    ...(safeCount(read) ? { read } : {}),
    ...(safeCount(write) ? { write } : {}),
  };
}

export function sumPromptCache(
  usages: (PromptCacheUsage | undefined)[],
): PromptCacheUsage | undefined {
  const result: PromptCacheUsage = {};
  for (const key of ["read", "write"] as const) {
    let sum = 0;
    for (const usage of usages) sum += usage?.[key] ?? NaN;
    if (usages.length && safeCount(sum)) result[key] = sum;
  }
  return result.read === undefined && result.write === undefined ? undefined : result;
}
