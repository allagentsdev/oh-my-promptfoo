import { appendFile, readFile } from "node:fs/promises";
import { renderSummary } from "oh-my-promptfoo/reporting";

const sample = JSON.parse(
  await readFile(new URL("../../../../examples/ci/live-report.json", import.meta.url), "utf8"),
);
const markdown = [
  "## Recorded live agent evaluation",
  "",
  `Recorded **${sample.recordedAt}** using **${sample.model}** against repository commit [${sample.workspaceCommit.slice(0, 7)}](https://github.com/allagentsdev/oh-my-promptfoo/commit/${sample.workspaceCommit}).`,
  "",
  "This is a saved real model run for reviewing the report format. It is not a new evaluation or a gate on the current commit. The manual live workflow runs the suite again.",
  "",
  renderSummary(sample.report),
].join("\n");
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
  console.log("Published the recorded live evaluation summary.");
} else console.log(markdown);
