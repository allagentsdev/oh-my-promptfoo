import { JUDGE_LIST_ERROR, loadJudge } from "./judge.js";
import { type BatchedRubricConfig, gradeRubric, prepareRubric } from "./rubric-contract.js";

export { type AgentRubricConfig, agentAssert } from "./agent-assert.js";
export type { BatchedRubricConfig, RubricComponent } from "./rubric-contract.js";

interface LlmAssertionContext {
  config?: BatchedRubricConfig;
  vars?: Record<string, unknown>;
  /** Promptfoo merges test `options.provider`, `--grader` and `defaultTest` into this. */
  test?: { options?: { provider?: unknown }; assert?: unknown };
}

const SELF = /^package:oh-my-promptfoo\/assertions:llmAssert$/;

const PER_ASSERTION_JUDGE_ERROR =
  "llmAssert takes no per-assertion judge: remove provider from this assertion and set the judge in defaultTest.options.provider for the suite, in a test's options.provider, or with --grader for the run";

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
 * The judge comes from suite, test or run config only, read the way Promptfoo reads it:
 * the test's `options.provider`, which Promptfoo has already merged over `--grader` and
 * `defaultTest.options.provider`. A per-assertion judge is rejected in either spelling:
 * Promptfoo does not pass `provider:` to package assertions, and `config.provider` would
 * be a second way to say the same thing.
 */
function judgeSpec(context: LlmAssertionContext | undefined): unknown {
  if (
    (context?.config && Object.hasOwn(context.config, "provider")) ||
    misplacedProvider(context?.test?.assert)
  )
    throw new Error(PER_ASSERTION_JUDGE_ERROR);
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
  const judge = await loadJudge(judgeSpec(context));
  const prompt = JSON.stringify([
    { role: "system", content: rubric.system },
    { role: "user", content: rubric.user },
  ]);
  return gradeRubric(rubric, prompt, async (attempt) => {
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
}
