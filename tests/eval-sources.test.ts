import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "vitest";
import {
  addSourceLinks,
  renderSummary,
  summarizeEvaluation,
} from "../packages/oh-my-promptfoo/src/reporting";

const native = (tests: Record<string, unknown>[]) => ({
  config: { description: "Authored suite" },
  results: {
    stats: { successes: tests.length, failures: 0, errors: 0 },
    results: tests.map((testCase, index) => ({
      testCase,
      testIdx: index,
      promptIdx: 0,
      success: true,
      failureReason: 0,
      score: 1,
      response: { output: "PRIVATE_ANSWER" },
    })),
  },
});

async function repository(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "omp source links "));
  const git = async (...args: string[]) =>
    (await promisify(execFile)("git", ["-C", root, ...args])).stdout.trim();
  await git("init", "-q");
  for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content);
  await git("add", "--", ".");
  await git(
    "-c",
    "user.name=Source test",
    "-c",
    "user.email=source@example.test",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--no-gpg-sign",
    "-qm",
    "Authored definitions",
  );
  return {
    root,
    source: {
      configPath: "suite.yaml",
      repositoryRoot: root,
      repositoryUrl: "https://github.com/example/evals",
      revision: await git("rev-parse", "HEAD"),
    },
  };
}

test("filtered, reordered and repeated native rows link to committed YAML sections in tables and details", async () => {
  const { root, source } = await repository({
    "suite.yaml":
      "description: Authored suite\ntests:\n  - description: Inline case\n    vars: {input: inline}\n  - file://cases *.yaml\n",
    "cases #1.yaml":
      "- description: First external\n  vars: {input: first}\n- description: Repeated label\n  vars: {input: A}\n- description: Repeated label\n  vars: {input: B}\n",
  });
  try {
    // The report links to evaluated history even if the checkout has changed since.
    await writeFile(join(root, "cases #1.yaml"), "\n\n- description: Changed checkout\n");
    const input = native([
      { description: "Repeated label", vars: { input: "B" } },
      { description: "Inline case", vars: { input: "inline" } },
      { description: "First external", vars: { input: "first" } },
      { description: "First external", vars: { input: "first" } },
    ]);
    const report = summarizeEvaluation(input, 0, { publicLabels: true });
    const linked = await addSourceLinks(report, source, input);
    assert.deepEqual(linked.counts, report.counts);
    assert.deepEqual(
      linked.cases.map((item) => item.source?.url),
      [
        `https://github.com/example/evals/blob/${source.revision}/cases%20%231.yaml#L5`,
        `https://github.com/example/evals/blob/${source.revision}/suite.yaml#L3`,
        `https://github.com/example/evals/blob/${source.revision}/cases%20%231.yaml#L1`,
        `https://github.com/example/evals/blob/${source.revision}/cases%20%231.yaml#L1`,
      ],
    );
    const markdown = renderSummary(linked);
    assert.ok(markdown.startsWith("## Authored suite — ✅ PASS"));
    assert.ok(!markdown.includes("Suite 1"));
    assert.ok(markdown.includes("[Test 1 · Repeated label](<https://github.com/"));
    assert.ok(markdown.includes('<summary><a href="https://github.com/'));
    assert.ok(!JSON.stringify(linked).includes("PRIVATE_ANSWER"));
    const offline = await addSourceLinks(report, source);
    assert.equal(offline.cases[2].source?.url, linked.cases[2].source?.url);
    const reordered = await addSourceLinks(
      { ...report, cases: [...report.cases].reverse() },
      source,
      input,
    );
    assert.equal(reordered.cases[0].source?.url, linked.cases[3].source?.url);
    assert.equal(reordered.cases[3].source?.url, linked.cases[0].source?.url);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ambiguous and non-YAML sources link to files without invented line anchors; unsafe URLs never render", async () => {
  const { root, source } = await repository({
    "suite.yaml": "tests: file://cases.yaml\n",
    "cases.yaml":
      "- description: Duplicate\n  vars: {input: same}\n- description: Duplicate\n  vars: {input: same}\n",
    "csv.yaml": "tests: file://cases.csv\n",
    "cases.csv": "__description,input\nCSV row,value\n",
    "secret.yaml": "tests: file://PRIVATE_TOKEN.yaml\n",
    "PRIVATE_TOKEN.yaml": "- description: Public label\n  vars: {input: value}\n",
    "mixed.yaml":
      "tests:\n  - description: Duplicate\n    vars: {input: same}\n  - description: Duplicate\n    vars: {input: same}\n  - file://other.yaml\n",
    "other.yaml": "- description: Unrelated\n  vars: {input: other}\n",
    "generated.yaml": "tests: {path: 'file://cases.mjs', config: {count: 2}}\n",
    "cases.mjs": "throw new Error('Source lookup must not execute generators');\n",
    "opaque.yaml": "tests:\n  - vars: {input: same}\n  - file://cases.csv\n",
    "scenario.yaml":
      "scenarios:\n  - config: [{vars: {topic: fixture}}]\n    tests: file://cases.json\n",
    "cases.json": '[\n  {"description": "JSON scenario", "vars": {"input": "json"}}\n]\n',
  });
  try {
    const input = native([{ description: "Duplicate", vars: { input: "same" } }]);
    const report = summarizeEvaluation(input, 0, { publicLabels: true });
    const linked = await addSourceLinks(report, source, input);
    assert.deepEqual(linked.cases[0].source, {
      url: `https://github.com/example/evals/blob/${source.revision}/cases.yaml`,
      location: "file",
    });
    assert.ok(renderSummary(linked).includes("Source file; exact test location unavailable"));
    const mixed = await addSourceLinks(report, { ...source, configPath: "mixed.yaml" }, input);
    assert.deepEqual(mixed.cases[0].source, {
      url: `https://github.com/example/evals/blob/${source.revision}/mixed.yaml`,
      location: "file",
    });
    const generatedInput = native([{ vars: { input: "one" } }, { vars: { input: "two" } }]);
    const generated = await addSourceLinks(
      summarizeEvaluation(generatedInput, 0, { publicLabels: true }),
      { ...source, configPath: "generated.yaml" },
      generatedInput,
    );
    assert.ok(
      generated.cases.every(
        (item) => item.source?.location === "file" && item.source.url.endsWith("/cases.mjs"),
      ),
    );
    assert.equal(generated.status, "pass");
    const opaqueInput = native([{ description: "Row #1", vars: { input: "same", extra: "csv" } }]);
    const opaque = await addSourceLinks(
      summarizeEvaluation(opaqueInput, 0, { publicLabels: true }),
      { ...source, configPath: "opaque.yaml" },
      opaqueInput,
    );
    assert.deepEqual(opaque.cases[0].source, {
      url: `https://github.com/example/evals/blob/${source.revision}/opaque.yaml`,
      location: "file",
    });
    const jsonInput = native([{ description: "JSON scenario", vars: { input: "json" } }]);
    const scenario = await addSourceLinks(
      summarizeEvaluation(jsonInput, 0, { publicLabels: true }),
      { ...source, configPath: "scenario.yaml" },
      jsonInput,
    );
    assert.deepEqual(scenario.cases[0].source, {
      url: `https://github.com/example/evals/blob/${source.revision}/cases.json#L2`,
      location: "test",
    });
    const csv = await addSourceLinks(report, { ...source, configPath: "csv.yaml" }, input);
    assert.deepEqual(csv.cases[0].source, {
      url: `https://github.com/example/evals/blob/${source.revision}/cases.csv`,
      location: "file",
    });
    const secretInput = native([{ description: "Public label", vars: { input: "value" } }]);
    const secretReport = await addSourceLinks(
      summarizeEvaluation(secretInput, 0, { publicLabels: true }),
      { ...source, configPath: "secret.yaml" },
      secretInput,
      ["PRIVATE_TOKEN"],
    );
    assert.ok(!JSON.stringify(secretReport).includes("PRIVATE_TOKEN"));
    assert.equal(
      await addSourceLinks(report, { ...source, revision: "0".repeat(40) }, input),
      report,
    );
    for (const repositoryUrl of [
      "javascript:alert(1)",
      "https://credential@github.com/example/evals",
      "https://github.com/example/evals?token=PRIVATE_TOKEN",
    ])
      assert.equal(await addSourceLinks(report, { ...source, repositoryUrl }, input), report);
    const hostile = structuredClone(report);
    hostile.cases[0].source = { url: "javascript:alert(1)", location: "test" };
    assert.ok(!renderSummary(hostile).includes("javascript:"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recorded reports render their pinned definition links without resolving Git history", async () => {
  const sample = JSON.parse(
    await readFile(resolve(import.meta.dirname, "../examples/ci/live-report.json"), "utf8"),
  );
  const markdown = renderSummary(sample.report);
  assert.equal((markdown.match(/\[Test \d+ ·/g) ?? []).length, 6);
  assert.equal((markdown.match(/promptfooconfig\.yaml#L\d+/g) ?? []).length, 12);
  assert.ok(
    sample.report.cases.every(
      (item: any) =>
        item.source.url.includes(`/blob/${sample.workspaceCommit}/`) &&
        item.source.location === "test",
    ),
  );
});
