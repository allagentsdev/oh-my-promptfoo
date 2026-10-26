import { createHash } from "node:crypto";
import { assertions } from "promptfoo";
import { expect, test } from "vitest";
import { withAssertions } from "../packages/oh-my-promptfoo/src/assertion-integration.js";
import { llmAssert } from "../packages/oh-my-promptfoo/src/assertions.js";
import { workspaceEvidence } from "../packages/oh-my-promptfoo/src/workspace-evidence.js";

function context(content = "captured final bytes") {
  const bytes = Buffer.from(content);
  return {
    providerResponse: {
      metadata: {
        fileChanges: {
          schemaVersion: 2,
          status: "complete",
          truncated: false,
          deletedFiles: [],
          changedFiles: {
            "file.txt": {
              kind: "file",
              mode: "100644",
              change: "added",
              encoding: "base64",
              content: bytes.toString("base64"),
              size: bytes.length,
              sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
            },
          },
        },
      },
    },
  };
}
test("llmAssert judge receives selected captured contents and reports provenance", async () => {
  const prompts: string[] = [];
  const provider = {
    id: () => "evidence-judge",
    callApi: async (prompt: string) => {
      prompts.push(prompt);
      return {
        output: JSON.stringify({
          components: [{ metric: "file", score: 1, reason: "Captured text verified" }],
        }),
      };
    },
  };
  const result = await llmAssert("claimed answer", {
    ...context(),
    config: {
      provider,
      workspaceEvidence: { files: ["file.txt"] },
      components: [{ metric: "file", value: "File has the expected content" }],
    },
  });
  expect(result).toMatchObject({
    pass: true,
    metadata: { workspaceEvidence: { includedPaths: ["file.txt"], truncated: false } },
  });
  expect(prompts[0]).toContain("captured final bytes");
  expect(prompts[0]).toContain("Untrusted captured workspace evidence");
});
test("evidence budgets bound UTF-8 JSON, record omissions, and never split text unsafely", async () => {
  const evidence = await workspaceEvidence({ maxBytes: 512 }, context("雪".repeat(1000)));
  expect(Buffer.byteLength(evidence.block)).toBeLessThanOrEqual(512);
  expect(evidence.block).not.toContain("�");
  expect(evidence.metadata).toMatchObject({ truncated: true });
  const payload = JSON.parse(evidence.block.slice(evidence.block.indexOf("\n") + 1));
  expect(payload.files[0]).toMatchObject({ path: "file.txt", truncated: true });
  expect(payload.files[0].content).toMatch(/^雪+$/);
});
test("missing capture or selected paths fail before a paid judge call", async () => {
  let calls = 0;
  const provider = {
    id: () => "unused",
    callApi: async () => {
      calls++;
      return { output: "{}" };
    },
  };
  for (const evidence of [{}, context()]) {
    const result = await llmAssert("claim", {
      ...evidence,
      config: {
        provider,
        workspaceEvidence: { files: ["missing"] },
        components: [{ metric: "file", value: "Has file" }],
      },
    });
    expect(result).toMatchObject({ pass: false, score: 0, metadata: { graderError: true } });
  }
  expect(calls).toBe(0);
});
test("native llm-rubric wrapper uses stock grading and attaches capture metadata", async () => {
  const prompts: string[] = [];
  const provider = {
    id: () => "native-evidence-judge",
    callApi: async (prompt: string) => {
      prompts.push(prompt);
      return {
        output: JSON.stringify({ pass: true, score: 0.9, reason: "Native rubric verified" }),
      };
    },
  };
  const configured = withAssertions({
    defaultTest: {
      options: { workspaceEvidence: true },
      assert: [{ type: "llm-rubric", provider, value: "The file contains captured final bytes" }],
    },
  }).defaultTest;
  const result = await assertions.runAssertions({
    ...context(),
    test: configured as Parameters<typeof assertions.runAssertions>[0]["test"],
  });
  expect(result).toMatchObject({
    pass: true,
    score: 0.9,
    componentResults: [{ metadata: { workspaceEvidence: { includedPaths: ["file.txt"] } } }],
  });
  expect(prompts[0]).toContain("captured final bytes");
});

test("native image normalization cannot discard captured workspace evidence", async () => {
  const prompts: string[] = [];
  const provider = {
    id: () => "image-judge",
    callApi: async (prompt: string) => {
      prompts.push(prompt);
      return {
        output: JSON.stringify({ pass: true, score: 1, reason: "Files and image inspected" }),
      };
    },
  };
  const configured = withAssertions({
    defaultTest: {
      options: { provider, workspaceEvidence: true },
      assert: [{ type: "llm-rubric", value: "Inspect the file and image" }],
    },
  }).defaultTest;
  const source = context();
  const result = await assertions.runAssertions({
    test: configured as Parameters<typeof assertions.runAssertions>[0]["test"],
    providerResponse: {
      ...source.providerResponse,
      output: "data:image/png;base64,aGVsbG8=",
      images: [{ data: "data:image/png;base64,aGVsbG8=", mimeType: "image/png" }],
    },
  });
  expect(result).toMatchObject({ pass: true, score: 1 });
  expect(prompts[0]).toContain("captured final bytes");
});

test("judge evidence distinguishes capture omissions from a complete empty capture", async () => {
  const complete = context();
  complete.providerResponse.metadata.fileChanges.changedFiles =
    {} as typeof complete.providerResponse.metadata.fileChanges.changedFiles;
  const empty = await workspaceEvidence(true, complete);
  expect(JSON.parse(empty.block.slice(empty.block.indexOf("\n") + 1))).toMatchObject({
    capture: { status: "complete", omittedCount: 0 },
    files: [],
  });
  const source = context();
  const partial = {
    ...source.providerResponse.metadata.fileChanges,
    status: "truncated",
    truncated: true,
    truncation: { codes: ["FILE_COUNT"], omittedPaths: ["not-captured.txt"] },
  };
  const evidence = await workspaceEvidence(true, {
    providerResponse: { metadata: { fileChanges: partial } },
  });
  expect(JSON.parse(evidence.block.slice(evidence.block.indexOf("\n") + 1))).toMatchObject({
    capture: {
      status: "truncated",
      omittedCount: 1,
      omittedPaths: ["not-captured.txt"],
      codes: ["FILE_COUNT"],
    },
  });
  partial.changedFiles = {} as typeof partial.changedFiles;
  await expect(
    workspaceEvidence(true, { providerResponse: { metadata: { fileChanges: partial } } }),
  ).rejects.toThrow(/omitted all/);
});

test("byte-boundary budgets never send a nonempty file as an empty truncated placeholder", async () => {
  for (let length = 20; length <= 32; length++) {
    const source = context("雪".repeat(100));
    const file = source.providerResponse.metadata.fileChanges.changedFiles["file.txt"];
    const fileChanges = {
      ...source.providerResponse.metadata.fileChanges,
      changedFiles: { ["x".repeat(length)]: file },
    };
    try {
      const evidence = await workspaceEvidence(
        { maxBytes: 256 },
        { providerResponse: { metadata: { fileChanges } } },
      );
      expect(Buffer.byteLength(evidence.block)).toBeLessThanOrEqual(256);
      const payload = JSON.parse(evidence.block.slice(evidence.block.indexOf("\n") + 1));
      expect(payload.files[0].content).toMatch(/^雪+$/);
    } catch (cause) {
      if (!(cause instanceof Error) || !/omitted all/.test(cause.message)) throw cause;
    }
  }
});
