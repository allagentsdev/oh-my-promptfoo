import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const checker = resolve(import.meta.dir, "../scripts/check-dependency-release.mjs");
const publicPath = "packages/oh-my-promptfoo/package.json";
type Manifest = {
  version: string;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "dependency-release-"));
  const root: Manifest = {
    version: "1.20.2",
    devDependencies: {
      "@github/copilot-sdk": "1.0.22",
      "@opentelemetry/api": "1.9.1",
      "@opentelemetry/context-async-hooks": "2.11.0",
      "@opentelemetry/core": "2.11.0",
      "@opentelemetry/sdk-trace-node": "2.11.0",
      diff: "9.0.0",
      ignore: "7.0.5",
      "import-meta-resolve": "4.2.0",
      "jsonc-parser": "3.3.1",
      typescript: "7.0.2",
      tsdown: "0.23.1",
      "@biomejs/biome": "2.5.15",
      "@types/node": "22.19.15",
    },
  };
  const published: Manifest = {
    version: "1.20.2",
    peerDependencies: { "@github/copilot-sdk": "1.0.22", promptfoo: "0.124.x" },
  };
  function git(...args: string[]) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.error || result.status !== 0)
      throw new Error(result.error?.message ?? result.stderr);
    return result.stdout.trim();
  }
  async function save() {
    await writeFile(join(cwd, "package.json"), JSON.stringify(root));
    await writeFile(join(cwd, publicPath), JSON.stringify(published));
  }
  function commit(message = "fixture") {
    git("add", ".");
    git(
      "-c",
      "user.name=Policy Test",
      "-c",
      "user.email=policy@example.invalid",
      "commit",
      "-qm",
      message,
    );
    return git("rev-parse", "HEAD");
  }
  try {
    await mkdir(join(cwd, "packages/oh-my-promptfoo"), { recursive: true });
    git("init", "-q");
    await save();
    const base = commit();
    async function run(
      title = "chore(deps-dev): update dependencies",
      options: {
        base?: string;
        head?: string;
        action?: string;
        changes?: unknown;
        rawEvent?: string;
        cwd?: string;
      } = {},
    ) {
      const eventPath = join(cwd, "event.json");
      await writeFile(
        eventPath,
        options.rawEvent ??
          JSON.stringify({
            action: options.action ?? "synchronize",
            pull_request: { title },
            changes: options.changes,
          }),
      );
      return spawnSync(
        "node",
        [checker, options.base ?? base, options.head ?? git("rev-parse", "HEAD"), eventPath],
        {
          cwd: options.cwd ?? cwd,
          encoding: "utf8",
        },
      );
    }
    return { cwd, root, published, git, save, commit, run, base };
  } catch (error) {
    await rm(cwd, { recursive: true, force: true });
    throw error;
  }
}

async function branchedFixture(dependency: "typescript" | "ignore") {
  const f = await fixture();
  try {
    const ancestorRoot = structuredClone(f.root);
    f.git("checkout", "-qb", "feature");
    if (f.root.devDependencies) f.root.devDependencies[dependency] = "99.0.0";
    await f.save();
    const head = f.commit("feature dependency change");
    f.git("checkout", "-qb", "base-drift", f.base);
    Object.assign(f.root, ancestorRoot);
    if (f.root.devDependencies) f.root.devDependencies.ignore = "99.0.0";
    await f.save();
    const baseTip = f.commit("independent base dependency change");
    return { ...f, baseTip, head };
  } catch (error) {
    await rm(f.cwd, { recursive: true, force: true });
    throw error;
  }
}

async function comparisonFetchScript() {
  const workflow: unknown = Bun.YAML.parse(
    await readFile(
      resolve(import.meta.dir, "../.github/workflows/dependency-release-policy.yml"),
      "utf8",
    ),
  );
  function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  const jobs = isObject(workflow) ? workflow.jobs : undefined;
  const job = isObject(jobs) ? jobs["dependency-release-policy"] : undefined;
  const steps = isObject(job) ? job.steps : undefined;
  if (!Array.isArray(steps)) throw new Error("Missing dependency release policy steps");
  const step: unknown = steps.find(
    (value: unknown) => isObject(value) && value.name === "Fetch pinned commit histories",
  );
  if (!isObject(step) || typeof step.run !== "string")
    throw new Error("Missing comparison history fetch script");
  return step.run;
}

describe("dependency release intent", () => {
  test("tooling, documentation and release-version-only changes remain chores", async () => {
    const f = await fixture();
    try {
      f.root.version = "1.20.3";
      f.published.version = "1.20.3";
      Object.assign(f.root.devDependencies ?? {}, {
        typescript: "7.0.3",
        tsdown: "0.23.2",
        "@biomejs/biome": "2.5.16",
        "@types/node": "22.19.16",
      });
      await f.save();
      await writeFile(join(f.cwd, "README.md"), "Documentation changes\n");
      f.commit();
      expect((await f.run()).status).toBe(0);
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  });

  test("unchanged dependencies allow release chore titles", async () => {
    const f = await fixture();
    try {
      expect((await f.run("chore(release): release 1.20.3", { head: f.base })).status).toBe(0);
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  });

  for (const { name, dependency, title, status } of [
    {
      name: "main-only runtime bumps do not turn a tooling-only feature into a runtime change",
      dependency: "typescript",
      title: "chore(deps-dev): update tooling",
      status: 0,
    },
    {
      name: "feature runtime bumps still reject chores when main independently matches them",
      dependency: "ignore",
      title: "chore(deps-dev): update dependencies",
      status: 1,
    },
    {
      name: "feature runtime bumps accept release intent when main independently matches them",
      dependency: "ignore",
      title: "fix(deps): update runtime dependencies",
      status: 0,
    },
  ] as const) {
    test(name, async () => {
      const f = await branchedFixture(dependency);
      try {
        const result = await f.run(title, { base: f.baseTip, head: f.head });
        expect(result.status).toBe(status);
        if (dependency === "typescript") {
          expect(result.stdout).toContain("No bundled/runtime or public peer dependency changes");
        } else {
          expect(result.stdout + result.stderr).toContain("package.json devDependencies.ignore");
          if (status === 0)
            expect(result.stdout).toContain("Releasable dependency changes accepted");
        }
      } finally {
        await rm(f.cwd, { recursive: true, force: true });
      }
    });
  }

  test("unrelated pinned commits fail instead of comparing their manifest tips", async () => {
    const f = await fixture();
    try {
      f.git("checkout", "--orphan", "unrelated");
      if (f.root.devDependencies) f.root.devDependencies.typescript = "99.0.0";
      await f.save();
      const head = f.commit();
      const result = await f.run("chore(deps-dev): update tooling", { head });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("git merge-base failed");
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  });

  test("shallow pinned histories fail instead of accepting matching runtime tips", async () => {
    const f = await branchedFixture("ignore");
    try {
      const checkout = join(f.cwd, "shallow-checkout");
      f.git(
        "clone",
        "-q",
        "--no-tags",
        "--depth=1",
        "--branch=feature",
        pathToFileURL(f.cwd).href,
        checkout,
      );
      f.git("-C", checkout, "fetch", "-q", "--no-tags", "--depth=1", "origin", f.baseTip);
      const result = await f.run("chore(deps-dev): update dependencies", {
        base: f.baseTip,
        head: f.head,
        cwd: checkout,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Shallow Git history");
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  });

  test("the workflow fetch restores both pinned histories before classifying a drifted base", async () => {
    const f = await branchedFixture("typescript");
    try {
      const checkout = join(f.cwd, "shallow-checkout");
      f.git(
        "clone",
        "-q",
        "--no-tags",
        "--depth=1",
        "--branch=feature",
        pathToFileURL(f.cwd).href,
        checkout,
      );
      const fetch = spawnSync(
        "bash",
        ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", await comparisonFetchScript()],
        {
          cwd: checkout,
          encoding: "utf8",
          env: { ...process.env, BASE_SHA: f.baseTip, HEAD_SHA: f.head },
        },
      );
      expect(fetch.status).toBe(0);
      expect(f.git("-C", checkout, "rev-parse", "--is-shallow-repository")).toBe("false");
      const result = await f.run("chore(deps-dev): update tooling", {
        base: f.baseTip,
        head: f.head,
        cwd: checkout,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("No bundled/runtime or public peer dependency changes");
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  });

  for (const side of ["base", "head"]) {
    test(`an invalid ${side} SHA aborts the workflow before invoking Git`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), "dependency-release-fetch-"));
      try {
        const calls = join(cwd, "git-calls");
        const result = spawnSync(
          "bash",
          [
            "--noprofile",
            "--norc",
            "-e",
            "-o",
            "pipefail",
            "-c",
            `git() { printf '%s\\n' "$*" >> "$GIT_CALL_LOG"; }\n${await comparisonFetchScript()}`,
          ],
          {
            cwd,
            encoding: "utf8",
            env: {
              ...process.env,
              BASE_SHA: side === "base" ? "--help" : "a".repeat(40),
              HEAD_SHA: side === "head" ? "--help" : "b".repeat(40),
              GIT_CALL_LOG: calls,
            },
          },
        );
        expect(result.status).toBe(1);
        expect(result.stdout + result.stderr).toContain("Invalid pull request commit SHA");
        expect(existsSync(calls)).toBe(false);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    });
  }

  for (const dependency of [
    "diff",
    "ignore",
    "import-meta-resolve",
    "jsonc-parser",
    "@opentelemetry/api",
    "@opentelemetry/context-async-hooks",
    "@opentelemetry/core",
    "@opentelemetry/sdk-trace-node",
  ]) {
    for (const { title, status } of [
      { title: "chore(deps-dev): update dependencies", status: 1 },
      { title: "fix(deps): update runtime dependencies", status: 0 },
    ]) {
      test(`${dependency} updates ${status === 0 ? "accept" : "reject"} ${title}`, async () => {
        const f = await fixture();
        try {
          if (f.root.devDependencies) f.root.devDependencies[dependency] = "99.0.0";
          await f.save();
          f.commit();
          expect((await f.run(title)).status).toBe(status);
        } finally {
          await rm(f.cwd, { recursive: true, force: true });
        }
      });
    }
  }

  for (const { change, choreTitle, releaseTitle } of [
    {
      change: "addition",
      choreTitle: "chore(deps-dev): update dependencies",
      releaseTitle: "deps: update published dependencies",
    },
    {
      change: "removal",
      choreTitle: "chore(deps): remove dependency",
      releaseTitle: "fix(deps): remove dependency",
    },
    {
      change: "peer update",
      choreTitle: "chore(deps-dev): update dependencies",
      releaseTitle: "fix(deps): support the new peer",
    },
  ]) {
    for (const { title, status } of [
      { title: choreTitle, status: 1 },
      { title: releaseTitle, status: 0 },
    ]) {
      test(`public ${change} ${status === 0 ? "accepts" : "rejects"} ${title}`, async () => {
        const f = await fixture();
        try {
          let base = f.base;
          if (change === "removal") {
            f.published.dependencies = { ignore: "7.0.5" };
            await f.save();
            base = f.commit();
            delete f.published.dependencies;
          } else if (change === "addition") {
            f.published.dependencies = { ignore: "7.0.5" };
          } else {
            f.published.peerDependencies = {
              "@github/copilot-sdk": "1.0.22",
              promptfoo: "0.125.x",
            };
          }
          await f.save();
          f.commit();
          expect((await f.run(title, { base })).status).toBe(status);
        } finally {
          await rm(f.cwd, { recursive: true, force: true });
        }
      });
    }
  }

  test("root Copilot upgrades cannot bypass public supported-version alignment", async () => {
    const f = await fixture();
    try {
      if (f.root.devDependencies) f.root.devDependencies["@github/copilot-sdk"] = "1.0.23";
      await f.save();
      f.commit();
      expect((await f.run("fix(deps): update Copilot")).status).toBe(1);
      if (f.published.peerDependencies)
        f.published.peerDependencies["@github/copilot-sdk"] = "1.0.23";
      await f.save();
      f.commit();
      expect((await f.run("fix(deps): update Copilot")).status).toBe(0);
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  });

  test("public-only Copilot upgrades require the root pin to follow", async () => {
    const f = await fixture();
    try {
      if (f.published.peerDependencies)
        f.published.peerDependencies["@github/copilot-sdk"] = "1.0.23";
      await f.save();
      f.commit();
      const mismatch = await f.run("fix(deps): update supported Copilot");
      expect(mismatch.status).toBe(1);
      expect(mismatch.stderr).toContain("Root Copilot SDK pin must match");
      if (f.root.devDependencies) f.root.devDependencies["@github/copilot-sdk"] = "1.0.23";
      await f.save();
      f.commit();
      expect((await f.run("fix(deps): update supported Copilot")).status).toBe(0);
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  });

  test("aligned Copilot upgrades still require release intent", async () => {
    const f = await fixture();
    try {
      if (f.root.devDependencies) f.root.devDependencies["@github/copilot-sdk"] = "1.0.23";
      if (f.published.peerDependencies)
        f.published.peerDependencies["@github/copilot-sdk"] = "1.0.23";
      await f.save();
      f.commit();
      expect((await f.run()).status).toBe(1);
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  });

  for (const removed of ["root", "public", "both"]) {
    test(`removing the ${removed} Copilot declaration cannot bypass alignment`, async () => {
      const f = await fixture();
      try {
        if (removed !== "public" && f.root.devDependencies)
          delete f.root.devDependencies["@github/copilot-sdk"];
        if (removed !== "root" && f.published.peerDependencies)
          delete f.published.peerDependencies["@github/copilot-sdk"];
        await f.save();
        f.commit();
        const result = await f.run("fix(deps): remove Copilot declaration");
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("Root Copilot SDK pin must match");
      } finally {
        await rm(f.cwd, { recursive: true, force: true });
      }
    });
  }

  const requiredMetadata: Array<{
    name: string;
    metadata: Manifest["peerDependenciesMeta"];
  }> = [
    { name: "absent metadata", metadata: undefined },
    { name: "absent peer entry", metadata: {} },
    { name: "absent optionality", metadata: { promptfoo: {} } },
    { name: "explicit required optionality", metadata: { promptfoo: { optional: false } } },
  ];
  for (const { name, metadata } of requiredMetadata) {
    for (const { title, status } of [
      { title: "chore(deps): require promptfoo", status: 1 },
      { title: "fix(deps): require promptfoo", status: 0 },
    ]) {
      test(`optional-to-required via ${name} ${status === 0 ? "accepts" : "rejects"} ${title}`, async () => {
        const f = await fixture();
        try {
          f.published.peerDependenciesMeta = { promptfoo: { optional: true } };
          await f.save();
          const base = f.commit();
          if (metadata === undefined) delete f.published.peerDependenciesMeta;
          else f.published.peerDependenciesMeta = metadata;
          await f.save();
          f.commit();
          expect((await f.run(title, { base })).status).toBe(status);
        } finally {
          await rm(f.cwd, { recursive: true, force: true });
        }
      });
    }
  }

  for (const { title, status } of [
    { title: "chore(deps): make promptfoo optional", status: 1 },
    { title: "fix(deps): make promptfoo optional", status: 0 },
  ]) {
    test(`required-to-optional ${status === 0 ? "accepts" : "rejects"} ${title}`, async () => {
      const f = await fixture();
      try {
        f.published.peerDependenciesMeta = { promptfoo: { optional: true } };
        await f.save();
        f.commit();
        expect((await f.run(title)).status).toBe(status);
      } finally {
        await rm(f.cwd, { recursive: true, force: true });
      }
    });
  }

  const equivalentMetadata: Array<{
    name: string;
    metadata: NonNullable<Manifest["peerDependenciesMeta"]>;
  }> = [
    { name: "explicit required peer", metadata: { promptfoo: { optional: false } } },
    { name: "absent optionality", metadata: { promptfoo: {} } },
    { name: "absent peer entry", metadata: {} },
    { name: "undeclared optional peer", metadata: { undeclared: { optional: true } } },
  ];
  for (const { name, metadata } of equivalentMetadata) {
    test(`${name} metadata remains a chore`, async () => {
      const f = await fixture();
      try {
        f.published.peerDependenciesMeta = metadata;
        await f.save();
        f.commit();
        expect((await f.run()).status).toBe(0);
      } finally {
        await rm(f.cwd, { recursive: true, force: true });
      }
    });
  }

  test("irrelevant metadata and formatting changes remain chores", async () => {
    const f = await fixture();
    try {
      await writeFile(
        join(f.cwd, publicPath),
        JSON.stringify(
          {
            ...f.published,
            peerDependenciesMeta: {
              promptfoo: { optional: false, note: "irrelevant" },
              undeclared: null,
            },
          },
          null,
          2,
        ),
      );
      f.commit();
      expect((await f.run()).status).toBe(0);
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  });

  for (const { name, metadata } of [
    { name: "null metadata", metadata: null },
    { name: "array metadata", metadata: [] },
    { name: "string metadata", metadata: "optional" },
    { name: "null peer entry", metadata: { promptfoo: null } },
    { name: "array peer entry", metadata: { promptfoo: [] } },
    { name: "boolean peer entry", metadata: { promptfoo: true } },
    { name: "string optionality", metadata: { promptfoo: { optional: "true" } } },
    { name: "numeric optionality", metadata: { promptfoo: { optional: 0 } } },
    { name: "null optionality", metadata: { promptfoo: { optional: null } } },
  ]) {
    for (const side of ["base", "head"]) {
      test(`${name} fails closed in the ${side} public manifest`, async () => {
        const f = await fixture();
        try {
          await writeFile(
            join(f.cwd, publicPath),
            JSON.stringify({ ...f.published, peerDependenciesMeta: metadata }),
          );
          const invalid = f.commit();
          if (side === "base") {
            await f.save();
            f.commit();
          }
          const options = side === "base" ? { base: invalid } : {};
          const result = await f.run("fix(deps): update peer metadata", options);
          expect(result.status).toBe(1);
          expect(result.stderr).toContain("Invalid peerDependenciesMeta");
        } finally {
          await rm(f.cwd, { recursive: true, force: true });
        }
      });
    }
  }

  for (const { title, status } of [
    { title: "fix(deps): update", status: 0 },
    { title: "deps: update", status: 0 },
    { title: "feat: update", status: 0 },
    { title: "perf: update", status: 0 },
    { title: "chore(deps)!: update", status: 0 },
    { title: "chore(deps-dev): update", status: 1 },
    { title: "fix(deps) update", status: 1 },
    { title: "fix(deps):", status: 1 },
    { title: "fix: update\nchore: other", status: 1 },
    { title: "chore: BREAKING CHANGE: update", status: 1 },
  ]) {
    test(`title edits ${status === 0 ? "accept" : "reject"} ${JSON.stringify(title)}`, async () => {
      const f = await fixture();
      try {
        if (f.root.devDependencies) delete f.root.devDependencies.diff;
        await f.save();
        f.commit();
        const result = await f.run(title, {
          action: "edited",
          changes: { title: { from: "old title" } },
        });
        expect(result.status).toBe(status);
      } finally {
        await rm(f.cwd, { recursive: true, force: true });
      }
    });
  }

  for (const { name, changes } of [
    { name: "body", changes: { body: { from: "old body" } } },
    { name: "base branch", changes: { base: { ref: { from: "old-base" } } } },
    { name: "unreported metadata", changes: undefined },
  ]) {
    for (const { title, status } of [
      { title: "chore(deps-dev): update runtime dependencies", status: 1 },
      { title: "fix(deps): update runtime dependencies", status: 0 },
    ]) {
      test(`${name} edits ${status === 0 ? "accept" : "reject"} the current title ${title}`, async () => {
        const f = await fixture();
        try {
          if (f.root.devDependencies) delete f.root.devDependencies.diff;
          await f.save();
          f.commit();
          const result = await f.run(title, { action: "edited", changes });
          expect(result.status).toBe(status);
          expect(result.stdout + result.stderr).toContain("package.json devDependencies.diff");
        } finally {
          await rm(f.cwd, { recursive: true, force: true });
        }
      });
    }
  }

  test("title edit contents remain data rather than shell commands", async () => {
    const f = await fixture();
    try {
      if (f.root.devDependencies) delete f.root.devDependencies.diff;
      await f.save();
      f.commit();
      const result = await f.run("fix(deps): $(touch injected)", {
        action: "edited",
        changes: { title: { from: "old title" } },
      });
      expect(result.status).toBe(0);
      expect(existsSync(join(f.cwd, "injected"))).toBe(false);
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  });

  for (const base of ["HEAD", "--help", "a".repeat(40)]) {
    test(`invalid or missing base commit ${base} fails closed`, async () => {
      const f = await fixture();
      try {
        expect((await f.run("fix(deps): update", { base })).status).toBe(1);
      } finally {
        await rm(f.cwd, { recursive: true, force: true });
      }
    });
  }

  for (const side of ["base", "head"]) {
    test(`a non-commit ${side} object fails closed`, async () => {
      const f = await fixture();
      try {
        const blob = f.git("rev-parse", "HEAD:package.json");
        const result = await f.run("fix(deps): update", { [side]: blob });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`${blob} is not a commit`);
      } finally {
        await rm(f.cwd, { recursive: true, force: true });
      }
    });
  }

  for (const { name, rawEvent } of [
    { name: "malformed JSON", rawEvent: "{" },
    {
      name: "missing title",
      rawEvent: JSON.stringify({ action: "synchronize", pull_request: {} }),
    },
  ]) {
    test(`${name} pull request event fails closed`, async () => {
      const f = await fixture();
      try {
        expect((await f.run("fix(deps): update", { rawEvent })).status).toBe(1);
      } finally {
        await rm(f.cwd, { recursive: true, force: true });
      }
    });
  }

  test("missing pull request event fails closed", async () => {
    const f = await fixture();
    try {
      const missingEvent = spawnSync(
        "node",
        [checker, f.base, f.base, join(f.cwd, "missing.json")],
        { cwd: f.cwd },
      );
      expect(missingEvent.status).toBe(1);
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  });

  for (const { name, manifest } of [
    { name: "null manifest", manifest: null },
    { name: "array manifest", manifest: [] },
    { name: "array dependency section", manifest: { dependencies: [] } },
    { name: "numeric dependency version", manifest: { dependencies: { ignore: 1 } } },
    { name: "blank dependency version", manifest: { dependencies: { ignore: " " } } },
  ]) {
    test(`${name} fails closed`, async () => {
      const f = await fixture();
      try {
        await writeFile(join(f.cwd, publicPath), JSON.stringify(manifest));
        f.commit();
        expect((await f.run("fix(deps): update")).status).toBe(1);
      } finally {
        await rm(f.cwd, { recursive: true, force: true });
      }
    });
  }

  test("malformed public manifest JSON fails closed", async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.cwd, publicPath), "{");
      f.commit();
      expect((await f.run("fix(deps): update")).status).toBe(1);
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  });

  test("missing public manifest fails closed", async () => {
    const f = await fixture();
    try {
      await rm(join(f.cwd, publicPath));
      f.commit();
      expect((await f.run("fix(deps): update")).status).toBe(1);
    } finally {
      await rm(f.cwd, { recursive: true, force: true });
    }
  });
});
