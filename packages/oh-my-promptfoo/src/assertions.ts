import { JUDGE_LIST_ERROR, judgeName, loadJudge } from "./judge.js";
import { type BatchedRubricConfig, gradeRubric, prepareRubric } from "./rubric-contract.js";

export { type AgentRubricConfig, agentAssert } from "./agent-assert.js";
export type { BatchedRubricConfig, RubricComponent } from "./rubric-contract.js";

/** llmAssert's config: the rubric, and optionally this assertion's own judge. */
export interface LlmAssertConfig extends BatchedRubricConfig {
  /** A judge for this assertion only, in any shape `options.provider` takes. */
  provider?: unknown;
}

interface LlmAssertionContext {
  config?: LlmAssertConfig;
  vars?: Record<string, unknown>;
  /** Promptfoo merges test `options.provider`, `--grader` and `defaultTest` into this. */
  test?: { options?: { provider?: unknown }; assert?: unknown };
}

const SELF = /^package:oh-my-promptfoo\/assertions:llmAssert$/;

const MISPLACED_PROVIDER_ERROR =
  "llmAssert does not see provider: beside config: (Promptfoo does not pass it to package assertions): move it into this assertion's config.provider, or set the judge for the suite in defaultTest.options.provider, for a test in its options.provider, or for the run with --grader";

/** Whether any llmAssert entry in these assertions carries `provider:` beside `config:`. */
function misplacedProvider(assertions: unknown): boolean {
  if (!Array.isArray(assertions)) return false;
  return assertions.some(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      (("value" in entry &&
        typeof entry.value === "string" &&
        SELF.test(entry.value) &&
        "provider" in entry &&
        entry.provider !== undefined) ||
        ("assert" in entry && misplacedProvider(entry.assert))),
  );
}

/**
 * The judge, first match wins, as `llm-rubric` picks its grader: this assertion's
 * `config.provider`, then the test's `options.provider`, which Promptfoo has already
 * merged over `--grader` and `defaultTest.options.provider`. The per-assertion judge sits
 * in `config` because Promptfoo does not pass an assertion's own `provider:` to package
 * functions, so that spelling is detected only to reject it.
 */
function judgeSpec(context: LlmAssertionContext | undefined): unknown {
  if (misplacedProvider(context?.test?.assert)) throw new Error(MISPLACED_PROVIDER_ERROR);
  // Absent when falsy, as llm-rubric's `assertion.provider || test?.options?.provider`
  // reads it; any other malformed value, or a list, is rejected by loadJudge by name.
  const own = context?.config?.provider;
  if (own) return own;
  const spec = context?.test?.options?.provider;
  if (spec === undefined || spec === null || spec === "")
    throw new Error(
      "llmAssert has no judge. Set defaultTest.options.provider for the suite, a test's options.provider, or pass --grader.",
    );
  if (Array.isArray(spec)) throw new Error(JUDGE_LIST_ERROR);
  return spec;
}

/** Score all named criteria with one judge request; every criterion must pass. */
export async function llmAssert(output: unknown, context?: LlmAssertionContext) {
  const rubric = prepareRubric(output, context);
  const spec = judgeSpec(context);
  const judge = await loadJudge(spec);
  const prompt = JSON.stringify([
    { role: "system", content: rubric.system },
    { role: "user", content: rubric.user },
  ]);
  const result = await gradeRubric(rubric, prompt, async (attempt) => {
    // A provider that throws (no API key, unknown id) fails the row, as in llm-rubric.
    const response = await judge.callApi(prompt, {
      prompt: { raw: prompt, label: "llmAssert" },
      vars: context?.vars ?? {},
      // The malformed-verdict retry must not replay the cached bad reply.
      ...(attempt > 0 ? { bustCache: true } : {}),
    });
    const text =
      typeof response.output === "string"
        ? response.output
        : response.output === undefined || response.output === null
          ? undefined
          : JSON.stringify(response.output);
    return {
      ...(response.error ? { error: response.error } : { text }),
      ...(response.tokenUsage || response.cost !== undefined
        ? { usage: { ...response.tokenUsage, cost: response.cost } }
        : {}),
      cached: response.cached === true,
      metadata: response.metadata,
    };
  });
  // With judges set at four levels, the result says which one graded it.
  result.metadata.judge = judgeName(spec, judge);
  return result;
}
