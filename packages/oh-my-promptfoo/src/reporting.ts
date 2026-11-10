import { safeCount, safeMultiplier } from "./copilot-accounting.js";
import { type SourceOptions, sourceUrl } from "./eval-sources.js";
import { redact, secrets } from "./redaction.js";
import {
  type MeasurementUnavailableReason,
  type ResultCost,
  record,
  responseCost,
  sumCosts,
  unknownCost,
} from "./result-cost.js";

export { prepareResultArtifact, renderResultArtifactLink } from "./eval-artifacts.js";
export { addSourceLinks, type SourceOptions } from "./eval-sources.js";
export { estimateCopilotCost } from "./result-cost.js";

export type Outcome = "pass" | "fail" | "error" | "unknown";
export interface Usage {
  total: number | null;
  prompt: number | null;
  completion: number | null;
  cached: number | null;
  requests: number | null;
  unavailableReasons?: MeasurementUnavailableReason[];
}

export interface RunTimings {
  toolchainMs?: number;
  setupMs?: number;
  nativeEvaluationMs?: number;
  workspacePreparationMs?: number | null;
  reportingMs?: number;
}
export interface AssertionReport {
  reference: string;
  type?: string;
  label?: string;
  status: Outcome;
  score: number | null;
  threshold: number | null;
}
export interface CaseReport {
  row: number;
  test: number;
  column: number;
  label?: string;
  source?: { url: string; location: "test" | "file" };
  candidate?: string;
  status: Outcome;
  score: number | null;
  threshold?: number;
  latencyMs: number | null;
  candidateUsage: Usage;
  graderUsage: Usage;
  candidateCost: ResultCost;
  graderCost: ResultCost;
  assertions: AssertionReport[];
}
export interface EvaluationReport {
  version: 1;
  replayed?: true;
  /** Current invocation timings; replay timings never describe the recorded model run. */
  timings?: RunTimings;
  suite?: { number: number; title?: string };
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

export interface ReportOptions {
  /** Legacy JSON reference. Suite numbers are not displayed. */
  suiteNumber?: number;
  /** Checked-in source context for links; only used with publicLabels. */
  source?: SourceOptions;
  /** Publish authored case IDs/descriptions, provider labels and assertion metrics/types. Defaults to false. */
  publicLabels?: boolean;
  /** Additional credential values to redact from explicitly public labels. */
  sensitiveValues?: string[];
}

const measured = (value: unknown) => (safeMultiplier(value) ? value : null);
const count = (value: unknown) => (safeCount(value) ? value : null);
const score = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function usage(value: unknown, reason: MeasurementUnavailableReason = "not-reported"): Usage {
  const source = record(value);
  const prompt = count(source.prompt),
    completion = count(source.completion);
  const result: Usage = {
    total:
      count(source.total) ??
      (prompt !== null && completion !== null ? count(prompt + completion) : null),
    prompt,
    completion,
    cached: count(source.cached),
    requests: count(source.numRequests),
  };
  if (result.total === null || result.requests === null) result.unavailableReasons = [reason];
  return result;
}

function sumUsage(values: Usage[]): Usage {
  const result = usage(undefined);
  for (const key of ["total", "prompt", "completion", "cached", "requests"] as const) {
    if (values.length && values.every((item) => item[key] !== null))
      result[key] = count(values.reduce((sum, item) => sum + item[key]!, 0));
  }
  delete result.unavailableReasons;
  if (result.total === null || result.requests === null)
    result.unavailableReasons = values.length
      ? [...new Set(values.flatMap((item) => item.unavailableReasons ?? []))]
      : ["incomplete-accounting"];
  return result;
}

function graderError(grade: unknown): boolean {
  const value = record(grade);
  return (
    record(value.metadata).graderError === true ||
    (Array.isArray(value.componentResults) && value.componentResults.some(graderError))
  );
}

/** Classify an already evaluated native row; never apply a scoring policy. */
export function nativeTestOutcome(input: unknown): Outcome {
  const row = record(input);
  const valid =
    typeof row.success === "boolean" &&
    safeCount(row.testIdx) &&
    safeCount(row.promptIdx) &&
    [0, 1, 2].includes(row.failureReason) &&
    score(row.score) !== null;
  return row.failureReason === 2 ||
    record(row.response).error ||
    graderError(row.gradingResult) ||
    !valid
    ? "error"
    : row.success
      ? "pass"
      : "fail";
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

function assertionReports(
  grade: unknown,
  authored: unknown,
  label: (value: unknown) => string | undefined,
): AssertionReport[] {
  const assertionLabel = (input: unknown): string | undefined => {
    const assertion = record(input);
    return (
      label(assertion.metric) ??
      (["skill-used", "not-skill-used"].includes(assertion.type)
        ? label(assertion.value)
        : undefined)
    );
  };
  const result: AssertionReport[] = [];
  const visit = (components: Record<string, any>[], prefix: string) => {
    components.forEach((component, index) => {
      const reference = `${prefix}${index + 1}`;
      const metricLabel = assertionLabel(component.assertion);
      result.push({
        reference,
        type: assertionType(label(record(component.assertion).type)),
        ...(metricLabel ? { label: metricLabel } : {}),
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
    authored.forEach((input: unknown, index: number) => {
      const metricLabel = assertionLabel(input);
      result.push({
        reference: String(index + 1),
        type: assertionType(label(record(input).type)),
        ...(metricLabel ? { label: metricLabel } : {}),
        status: "unknown",
        score: null,
        threshold: null,
      });
    });
  return result;
}

function assertionType(value: unknown): string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,40}$/.test(value) ? value : "custom";
}

function assertionStatus(component: Record<string, any>): Outcome {
  if (graderError(component)) return "error";
  if (typeof component.pass !== "boolean") return "unknown";
  return component.pass ? "pass" : "fail";
}

function graderMeasurements(grade: unknown, failed: boolean): { cost: ResultCost; usage: Usage } {
  const value = record(grade);
  // Do not treat the zero tokens substituted after a failed judge as a free call.
  if (failed) {
    const reason = graderError(grade) ? "grader-error" : "evaluation-error";
    return { cost: unknownCost(reason), usage: usage(undefined, reason) };
  }
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
                : metadata.model,
            ),
            usage: usage(component.tokensUsed),
          },
        ];
      }
      // Only known deterministic native checks establish that an unmeasured leaf
      // made no judge call. Custom JavaScript and unknown assertions stay unknown.
      const deterministic =
        /^(?:not-)?(?:skill-used|equals|contains|icontains|contains-any|contains-all|icontains-any|icontains-all|regex|starts-with|is-json|contains-json|is-valid-json-schema|is-xml|contains-xml|is-sql|contains-sql|is-html|is-valid-function-call|is-valid-openai-function-call|is-valid-openai-tools-call|is-valid-json|javascript-boolean|latency|cost|perplexity|perplexity-score)$/;
      return !children.length && deterministic.test(record(component.assertion).type)
        ? [
            {
              cost: responseCost({ cost: 0 }, undefined),
              usage: usage({ total: 0, prompt: 0, completion: 0, cached: 0, numRequests: 0 }),
            },
          ]
        : [{ cost: unknownCost("not-reported"), usage: usage(undefined) }];
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
export function summarizeEvaluation(
  document: unknown,
  exitCode?: number | null,
  options: ReportOptions = {},
): EvaluationReport {
  const suiteNumber = options.suiteNumber ?? 1;
  if (!Number.isSafeInteger(suiteNumber) || suiteNumber < 1)
    throw new Error("Suite number must be a positive safe integer");
  const sensitive = options.publicLabels
    ? [...secrets(record(record(document).config), {}), ...(options.sensitiveValues ?? [])]
    : [];
  const label = (value: unknown): string | undefined => {
    if (!options.publicLabels || typeof value !== "string") return;
    const text = redact(value, sensitive)
      .replace(/[\p{Cc}\p{Cf}]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text ? Array.from(text).slice(0, 160).join("") : undefined;
  };
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
    const status = nativeTestOutcome(row);
    const hasError = status === "error";
    counts[status]++;
    const grader = graderMeasurements(row.gradingResult, hasError);
    const provider = record(row.provider).id;
    const testLabel = label(record(test.metadata).id) ?? label(test.description);
    const candidateLabel = label(record(row.provider).label);
    return {
      row: index + 1,
      test: safeCount(row.testIdx) ? row.testIdx + 1 : index + 1,
      column: safeCount(row.promptIdx) ? row.promptIdx + 1 : index + 1,
      ...(testLabel ? { label: testLabel } : {}),
      ...(candidateLabel ? { candidate: candidateLabel } : {}),
      status,
      score: score(row.score),
      ...(score(test.threshold) !== null ? { threshold: score(test.threshold)! } : {}),
      latencyMs: measured(row.latencyMs),
      candidateUsage: usage(reply.tokenUsage, reply.error ? "provider-error" : "not-reported"),
      graderUsage: grader.usage,
      candidateCost: responseCost(
        reply,
        typeof provider === "string" && provider.startsWith("copilot:")
          ? provider.slice(8)
          : undefined,
      ),
      graderCost: grader.cost,
      assertions: assertionReports(row.gradingResult, test.assert, label),
    };
  });
  if (safeCount(stats.errors) && stats.errors > 0 && !counts.error) issues.push("native-errors");
  const complete = issues.length === 0;
  const failed = exitCode === undefined ? counts.fail > 0 : exitCode !== 0;
  const status = issues.length || counts.error ? "error" : failed ? "fail" : "pass";
  const suiteTitle = label(record(record(document).config).description);
  return {
    version: 1,
    suite: {
      number: suiteNumber,
      ...(suiteTitle ? { title: suiteTitle } : {}),
    },
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

function reportFormats() {
  const number = (value: number | null) =>
    value === null ? "unknown" : value.toLocaleString("en-US");
  const score = (value: number | null) =>
    value === null
      ? "unknown"
      : value >= 0 && value <= 1
        ? `${Number((value * 100).toFixed(1))}%`
        : String(value);
  const time = (value: number | null) => {
    if (value === null) return "unknown";
    if (value < 1000) return `${Math.round(value)} ms`;
    if (value < 60000) return `${Number((value / 1000).toFixed(1))} s`;
    return `${Math.floor(value / 60000)} min ${Math.round((value % 60000) / 1000)} s`;
  };
  const money = (cost: ResultCost) => {
    if (cost.usd === null) return "unknown";
    const digits =
      cost.usd > 0 && Number(cost.usd.toFixed(4)) === 0 ? Math.ceil(-Math.log10(cost.usd)) : 4;
    const amount =
      digits > 20
        ? `$${cost.usd.toExponential(0)}`
        : `$${cost.usd.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false })}`;
    return `${cost.basis === "estimate" ? "~" : ""}${amount}`;
  };
  const escapeMarkup = (value: string) =>
    value
      .replace(/([\\`*_[\]{}()!#])/g, "\\$1")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\|/g, "&#124;");
  const badge = (status: Outcome) =>
    `${{ pass: "✅", fail: "❌", error: "⚠️", unknown: "❔" }[status]} ${status.toUpperCase()}`;
  const usageSummary = (value: Usage) =>
    value.total === null && value.requests === null
      ? "unknown"
      : `${number(value.total)} tokens · ${number(value.requests)} requests`;
  return { number, score, time, money, escapeMarkup, badge, usageSummary };
}

const formats = reportFormats();

const measurementReasons: Record<MeasurementUnavailableReason, string> = {
  "not-reported": "not reported",
  "provider-error": "provider error; measurements unavailable",
  "grader-error": "grader error; spend may have occurred",
  "evaluation-error": "evaluation error; measurements unavailable",
  "incomplete-accounting": "accounting is incomplete",
  "pricing-unavailable": "recorded prices or matching usage unavailable",
};

function measurementNotes(item: CaseReport): string {
  const measurements: [string, MeasurementUnavailableReason[] | undefined][] = [
    [
      item.candidateUsage.total === null ? "Candidate usage" : "Candidate requests",
      item.candidateUsage.unavailableReasons,
    ],
    [
      "Candidate cost",
      item.candidateCost.usd === null ? item.candidateCost.unavailableReasons : undefined,
    ],
    [
      item.graderUsage.total === null ? "Grader usage" : "Grader requests",
      item.graderUsage.unavailableReasons,
    ],
    ["Grader cost", item.graderCost.usd === null ? item.graderCost.unavailableReasons : undefined],
  ];
  return measurements
    .flatMap(([name, reasons]) =>
      reasons?.length
        ? [
            `${name}: ${reasons
              .map((reason) => measurementReasons[reason])
              .filter(Boolean)
              .join("; ")}`,
          ]
        : [],
    )
    .join(". ");
}

/** Durations overlap: native evaluation includes workspace preparation and grader calls. */
function renderTimings(timings: RunTimings, replayed = false): string {
  const rows = [
    ["Toolchain preparation", timings.toolchainMs],
    ["CLI preparation", timings.setupMs],
    ["Native evaluation (includes workspace and grading)", timings.nativeEvaluationMs],
    ["Workspace preparation (sum of observed workspaces)", timings.workspacePreparationMs],
    [replayed ? "Replay rendering (this invocation)" : "Reporting", timings.reportingMs],
  ].filter(([, value]) => value !== undefined);
  if (!rows.length) return "";
  return `<details><summary>${replayed ? "Replay timing" : "Run timing"}</summary>\n\n| Phase | Duration |\n| --- | ---: |\n${rows.map(([name, value]) => `| ${name} | ${formats.time(value as number | null)} |`).join("\n")}\n\nDurations overlap; workspace time is included in native evaluation. They must not be added together.\n\n</details>\n`;
}

/** Render only normalized outcomes and explicitly public, redacted labels. */
export function renderSummary(report: EvaluationReport): string {
  const { number, score, time, money, escapeMarkup, badge, usageSummary } = formats;
  const candidate = report.cases[0]?.candidate;
  const sharedCandidate = candidate && report.cases.every((item) => item.candidate === candidate);
  const title = (item: CaseReport, html = false) => {
    const escapeLabel = html
      ? (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      : escapeMarkup;
    const name = `Test ${item.row}${item.label ? ` · ${escapeLabel(item.label)}` : ""}${item.candidate && !sharedCandidate ? ` (${escapeLabel(item.candidate)})` : ""}`;
    const url = sourceUrl(item.source?.url);
    if (!url) return name;
    const hint =
      item.source?.location === "test"
        ? "Test definition"
        : "Source file; exact test location unavailable";
    return html
      ? `<a href="${url.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" title="${hint}">${name}</a>`
      : `[${name}](<${url}> "${hint}")`;
  };
  const lines = [
    `## Evals — ${badge(report.status)}`,
    "",
    ...(report.replayed
      ? [
          "**Replay — recorded evaluation.** No candidate or grader calls were made. Scores, latency, usage and cost describe the recorded run.",
          "",
        ]
      : []),
    "| Metric | Value |",
    "| --- | --- |",
    ...(sharedCandidate ? [`| Candidate | ${escapeMarkup(candidate)} |`] : []),
    `| Tests | ${number(report.cases.length)} |`,
    `| Passed | ${report.counts.pass} |`,
    `| Failed | ${report.counts.fail} |`,
    `| Errors | ${report.counts.error} |`,
    ...(report.counts.unknown ? [`| Unknown outcomes | ${report.counts.unknown} |`] : []),
    `| Pass rate | ${report.cases.length ? score(report.counts.pass / report.cases.length) : "unknown"} |`,
    `| Total candidate time (sum of rows) | ${time(report.totals.latencyMs)} |`,
    `| Candidate usage | ${usageSummary(report.totals.candidateUsage)} |`,
    `| Grader usage | ${usageSummary(report.totals.graderUsage)} |`,
    `| Candidate cost | ${money(report.totals.candidateCost)} |`,
    `| Grader cost | ${money(report.totals.graderCost)} |`,
    "",
    "### Results",
    "",
    "| Test | Latency | Tokens | Cost | Status | Assertions passed | Score vs threshold |",
    "| --- | ---: | ---: | ---: | --- | ---: | ---: |",
  ];
  let bytes = Buffer.byteLength(lines.join("\n"));
  const add = (block: string) => {
    const size = Buffer.byteLength(block) + 1;
    if (bytes + size > 800_000) return false;
    bytes += size;
    lines.push(block);
    return true;
  };
  let truncated = false;
  for (const item of report.cases) {
    const parents = new Set(
      item.assertions.map((check) => check.reference.split(".").slice(0, -1).join(".")),
    );
    const checks = item.assertions.filter((check) => !parents.has(check.reference));
    const tokens = sumUsage([item.candidateUsage, item.graderUsage]).total;
    if (
      !add(
        `| ${title(item)} | ${time(item.latencyMs)} | ${number(tokens)} | ${money(sumCosts([item.candidateCost, item.graderCost]))} | ${badge(item.status)} | ${checks.length ? `${checks.filter((check) => check.status === "pass").length} / ${checks.length}` : "unknown"} | ${score(item.score)} / ${item.threshold === undefined ? "—" : score(item.threshold)} |`,
      )
    ) {
      truncated = true;
      break;
    }
  }
  add("\n### Test details\n");
  for (const item of report.cases) {
    const thresholds = item.assertions.some((check) => check.threshold !== null);
    const notes = measurementNotes(item);
    const names = new Map<string, number>();
    for (const check of item.assertions)
      if (check.label) names.set(check.label, (names.get(check.label) ?? 0) + 1);
    const detail = [
      `<details><summary>${title(item, true)} — ${badge(item.status)}</summary>`,
      "",
      `Score: **${score(item.score)}** · Candidate time: **${time(item.latencyMs)}**`,
      "",
      "| Role | Tokens | Requests | Cost |",
      "| --- | ---: | ---: | ---: |",
      `| Candidate | ${number(item.candidateUsage.total)} | ${number(item.candidateUsage.requests)} | ${money(item.candidateCost)} |`,
      `| Grader | ${number(item.graderUsage.total)} | ${number(item.graderUsage.requests)} | ${money(item.graderCost)} |`,
      "",
      ...(notes ? [`${notes}.`, ""] : []),
      `| Check | Type | Result | Score |${thresholds ? " Threshold |" : ""}`,
      `| --- | --- | --- | ---: |${thresholds ? " ---: |" : ""}`,
      ...item.assertions.map((check, index) => {
        const name = check.label
          ? `${escapeMarkup(check.label)}${names.get(check.label) === 1 ? "" : ` (check ${index + 1})`}`
          : `Check ${index + 1}`;
        return `| ${name} | ${escapeMarkup(check.type ?? "custom")} | ${badge(check.status)} | ${score(check.score)} |${thresholds ? ` ${check.threshold === null ? "—" : score(check.threshold)} |` : ""}`;
      }),
      "",
      "</details>",
      "",
    ].join("\n");
    if (!add(detail)) {
      truncated = true;
      break;
    }
  }
  if (truncated)
    lines.push("", "Summary truncated. The local report.json retains every reported outcome.");
  if (report.timings) lines.push("", renderTimings(report.timings, report.replayed));
  lines.push(
    "",
    "Tests are numbered from 1 within each suite. Each candidate/repeat has its own result number.",
    "",
    "Results-table tokens and cost include candidate and grader when both are reported; latency is the candidate's native latency. Unknown means unmeasured or incomplete. — means no assertion threshold was authored. ~ marks a token-price estimate. Costs are not invoices or savings. Native precision is retained in report.json.",
  );
  if (report.issues.length)
    lines.push(
      "",
      "Result coverage or execution is incomplete; inspect the retained private diagnostics.",
    );
  return `${lines.join("\n")}\n`;
}

/** Console labels cannot contain terminal controls or GitHub workflow commands. */
function consoleLabel(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/:{2,}/g, (value) => value.split("").join(" "))
    .replaceAll("##[", "# #[");
}

export function renderConsoleSummary(report: EvaluationReport): string {
  const { number, score, time, usageSummary } = formats;
  const money = (cost: ResultCost) => formats.money(cost).replace("&lt;", "<");
  const lines = [
    ...(report.replayed
      ? [
          "Replay: recorded evaluation; no candidate or grader calls. Scores, latency, usage and cost are historical.",
        ]
      : []),
    `${consoleLabel(report.suite?.title ?? "Promptfoo evaluation")} · ${report.status.toUpperCase()}`,
    `Tests: ${report.cases.length}; passed: ${report.counts.pass}; failed: ${report.counts.fail}; errors: ${report.counts.error}; unknown outcomes: ${report.counts.unknown}`,
    `Candidate: ${usageSummary(report.totals.candidateUsage)}; cost: ${money(report.totals.candidateCost)}; total candidate time: ${time(report.totals.latencyMs)}`,
    `Grader: ${usageSummary(report.totals.graderUsage)}; cost: ${money(report.totals.graderCost)}`,
  ];
  for (const item of report.cases) {
    const notes = measurementNotes(item);
    lines.push(
      `Test ${item.row}${item.label ? ` · ${consoleLabel(item.label)}` : ""}${item.candidate ? ` (${consoleLabel(item.candidate)})` : ""} · ${item.status.toUpperCase()} · ${time(item.latencyMs)} · score ${score(item.score)}${item.threshold === undefined ? "" : ` / threshold ${score(item.threshold)}`}`,
      `  Candidate: ${number(item.candidateUsage.total)} tokens; ${number(item.candidateUsage.requests)} requests; ${money(item.candidateCost)}. Grader: ${number(item.graderUsage.total)} tokens; ${number(item.graderUsage.requests)} requests; ${money(item.graderCost)}.`,
      ...(notes ? [`  ${notes}.`] : []),
    );
    const names = new Map<string, number>();
    for (const check of item.assertions)
      if (check.label) names.set(check.label, (names.get(check.label) ?? 0) + 1);
    item.assertions.forEach((check, index) => {
      lines.push(
        `  ${check.label ? `${consoleLabel(check.label)}${names.get(check.label) === 1 ? "" : ` (check ${index + 1})`}` : `Check ${index + 1}`}: ${check.status.toUpperCase()}; score ${score(check.score)}${check.threshold === null ? "" : `; threshold ${score(check.threshold)}`}`,
      );
    });
  }
  if (report.issues.length)
    lines.push("Result coverage or execution is incomplete; inspect retained private diagnostics.");
  lines.push(
    "Unknown means unmeasured or incomplete; ~ marks a token-price estimate. Costs are not invoices or savings.",
  );
  return `${lines.join("\n")}\n`;
}

export interface EvaluationProgress {
  test: number;
  column: number;
  status: Outcome | "pending";
  latencyMs: number | null;
}

export function renderProgress(
  progress: EvaluationProgress,
  completed: number,
  _suite?: number,
): string {
  return `Completed ${completed} · native test ${progress.test}, column ${progress.column} · ${progress.status === "pending" ? "COMPARISON PENDING" : progress.status.toUpperCase()} · ${formats.time(progress.latencyMs)}`;
}
