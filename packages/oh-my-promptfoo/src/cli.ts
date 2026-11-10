import { pruneCache } from "../../workspace-core/src/index";
import { evaluationCommand } from "./eval-run.js";

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  console.log(
    "Usage:\n  allagents-promptfoo cache prune [--all]\n  allagents-promptfoo eval --config FILE [--output-dir DIR] [--working-directory DIR] -- [native Promptfoo arguments]\n  allagents-promptfoo eval --config FILE --args-file FILE [--output-dir DIR]\n  allagents-promptfoo report --results FILE [--exit-code CODE|unknown] [--output-dir DIR]\n  allagents-promptfoo report --replay --results FILE [--config FILE] [--working-directory DIR] [--github]\nReporting options for eval/report: --suite-number N --public-labels true|false\nReplay renders saved native outcomes without candidate or grader calls; all measurements describe the recorded run.\nEvaluation results and diagnostics remain local; summaries omit raw content.",
  );
} else if (args[0] === "eval" || args[0] === "report") {
  try {
    await evaluationCommand(args[0], args.slice(1));
  } catch {
    console.error(
      "Evaluation command failed. Check command arguments and output-directory access.",
    );
    process.exitCode = 1;
  }
} else if (
  args[0] === "cache" &&
  args[1] === "prune" &&
  args.slice(2).every((a) => a === "--all") &&
  args.length <= 3
) {
  try {
    const report = await pruneCache(process.env, args.includes("--all"));
    console.log(JSON.stringify(report, null, 2));
    if (report.errors.length) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Cache pruning failed");
    process.exitCode = 1;
  }
} else {
  console.error("Unknown command. Use allagents-promptfoo --help");
  process.exitCode = 2;
}
