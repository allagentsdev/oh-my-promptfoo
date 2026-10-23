import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const publicManifest = "packages/oh-my-promptfoo/package.json";
const bundledDependencies = [
  "diff",
  "ignore",
  "import-meta-resolve",
  "jsonc-parser",
  "@opentelemetry/api",
  "@opentelemetry/context-async-hooks",
  "@opentelemetry/core",
  "@opentelemetry/sdk-trace-node",
];
/** @type {DependencySection[]} */
const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
/** @typedef {"dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies"} DependencySection */
/** @typedef {Record<DependencySection, Record<string, string>> & { optionalPeers: Set<string> }} Manifest */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {...string} args @returns {string} */
function git(...args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.error || result.status !== 0)
    throw new Error(result.error?.message ?? `git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** @param {string} sha @param {string} path @returns {Manifest} */
function readManifest(sha, path) {
  /** @type {unknown} */
  const value = JSON.parse(git("show", `${sha}:${path}`));
  if (!isObject(value)) throw new Error(`Invalid manifest at ${sha}:${path}`);
  /** @type {Manifest} */
  const manifest = {
    dependencies: {},
    devDependencies: {},
    optionalDependencies: {},
    peerDependencies: {},
    optionalPeers: new Set(),
  };
  for (const section of dependencySections) {
    const dependencies = value[section] === undefined ? {} : value[section];
    if (
      !isObject(dependencies) ||
      Object.values(dependencies).some((version) => typeof version !== "string" || !version.trim())
    )
      throw new Error(`Invalid ${section} at ${sha}:${path}`);
    manifest[section] = /** @type {Record<string, string>} */ (dependencies);
  }
  if (path === publicManifest) {
    const metadata = value.peerDependenciesMeta === undefined ? {} : value.peerDependenciesMeta;
    if (!isObject(metadata)) throw new Error(`Invalid peerDependenciesMeta at ${sha}:${path}`);
    for (const name of Object.keys(manifest.peerDependencies)) {
      if (!Object.hasOwn(metadata, name)) continue;
      const peerMetadata = metadata[name];
      if (
        !isObject(peerMetadata) ||
        (peerMetadata.optional !== undefined && typeof peerMetadata.optional !== "boolean")
      )
        throw new Error(`Invalid peerDependenciesMeta.${name} at ${sha}:${path}`);
      if (peerMetadata.optional === true) manifest.optionalPeers.add(name);
    }
  }
  return manifest;
}

function main() {
  const [base, head, eventPath, ...extra] = process.argv.slice(2);
  if (
    !base ||
    !head ||
    !eventPath ||
    extra.length ||
    !/^[0-9a-f]{40}$/.test(base) ||
    !/^[0-9a-f]{40}$/.test(head)
  )
    throw new Error(
      "Usage: check-dependency-release.mjs <40-hex-base-sha> <40-hex-head-sha> <pull-request-event.json>",
    );
  /** @type {unknown} */
  const event = JSON.parse(readFileSync(eventPath, "utf8"));
  if (
    !isObject(event) ||
    !["opened", "synchronize", "reopened", "edited"].includes(String(event.action))
  )
    throw new Error("Expected an opened, synchronize, reopened or edited pull_request event");
  if (!isObject(event.pull_request) || typeof event.pull_request.title !== "string")
    throw new Error("Pull request event is missing its title");
  for (const sha of [base, head]) {
    if (git("cat-file", "-t", sha) !== "commit") throw new Error(`${sha} is not a commit`);
  }
  if (git("rev-parse", "--is-shallow-repository") !== "false")
    throw new Error("Shallow Git history cannot establish the pull request's merge base.");
  // Base-branch updates are not changes introduced by this pull request.
  const mergeBase = git("merge-base", base, head);
  const baseRoot = readManifest(mergeBase, "package.json");
  const headRoot = readManifest(head, "package.json");
  const basePublic = readManifest(mergeBase, publicManifest);
  const headPublic = readManifest(head, publicManifest);
  /** @type {string[]} */
  const changes = [];
  for (const dependency of [...bundledDependencies, "@github/copilot-sdk"]) {
    for (const section of dependencySections) {
      if (baseRoot[section][dependency] !== headRoot[section][dependency])
        changes.push(`package.json ${section}.${dependency}`);
    }
  }
  for (const section of /** @type {const} */ ([
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ])) {
    const names = new Set([
      ...Object.keys(basePublic[section]),
      ...Object.keys(headPublic[section]),
    ]);
    for (const name of names) {
      if (basePublic[section][name] !== headPublic[section][name])
        changes.push(`${publicManifest} ${section}.${name}`);
      if (
        section === "peerDependencies" &&
        basePublic.optionalPeers.has(name) !== headPublic.optionalPeers.has(name)
      )
        changes.push(`${publicManifest} peerDependenciesMeta.${name}.optional`);
    }
  }
  const sdk = "@github/copilot-sdk";
  if (
    (baseRoot.devDependencies[sdk] !== headRoot.devDependencies[sdk] ||
      basePublic.peerDependencies[sdk] !== headPublic.peerDependencies[sdk]) &&
    (!headRoot.devDependencies[sdk] ||
      headRoot.devDependencies[sdk] !== headPublic.peerDependencies[sdk])
  )
    throw new Error("Root Copilot SDK pin must match the public package's supported peer version.");
  if (!changes.length) {
    console.log("No bundled/runtime or public peer dependency changes; chore titles are allowed.");
    return;
  }
  const title = event.pull_request.title;
  const header = /^([a-z][a-z0-9-]*)(?:\([^()\r\n]+\))?(!)?:[ \t]+\S[^\r\n]*$/.exec(title);
  if (!header || (!header[2] && !["fix", "deps", "feat", "perf"].includes(header[1] ?? "")))
    throw new Error(
      `Runtime dependency changes require a releasable Conventional Commit PR title, such as fix(deps): update runtime dependencies (or explicit breaking intent with !). chore(deps-dev) does not release.\nChanged: ${changes.join(", ")}`,
    );
  console.log(`Releasable dependency changes accepted: ${changes.join(", ")}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
