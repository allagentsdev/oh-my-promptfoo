import { spawnSync } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";

const tag = process.argv[2] ?? "next";
if (!["next", "latest"].includes(tag)) throw new Error("Expected next or latest");
if (
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
  process.env.GITHUB_REF !== "refs/heads/main" ||
  !process.env.ACTIONS_ID_TOKEN_REQUEST_URL ||
  !process.env.GITHUB_OUTPUT
)
  throw new Error("Publish through the trusted manual GitHub Actions npm environment on main");
const manifestPath = "packages/promptfoo-integration/package.json";
const original = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(original);
if (!/^\d+\.\d+\.\d+$/.test(manifest.version))
  throw new Error("Release manifest must contain a stable semantic version");
const runNumber = process.env.GITHUB_RUN_NUMBER;
if (tag === "next" && (!runNumber || !/^[1-9]\d*$/.test(runNumber)))
  throw new Error("Prerelease requires the GitHub run number");
const version = tag === "next" ? `${manifest.version}-rc.${runNumber}` : manifest.version;
try {
  if (tag === "next")
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
  const result = spawnSync("npm", ["publish", "--provenance", "--access", "public", "--tag", tag], {
    cwd: "packages/promptfoo-integration",
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`npm publish failed (${result.status ?? result.signal})`);
  await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\n`);
} finally {
  await writeFile(manifestPath, original);
}
