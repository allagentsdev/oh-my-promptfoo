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
const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const preview = /^(.+)-next\.[1-9]\d*$/.exec(process.env.PREVIEW_VERSION ?? "");
if (!preview || !stableVersion.test(preview[1])) throw Error("Invalid preview version");
// The working manifests have already been stamped with the preview version.
const { version: baseVersion } = JSON.parse(
  execFileSync("git", ["show", "HEAD:package.json"], { encoding: "utf8" }),
);
if (!stableVersion.test(baseVersion ?? "")) throw Error("Invalid source stable version");
const baseTag = `refs/tags/v${baseVersion}`;
execFileSync("git", ["merge-base", "--is-ancestor", baseTag, "HEAD"], { stdio: "pipe" });
const messages = execFileSync("git", ["log", "--format=%B%x00", `${baseTag}..HEAD`], {
  encoding: "utf8",
}).split("\0");
// Read raw messages so a request buried in squash text cannot be silently ignored.
// Git returns newest commits first; a later explicit request supersedes earlier ones.
for (const message of messages) {
  const requests = [...message.matchAll(/^Release-As:[ \t]*([^\r\n]*)/gim)];
  if (!requests.length) continue;
  const versions = [...new Set(requests.map((request) => request[1].trim()))];
  if (versions.length !== 1 || !stableVersion.test(versions[0]))
    throw Error("Expected one stable Release-As version in the newest override commit");
  if (versions[0] !== preview[1])
    throw Error(
      `Release-As: ${versions[0]} conflicts with preview ${process.env.PREVIEW_VERSION}. ` +
        "Fix the final squash-message footer or release configuration before publishing.",
    );
  break;
}
appendFileSync(process.env.GITHUB_OUTPUT, "publish=true\n");
