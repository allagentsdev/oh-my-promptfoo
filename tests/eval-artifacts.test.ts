import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
  prepareResultArtifact,
  renderResultArtifactLink,
} from "../packages/oh-my-promptfoo/src/reporting";

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
    for (const [index, empty] of [{}, { results: { results: [] } }].entries()) {
      const inputPath = join(directory, `empty-${index}.json`);
      const destination = join(directory, `empty-${index}-scored.json`);
      await writeFile(inputPath, JSON.stringify(empty));
      await assert.rejects(prepareResultArtifact(inputPath, destination), /native evaluation rows/);
      await assert.rejects(stat(destination));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("artifact notes use confirmed URLs and known retention without assuming fourteen days", () => {
  assert.equal(
    renderResultArtifactLink(url, 14),
    `\nCandidate output and judge reasons: [download the scored result](<${url}>) (expires in 14 days).\n`,
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
