import { pruneCache } from "../../workspace-core/src/index";

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
  console.log(
    "Usage: allagents-promptfoo cache prune [--all]\nRemoves only unleased package-owned cache entries. Does not run evaluations.",
  );
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
