import { object } from "./config.js";

type RecordValue = Record<string, unknown>;
interface Result {
  pass: boolean;
  score: number;
  reason: string;
  assertion?: { type?: string; required?: boolean; weight?: number; config?: unknown };
  componentResults?: Result[] | null;
  metadata?: RecordValue;
}
interface Aggregate {
  pass: boolean;
  score: number;
  reason: string;
  vetoReason?: string;
}
const SET_MARKER = "ohMyPromptfooRequiredSet";

/** Native diagnostics flatten children after their parent; children are not extra votes. */
function roots(results: Result[]): Result[] {
  const result: Result[] = [];
  for (let index = 0; index < results.length; index++) {
    const entry = results[index];
    result.push(entry);
    index += entry.componentResults?.length ?? 0;
  }
  return result;
}
function aggregate(results: Result[], threshold?: number): Aggregate {
  const remaining: Result[] = [];
  for (const result of roots(results)) {
    if (result.metadata?.[SET_MARKER] === true) continue;
    const set = result.metadata?.assertionSet as { threshold?: number } | undefined;
    let grade: Aggregate = result;
    let required = result.assertion?.required === true;
    if (set && result.componentResults) {
      required ||= roots(result.componentResults).some(
        (child) => child.metadata?.[SET_MARKER] === true,
      );
      grade = aggregate(result.componentResults, set.threshold);
      if (grade.vetoReason) return grade;
    }
    if (required) {
      if (!grade.pass)
        return { pass: false, score: 0, reason: grade.reason, vetoReason: grade.reason };
    } else remaining.push({ ...result, ...grade });
  }
  let numerator = 0,
    denominator = 0;
  for (const result of remaining) {
    const set = result.metadata?.assertionSet as { weight?: number } | undefined;
    const weight = result.assertion?.weight ?? set?.weight ?? 1;
    numerator += result.score * weight;
    denominator += weight;
  }
  const score = remaining.length === 0 ? 1 : denominator > 0 ? numerator / denominator : 0;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || !Number.isFinite(score))
    throw new Error("Required assertion aggregation must remain finite");
  let pass = remaining.every((result) => result.pass);
  let reason = remaining.findLast((result) => !result.pass)?.reason ?? "All assertions passed";
  if (threshold !== undefined) {
    pass = score >= threshold;
    reason = `Aggregate score ${score.toFixed(2)} ${pass ? "≥" : "<"} ${threshold} threshold`;
  }
  if (
    remaining.some(
      (result) =>
        result.assertion?.type === "guardrails" &&
        (result.assertion.config as RecordValue | undefined)?.purpose === "redteam" &&
        !result.pass,
    )
  ) {
    pass = true;
    reason = "Content failed guardrail safety checks";
  }
  return { pass, score, reason };
}
export function requiredScore(
  namedScores: Record<string, number>,
  context: { componentResults: Result[]; threshold?: number },
) {
  const result = aggregate(context.componentResults, context.threshold);
  return {
    pass: result.pass,
    score: result.score,
    reason: result.vetoReason ? `Required assertion veto: ${result.vetoReason}` : result.reason,
    namedScores,
  };
}

/** Opt in before native loading; assertions stay native, including latency, trace and comparisons. */
export function withAssertions<T extends RecordValue>(configuration: T): T {
  let hasRequired = false;
  const mappedTests: RecordValue[] = [];
  const mapAssertion = (input: unknown): unknown => {
    const assertion = object(input, "assertion");
    if (assertion.required !== undefined && typeof assertion.required !== "boolean")
      throw new Error("assertion.required must be boolean");
    hasRequired ||= assertion.required === true;
    if (assertion.type === "assert-set" && Array.isArray(assertion.assert)) {
      const children = assertion.assert.map(mapAssertion);
      if (assertion.required === true) {
        // Native set diagnostics omit the parent assertion. A zero-weight receipt preserves
        // that gate identity without changing dispatch, child weights, or named scores.
        children.push({
          type: "javascript",
          weight: 0,
          value: () => ({
            pass: true,
            score: 1,
            reason: "Required assertion-set receipt",
            metadata: { [SET_MARKER]: true },
          }),
        });
      }
      return { ...assertion, assert: children };
    }
    return assertion;
  };
  const mapTest = (input: unknown): RecordValue => {
    const test = object(input, "test");
    const mapped = {
      ...test,
      ...(Array.isArray(test.assert) ? { assert: test.assert.map(mapAssertion) } : {}),
    };
    mappedTests.push(mapped);
    return mapped;
  };
  const result: RecordValue = { ...configuration };
  if (result.defaultTest !== undefined) result.defaultTest = mapTest(result.defaultTest);
  if (result.tests !== undefined && !Array.isArray(result.tests))
    throw new Error("withAssertions requires resolved test objects");
  if (Array.isArray(result.tests)) result.tests = result.tests.map(mapTest);
  if (Array.isArray(result.scenarios))
    result.scenarios = result.scenarios.map((input) => {
      const scenario = object(input, "scenario");
      return {
        ...scenario,
        ...(Array.isArray(scenario.config) ? { config: scenario.config.map(mapTest) } : {}),
        ...(Array.isArray(scenario.tests) ? { tests: scenario.tests.map(mapTest) } : {}),
      };
    });
  if (hasRequired) {
    const defaultTest =
      result.defaultTest === undefined ? {} : object(result.defaultTest, "defaultTest");
    for (const test of mappedTests)
      if (test.assertScoringFunction !== undefined && test.assertScoringFunction !== requiredScore)
        throw new Error(
          "Required assertions replace custom assertScoringFunction; remove the old scorer",
        );
    result.defaultTest = { ...defaultTest, assertScoringFunction: requiredScore };
  }
  return result as T;
}
