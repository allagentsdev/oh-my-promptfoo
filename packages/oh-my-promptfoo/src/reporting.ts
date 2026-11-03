import { safeCount, safeMultiplier } from "./copilot-accounting.js";
import { type ResultCost, record, responseCost, sumCosts } from "./result-cost.js";

export { estimateCopilotCost } from "./result-cost.js";

export type Outcome = "pass" | "fail" | "error" | "unknown";
export interface Usage {
  total: number | null;
  prompt: number | null;
  completion: number | null;
  cached: number | null;
  requests: number | null;
}
export interface AssertionReport {
  reference: string;
  status: Outcome;
  score: number | null;
  threshold: number | null;
}
export interface CaseReport {
  row: number;
  test: number;
  column: number;
  status: Outcome;
  score: number | null;
  latencyMs: number | null;
  candidateUsage: Usage;
  graderUsage: Usage;
  candidateCost: ResultCost;
  graderCost: ResultCost;
  assertions: AssertionReport[];
}
export interface EvaluationReport {
  version: 1;
  status: Outcome;
  issues: string[];
  counts: { pass: number; fail: number; error: number; unknown: number };
  cases: CaseReport[];
  totals: {
    latencyMs: number | null;
    candidateUsage: Usage;
    graderUsage: Usage;
    candidateCost: ResultCost;
    graderCost: ResultCost;
  };
}

const measured = (value: unknown) => (safeMultiplier(value) ? value : null);
const count = (value: unknown) => (safeCount(value) ? value : null);
const score = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function usage(value: unknown): Usage {
  const source = record(value);
  const prompt = count(source.prompt),
    completion = count(source.completion);
  return {
    total:
      count(source.total) ??
      (prompt !== null && completion !== null ? count(prompt + completion) : null),
    prompt,
    completion,
    cached: count(source.cached),
    requests: count(source.numRequests),
  };
}

function sumUsage(values: Usage[]): Usage {
  const result = usage(undefined);
  for (const key of Object.keys(result) as (keyof Usage)[]) {
    if (values.length && values.every((item) => item[key] !== null))
      result[key] = count(values.reduce((sum, item) => sum + item[key]!, 0));
  }
  return result;
}

function graderError(grade: unknown): boolean {
  const value = record(grade);
  return (
    record(value.metadata).graderError === true ||
    (Array.isArray(value.componentResults) && value.componentResults.some(graderError))
  );
}

/** Promptfoo serializes nested children both under their parent and immediately after it. */
function roots(components: unknown): Record<string, any>[] {
  if (!Array.isArray(components)) return [];
  const result: Record<string, any>[] = [];
  for (let i = 0; i < components.length; i++) {
    const entry = record(components[i]);
    result.push(entry);
    const children = entry.componentResults;
    if (
      Array.isArray(children) &&
      children.length &&
      children.every(
        (child, offset) => JSON.stringify(child) === JSON.stringify(components[i + offset + 1]),
      )
    )
      i += children.length;
  }
  return result;
}

function assertionReports(grade: unknown, authored: unknown): AssertionReport[] {
  const result: AssertionReport[] = [];
  const visit = (components: Record<string, any>[], prefix: string) => {
    components.forEach((component, index) => {
      const reference = `${prefix}${index + 1}`;
      result.push({
        reference,
        status: assertionStatus(component),
        score: score(component.score),
        threshold: score(record(component.assertion).threshold),
      });
      visit(roots(component.componentResults), `${reference}.`);
    });
  };
  const components = roots(record(grade).componentResults);
  if (components.length) visit(components, "");
  else if (Array.isArray(authored))
    authored.forEach((_: unknown, index: number) => {
      result.push({
        reference: String(index + 1),
        status: "unknown",
        score: null,
        threshold: null,
      });
    });
  return result;
}

function assertionStatus(component: Record<string, any>): Outcome {
  if (graderError(component)) return "error";
  if (typeof component.pass !== "boolean") return "unknown";
  return component.pass ? "pass" : "fail";
}

function graderMeasurements(grade: unknown, failed: boolean): { cost: ResultCost; usage: Usage } {
  const value = record(grade);
  // Do not treat the zero tokens substituted after a failed judge as a free call.
  if (failed) return { cost: sumCosts([]), usage: usage(undefined) };
  const collect = (components: Record<string, any>[]): { cost: ResultCost; usage: Usage }[] =>
    components.flatMap((component) => {
      const metadata = record(component.metadata);
      const children = roots(component.componentResults);
      // Native assertion sets zero-fill aggregate tokens and omit child costs.
      if (record(metadata.assertionSet).type === "assert-set") return collect(children);
      if (
        component.tokensUsed !== undefined ||
        metadata.judgeAccounting !== undefined ||
        metadata.copilot !== undefined
      ) {
        const judge = metadata.judge;
        return [
          {
            cost: responseCost(
              {
                metadata,
                cost: record(component.tokensUsed).cost,
                tokenUsage: component.tokensUsed,
                cached: metadata.judgeAccounting === undefined && metadata.cachedResponse === true,
              },
              typeof judge === "string" && judge.startsWith("copilot:")
                ? judge.slice(8)
                : undefined,
            ),
            usage: usage(component.tokensUsed),
          },
        ];
      }
      if (children.length) return collect(children);
      // Only known deterministic native checks establish that an unmeasured leaf
      // made no judge call. Custom JavaScript and unknown assertions stay unknown.
      const deterministic =
        /^(?:not-)?(?:equals|contains|icontains|contains-any|contains-all|icontains-any|icontains-all|regex|starts-with|is-json|contains-json|is-valid-json-schema|is-xml|contains-xml|is-sql|contains-sql|is-html|is-valid-function-call|is-valid-openai-function-call|is-valid-openai-tools-call|is-valid-json|javascript-boolean|latency|cost|perplexity|perplexity-score)$/;
      return deterministic.test(record(component.assertion).type)
        ? []
        : [{ cost: sumCosts([]), usage: usage(undefined) }];
    });
  // Root assertions own measurements; aggregate tokens can contain synthetic
  // zeroes and diagnostic criterion children do not own extra spend.
  const measurements = collect(roots(value.componentResults));
  return {
    cost: sumCosts(measurements.map((item) => item.cost)),
    usage: sumUsage(measurements.map((item) => item.usage)),
  };
}

/** Read only public JSON exports. No config loading, case selection or scoring occurs here. */
export function summarizeEvaluation(document: unknown, exitCode?: number | null): EvaluationReport {
  const exported = record(record(document).results);
  const rows = Array.isArray(exported.results) ? exported.results : [];
  const issues: string[] = [];
  if (!Array.isArray(exported.results)) issues.push("missing-or-invalid-results");
  else if (!rows.length) issues.push("zero-coverage");
  const stats = record(exported.stats);
  const nativeCount = [stats.successes, stats.failures, stats.errors];
  if (
    !nativeCount.every(safeCount) ||
    nativeCount.reduce((sum, value) => sum + value, 0) !== rows.length
  )
    issues.push("incomplete-results");
  const observed = rows.reduce(
    (counts: number[], input: unknown) => {
      const row = record(input);
      const bucket = row.failureReason === 2 ? 2 : row.success === true ? 0 : 1;
      counts[bucket]++;
      return counts;
    },
    [0, 0, 0],
  );
  if (nativeCount.some((value, index) => value !== observed[index]))
    issues.push("inconsistent-results");
  if (exitCode === null || (exitCode !== undefined && exitCode !== 0 && exitCode !== 100))
    issues.push("execution-error");
  const counts = { pass: 0, fail: 0, error: 0, unknown: 0 };
  const cases: CaseReport[] = rows.map((input: unknown, index: number) => {
    const row = record(input),
      reply = record(row.response),
      test = record(row.testCase);
    const gradeFailed = graderError(row.gradingResult);
    const valid =
      typeof row.success === "boolean" &&
      safeCount(row.testIdx) &&
      safeCount(row.promptIdx) &&
      [0, 1, 2].includes(row.failureReason) &&
      score(row.score) !== null;
    const hasError = row.failureReason === 2 || Boolean(reply.error) || gradeFailed || !valid;
    const status = hasError ? "error" : row.success ? "pass" : "fail";
    counts[status]++;
    const grader = graderMeasurements(row.gradingResult, hasError);
    const provider = record(row.provider).id;
    return {
      row: index + 1,
      test: safeCount(row.testIdx) ? row.testIdx + 1 : index + 1,
      column: safeCount(row.promptIdx) ? row.promptIdx + 1 : index + 1,
      status,
      score: score(row.score),
      latencyMs: measured(row.latencyMs),
      candidateUsage: usage(reply.tokenUsage),
      graderUsage: grader.usage,
      candidateCost: responseCost(
        reply,
        typeof provider === "string" && provider.startsWith("copilot:")
          ? provider.slice(8)
          : undefined,
      ),
      graderCost: grader.cost,
      assertions: assertionReports(row.gradingResult, test.assert),
    };
  });
  if (safeCount(stats.errors) && stats.errors > 0 && !counts.error) issues.push("native-errors");
  const complete = issues.length === 0;
  const failed = exitCode === undefined ? counts.fail > 0 : exitCode !== 0;
  const status = issues.length || counts.error ? "error" : failed ? "fail" : "pass";
  return {
    version: 1,
    status,
    issues,
    counts,
    cases,
    totals: {
      latencyMs:
        complete && cases.length && cases.every((item) => item.latencyMs !== null)
          ? measured(cases.reduce((sum, item) => sum + item.latencyMs!, 0))
          : null,
      candidateUsage: complete
        ? sumUsage(cases.map((item) => item.candidateUsage))
        : usage(undefined),
      graderUsage: complete ? sumUsage(cases.map((item) => item.graderUsage)) : usage(undefined),
      candidateCost: sumCosts(complete ? cases.map((item) => item.candidateCost) : []),
      graderCost: sumCosts(complete ? cases.map((item) => item.graderCost) : []),
    },
  };
}

/** Fixed text and numbers only: descriptions, IDs, provider labels and reasons are private. */
export function renderSummary(report: EvaluationReport): string {
  const number = (value: number | null) => (value === null ? "unknown" : String(value));
  const money = (cost: ResultCost) =>
    cost.usd === null
      ? "unknown"
      : `${cost.basis === "estimate" ? "~" : ""}$${cost.usd.toFixed(8)}`;
  const lines = [
    "## Promptfoo evaluation",
    "",
    `Status: **${report.status.toUpperCase()}**`,
    "",
    `Pass: ${report.counts.pass} · Fail: ${report.counts.fail} · Error: ${report.counts.error} · Unknown: ${report.counts.unknown}`,
    "",
    `Latency (sum of rows): ${number(report.totals.latencyMs)} ms`,
    "",
    "| Role | Tokens | Prompt | Completion | Cached | Requests | USD |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...(["candidate", "grader"] as const).map((role) => {
      const tokens = report.totals[`${role}Usage`];
      return `| ${role} | ${number(tokens.total)} | ${number(tokens.prompt)} | ${number(tokens.completion)} | ${number(tokens.cached)} | ${number(tokens.requests)} | ${money(report.totals[`${role}Cost`])} |`;
    }),
    "",
    "Unknown means unmeasured or incomplete. ~ marks a token-price estimate. Costs are not invoices or savings.",
    "",
    "Rows, tests and columns are one-based references into the native JSON. Assertion references follow its grading tree.",
    "",
    "| Row | Test | Column | Status | Score | Latency ms | Candidate tokens | Candidate USD | Grader tokens | Grader USD |",
    "| ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  let bytes = Buffer.byteLength(lines.join("\n"));
  const add = (line: string) => {
    bytes += Buffer.byteLength(line) + 1;
    if (bytes > 800_000) return false;
    lines.push(line);
    return true;
  };
  let truncated = false;
  for (const item of report.cases) {
    if (
      !add(
        `| ${item.row} | ${item.test} | ${item.column} | ${item.status} | ${number(item.score)} | ${number(item.latencyMs)} | ${number(item.candidateUsage.total)} | ${money(item.candidateCost)} | ${number(item.graderUsage.total)} | ${money(item.graderCost)} |`,
      )
    ) {
      truncated = true;
      break;
    }
  }
  add(
    "\n| Row | Assertion | Status | Score | Authored threshold |\n| ---: | --- | --- | ---: | ---: |",
  );
  outer: for (const item of report.cases)
    for (const assertion of item.assertions) {
      if (
        !add(
          `| ${item.row} | ${assertion.reference} | ${assertion.status} | ${number(assertion.score)} | ${number(assertion.threshold)} |`,
        )
      ) {
        truncated = true;
        break outer;
      }
    }
  if (truncated)
    lines.push("", "Summary truncated. The local report.json retains every reported outcome.");
  if (report.issues.length)
    lines.push(
      "",
      "Result coverage or execution is incomplete; inspect the retained private diagnostics.",
    );
  return `${lines.join("\n")}\n`;
}
