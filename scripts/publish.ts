import { spawnSync } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";

const releaseRef = process.env.RELEASE_REF;
const match = /^v(\d+\.\d+\.\d+)(?:-rc\.([1-9]\d*))?$/.exec(releaseRef ?? "");
if (!match) throw new Error("RELEASE_REF must be v<version> or v<version>-rc.<number>");
if (
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
  !process.env.ACTIONS_ID_TOKEN_REQUEST_URL ||
  !process.env.GITHUB_OUTPUT
)
  throw new Error("Publish through the trusted manual GitHub Actions Publish workflow");

const manifestPath = "packages/promptfoo-integration/package.json";
const original = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(original);
const rootManifest = JSON.parse(await readFile("package.json", "utf8"));
if (rootManifest.version !== manifest.version)
  throw new Error(
    `Root version ${rootManifest.version} differs from package version ${manifest.version}`,
  );
const [, baseVersion, candidateNumber] = match;
if (manifest.version !== baseVersion)
  throw new Error(`Release tag ${releaseRef} does not match package version ${manifest.version}`);
const version = candidateNumber ? `${baseVersion}-rc.${candidateNumber}` : baseVersion;
const npmTag = candidateNumber ? "next" : "latest";

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
  throw new Error(`npm view failed (${result.status})`);
}

const name = manifest.name;
const existing = view([`${name}@${version}`, "version"]);
if (existing !== undefined && existing !== version)
  throw new Error(`Unexpected registry version for ${name}@${version}`);
if (existing === undefined) {
  try {
    if (candidateNumber)
      await writeFile(manifestPath, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
    const result = spawnSync(
      "npm",
      [
        "publish",
        "--provenance",
        "--access",
        "public",
        "--tag",
        npmTag,
        "--registry=https://registry.npmjs.org",
      ],
      { cwd: "packages/promptfoo-integration", stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`npm publish failed (${result.status ?? result.signal})`);
  } finally {
    if (candidateNumber) await writeFile(manifestPath, original);
  }
} else {
  const tags = view([name, "dist-tags"]);
  if (!tags || typeof tags !== "object" || (tags as Record<string, string>)[npmTag] !== version)
    throw new Error(`${name}@${version} already exists, but its ${npmTag} dist-tag does not match`);
  console.log(`${name}@${version} is already published under ${npmTag}`);
}

await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\nnpm_tag=${npmTag}\n`);
