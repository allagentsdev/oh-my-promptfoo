import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { parse } from "yaml";
import {
  prepareResultArtifact,
  renderResultArtifactLink,
} from "../packages/oh-my-promptfoo/src/reporting";
import { testEntries } from "./global-setup";

const url = "https://github.com/example/evals/actions/runs/1/artifacts/2";

test("approved scored copies keep native answers, reasons and numbers while redacting credentials and preserving private originals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "omp artifact "));
  try {
    const result = join(directory, "results.json"),
      artifact = join(directory, "scored.json");
    const input = {
      config: { env: { API_KEY: 'secret-"value', TOKEN: "7" } },
      results: {
        results: [
          {
            score: 1,
            latencyMs: 7,
            response: { output: 'The answer is READY; secret-"value' },
            gradingResult: { reason: 'Expected READY; secret-"value', pass: false },
            metadata: { url: "https://user:password@example.test/path", number: "7" },
          },
        ],
      },
    };
    const original = JSON.stringify(input);
    await writeFile(result, original);
    await prepareResultArtifact(result, artifact, ["secret-", ""]);
    const text = await readFile(artifact, "utf8"),
      output = JSON.parse(text);
    assert.ok(text.includes("The answer is READY") && text.includes("Expected READY"));
    assert.ok(!text.includes("secret-") && !text.includes("user:password"));
    assert.equal(output.config.env.TOKEN, "[REDACTED]");
    assert.equal(output.config.env.API_KEY, "[REDACTED]");
    assert.equal(output.results.results[0].response.output, "The answer is READY; [REDACTED]");
    assert.equal(output.results.results[0].metadata.number, "[REDACTED]");
    assert.equal(output.results.results[0].latencyMs, 7);
    assert.equal(output.results.results[0].score, 1);
    assert.equal(output.results.results[0].gradingResult.pass, false);
    assert.equal(await readFile(result, "utf8"), original);
    if (process.platform !== "win32") assert.equal((await stat(artifact)).mode & 0o777, 0o600);
    await assert.rejects(prepareResultArtifact(result, result));
    assert.equal(await readFile(result, "utf8"), original);
    await writeFile(join(directory, "malformed.json"), "{");
    await assert.rejects(
      prepareResultArtifact(join(directory, "malformed.json"), join(directory, "missing.json")),
    );
    await assert.rejects(stat(join(directory, "missing.json")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact notes use confirmed URLs and known retention without assuming fourteen days", () => {
  assert.equal(
    renderResultArtifactLink(url, 14),
    `\nAgent output and judge reasons: [download the scored result](<${url}>) (expires in 14 days).\n`,
  );
  assert.ok(renderResultArtifactLink(url, 1).includes("expires in 1 day)"));
  assert.ok(renderResultArtifactLink(url).includes("retention follows repository settings"));
  for (const invalid of [
    "javascript:alert(1)",
    "https://secret@github.com/a",
    `${url}?token=secret`,
    `${url}#secret`,
  ])
    assert.throws(() => renderResultArtifactLink(invalid));
  for (const days of [0, -1, 1.5, Number.NaN])
    assert.throws(() => renderResultArtifactLink(url, days));
});

test("real Action preparation and footer steps preserve failure summaries and resolve repository or overridden retention", async () => {
  const root = resolve(import.meta.dirname, "..");
  const directory = await mkdtemp(join(tmpdir(), "omp artifact action "));
  try {
    const action = parse(await readFile(join(root, "action.yml"), "utf8"));
    const actionRoot = join(directory, "action with spaces"),
      dist = join(actionRoot, "packages/oh-my-promptfoo/dist");
    await mkdir(resolve(dist, ".."), { recursive: true });
    await symlink(testEntries, dist, process.platform === "win32" ? "junction" : "dir");
    const result = join(directory, "results.json"),
      outputs = join(directory, "outputs");
    await writeFile(
      result,
      JSON.stringify({
        config: { env: { API_KEY: "artifact-canary" } },
        results: {
          results: [
            {
              success: false,
              response: { output: "READY artifact-canary" },
              gradingResult: { reason: "Expected something else" },
            },
          ],
        },
      }),
    );
    const env = {
      ...process.env,
      OMP_ACTION_PATH: actionRoot,
      OMP_RESULT_PATH: result,
      OMP_RESULT_DIRECTORY: directory,
      OMP_ARTIFACT_RETENTION_DAYS: "0",
      GITHUB_OUTPUT: outputs,
    };
    const prepare = spawnSync(
      "bash",
      ["-e", "-c", action.runs.steps.find((step: any) => step.id === "scored").run],
      { env, encoding: "utf8" },
    );
    assert.equal(prepare.status, 0, prepare.stderr);
    const artifact = await readFile(join(directory, "scored-results.json"), "utf8");
    assert.ok(artifact.includes("Expected something else") && artifact.includes("READY"));
    assert.ok(!artifact.includes("artifact-canary"));
    assert.ok((await readFile(outputs, "utf8")).includes(join(directory, "scored-results.json")));
    for (const [requested, maximum, expected] of [
      ["0", "90", "90 days"],
      ["14", "90", "14 days"],
      ["180", "90", "90 days"],
      ["0", "", "repository settings"],
    ]) {
      const summary = join(directory, "summary.md"),
        github = join(directory, "github.md");
      await writeFile(summary, "## Evals — ❌ FAIL\n");
      await writeFile(github, "");
      const footer = spawnSync(
        "bash",
        [
          "-e",
          "-c",
          action.runs.steps.find(
            (step: any) => step.name === "Link the scored result in the suite card",
          ).run,
        ],
        {
          env: {
            ...env,
            OMP_SUMMARY_PATH: summary,
            GITHUB_STEP_SUMMARY: github,
            OMP_ARTIFACT_URL: url,
            OMP_ARTIFACT_RETENTION_DAYS: requested,
            GITHUB_RETENTION_DAYS: maximum,
          },
          encoding: "utf8",
        },
      );
      assert.equal(footer.status, 0, footer.stderr);
      assert.ok((await readFile(summary, "utf8")).startsWith("## Evals — ❌ FAIL"));
      const note = await readFile(github, "utf8");
      assert.ok(note.includes(url) && note.includes(expected));
      assert.ok(!note.includes("Expected something else") && !note.includes("READY"));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
