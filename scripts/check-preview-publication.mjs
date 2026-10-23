import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

if (!/^[a-f0-9]{40}$/.test(process.env.RELEASE_PR_SHA ?? ""))
  throw Error("Invalid validated release pull request head");
const pr = JSON.parse(
  execFileSync("gh", ["pr", "view", process.env.RELEASE_PR, "--json", "state,headRefOid"], {
    encoding: "utf8",
  }),
);
if (
  !pr ||
  typeof pr !== "object" ||
  Array.isArray(pr) ||
  !["OPEN", "CLOSED", "MERGED"].includes(pr.state) ||
  typeof pr.headRefOid !== "string" ||
  !/^[a-f0-9]{40}$/.test(pr.headRefOid)
)
  throw Error("Malformed release pull request response");
if (pr.state !== "OPEN" || pr.headRefOid !== process.env.RELEASE_PR_SHA) {
  console.log(
    "::notice::Skipping superseded preview: the release PR closed, merged, or changed head during validation",
  );
  appendFileSync(process.env.GITHUB_OUTPUT, "publish=false\n");
  process.exit(0);
}
execFileSync("git", ["fetch", "--no-tags", "origin", "main"], { stdio: "pipe" });
execFileSync("git", ["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"], { stdio: "pipe" });
appendFileSync(process.env.GITHUB_OUTPUT, "publish=true\n");
