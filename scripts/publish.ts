import { spawnSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";

if (process.argv.length !== 2) throw new Error("Usage: publish.ts");
const releaseRef = process.env.RELEASE_REF;
const match = /^v(\d+\.\d+\.\d+)$/.exec(releaseRef ?? "");
if (!match) throw new Error("RELEASE_REF must be a stable v<version> tag");
if (
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
  !process.env.ACTIONS_ID_TOKEN_REQUEST_URL ||
  !process.env.GITHUB_OUTPUT
)
  throw new Error("Publish through the OIDC-authorized GitHub Actions Publish workflow");

const manifest = JSON.parse(await readFile("packages/promptfoo-integration/package.json", "utf8"));
const rootManifest = JSON.parse(await readFile("package.json", "utf8"));
if (rootManifest.version !== manifest.version)
  throw new Error(
    `Root version ${rootManifest.version} differs from package version ${manifest.version}`,
  );
const version = match[1];
if (manifest.version !== version)
  throw new Error(`Release tag ${releaseRef} does not match package version ${manifest.version}`);
const name: string = manifest.name;

function npm(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("npm", args, {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? -1,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function view(args: string[]): unknown | undefined {
  const result = npm(["view", ...args, "--json", "--registry=https://registry.npmjs.org"]);
  if (result.status === 0) return JSON.parse(result.stdout || "null");
  if (/\bE404\b/.test(`${result.stdout}\n${result.stderr}`)) return undefined;
  if (args[1] === "version" && /\bETARGET\b/.test(`${result.stdout}\n${result.stderr}`))
    return undefined;
  throw new Error(`npm view failed (${result.status}): ${result.stderr}`);
}

const existing = view([`${name}@${version}`, "version"]);
if (existing !== undefined && existing !== version)
  throw new Error(`Unexpected registry version for ${name}@${version}`);
if (existing === undefined) {
  const result = spawnSync(
    "npm",
    [
      "publish",
      "--provenance",
      "--access",
      "public",
      "--tag",
      "latest",
      "--registry=https://registry.npmjs.org",
    ],
    { cwd: "packages/promptfoo-integration", stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`npm publish failed (${result.status ?? result.signal})`);
} else {
  console.log(`${name}@${version} is already published`);
}
const tags = view([name, "dist-tags"]);
if (!tags || typeof tags !== "object" || (tags as Record<string, string>).latest !== version)
  throw new Error(`${name}@${version} must be published under latest`);

await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\n`);
