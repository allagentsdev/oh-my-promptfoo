import { appendFile, readFile } from "node:fs/promises";
import { renderConsoleSummary, renderSummary } from "oh-my-promptfoo/reporting";

const sample = JSON.parse(
  await readFile(new URL("../../../../examples/ci/live-report.json", import.meta.url), "utf8"),
);
const report = sample.report;
const markdown = [
  "> **Recorded live evaluation:** a saved real model run for reviewing the report format, not a new evaluation or a gate on this commit. The manual live workflow runs the suite again.",
  "",
  renderSummary(report),
  "Agent output and judge reasons are unavailable for this recorded preview. The manual live workflow retains a downloadable scored result.",
  "",
  `Recorded **${sample.recordedAt}** using **${sample.model}** against repository commit [${sample.workspaceCommit.slice(0, 7)}](https://github.com/allagentsdev/oh-my-promptfoo/commit/${sample.workspaceCommit}).`,
].join("\n");
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
  console.log("Recorded live evaluation: saved results, not a new model run.");
  console.log(renderConsoleSummary(report));
  console.log("Published the recorded live evaluation summary.");
} else console.log(markdown);
