import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { workspaceFile } from "../packages/oh-my-promptfoo/src/workspace-file.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.mocked(open).mockReset();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function retainedRoot() {
  const root = await mkdtemp(join(tmpdir(), "workspace-file-"));
  roots.push(root);
  return root;
}
function capture(files: Record<string, string | Buffer>, deletedFiles: string[] = []) {
  return {
    schemaVersion: 2,
    status: "complete",
    truncated: false,
    deletedFiles,
    changedFiles: Object.fromEntries(
      Object.entries(files).map(([path, value]) => {
        const bytes = Buffer.from(value);
        return [
          path,
          {
            kind: "file",
            mode: "100644",
            change: "added",
            encoding: "base64",
            content: bytes.toString("base64"),
            size: bytes.length,
            sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          },
        ];
      }),
    ),
  };
}
function grade(config: unknown, fileChanges?: unknown, path?: string) {
  return workspaceFile("answer is not evidence", {
    config,
    providerResponse: { metadata: { fileChanges, ...(path ? { workspace: { path } } : {}) } },
  });
}
test("captured bytes determine all file clauses and named multi-file results", async () => {
  const result = await grade(
    {
      files: [
        {
          path: "result.json",
          isJson: true,
          jsonPath: { path: "$.items", equals: [1, 2] },
          byteLength: 15,
        },
        { path: "note.txt", contains: "done", regex: "^done", equals: "done\n" },
      ],
    },
    capture({ "result.json": '{"items":[1,2]}', "note.txt": "done\n" }),
  );
  expect(result).toMatchObject({
    pass: true,
    score: 1,
    namedScores: { "result.json": 1, "note.txt": 1 },
  });
  const failed = await grade(
    {
      files: [
        { path: "a", contains: "yes" },
        { path: "b", contains: "yes" },
      ],
    },
    capture({ a: "yes", b: "no" }),
  );
  expect(failed).toMatchObject({ pass: false, score: 0, namedScores: { a: 1, b: 0 } });
  expect(failed.componentResults).toHaveLength(2);
});
test("missing capture and unobserved files are errors, not evidence of absence", async () => {
  expect(await grade({ path: "missing", absent: true })).toMatchObject({
    pass: false,
    metadata: { graderError: true },
  });
  expect(await grade({ path: "missing", absent: true }, capture({}))).toMatchObject({
    pass: false,
    metadata: { graderError: true },
  });
  expect(await grade({ path: "deleted", absent: true }, capture({}, ["deleted"]))).toMatchObject({
    pass: true,
  });
  expect(await grade({ path: "deleted" }, capture({}, ["deleted"]))).toMatchObject({
    pass: false,
    metadata: { graderError: true },
  });
  expect(await grade({ path: "present", absent: true }, capture({ present: "" }))).toMatchObject({
    pass: false,
    metadata: {},
  });
});
test("retained final workspace handles unchanged files and true absence; snapshot wins", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-file-"));
  roots.push(root);
  await writeFile(join(root, "unchanged"), "original");
  expect(await grade({ path: "unchanged", equals: "original" }, capture({}), root)).toMatchObject({
    pass: true,
  });
  expect(await grade({ path: "absent", absent: true }, capture({}), root)).toMatchObject({
    pass: true,
  });
  expect(
    await grade(
      { path: "unchanged", equals: "captured" },
      capture({ unchanged: "captured" }),
      root,
    ),
  ).toMatchObject({ pass: true });
  await symlink(join(root, "unchanged"), join(root, "link"));
  expect(await grade({ path: "link" }, capture({}), root)).toMatchObject({
    metadata: { graderError: true },
  });
  expect(await grade({ path: "../outside", absent: true }, capture({}), root)).toMatchObject({
    metadata: { graderError: true },
  });
});
test("symlinked retained roots cannot provide contents or certify absence", async () => {
  const container = await retainedRoot();
  const outside = await retainedRoot();
  await writeFile(join(outside, "secret"), "outside");
  const alias = join(container, "root");
  await symlink(outside, alias, "dir");
  for (const root of [alias, `${alias}/`, `${alias}/.`]) {
    expect(await grade({ path: "secret", equals: "outside" }, capture({}), root)).toMatchObject({
      pass: false,
      metadata: { graderError: true },
    });
    expect(await grade({ path: "missing", absent: true }, capture({}), root)).toMatchObject({
      pass: false,
      metadata: { graderError: true },
    });
  }
});
test("retained roots cannot change meaning under lexical normalization", async () => {
  const root = await retainedRoot();
  const outside = await retainedRoot();
  await mkdir(join(outside, "child"));
  await writeFile(join(outside, "secret"), "outside");
  const alias = join(root, "alias");
  await symlink(join(outside, "child"), alias, "dir");
  const ambiguous = `${alias}/..`;
  const changesMeaning = (await realpath(ambiguous)) !== (await realpath(root));
  expect(await grade({ path: "secret", equals: "outside" }, capture({}), ambiguous)).toMatchObject({
    pass: false,
    metadata: { graderError: true },
  });
  expect(await grade({ path: "missing", absent: true }, capture({}), ambiguous)).toMatchObject(
    changesMeaning ? { pass: false, metadata: { graderError: true } } : { pass: true },
  );
});
test("canonical parent aliases remain valid retained workspace paths", async () => {
  const container = await retainedRoot();
  const parent = join(container, "physical");
  const root = join(parent, "root");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "unchanged"), "original");
  const alias = join(container, "alias");
  await symlink(await realpath(parent), alias, "dir");
  for (const retained of [root, await realpath(root), join(alias, "root")]) {
    expect(
      await grade({ path: "unchanged", equals: "original" }, capture({}), retained),
    ).toMatchObject({ pass: true });
    expect(await grade({ path: "missing", absent: true }, capture({}), retained)).toMatchObject({
      pass: true,
    });
  }
});
test("symlinked ancestors and hardlinked files cannot escape the retained workspace", async () => {
  const root = await retainedRoot();
  const outside = await retainedRoot();
  const secret = join(outside, "secret");
  await writeFile(secret, "outside");
  await symlink(outside, join(root, "nested"), "dir");
  await symlink(secret, join(root, "symlink"));
  await link(secret, join(root, "hardlink"));
  for (const path of ["nested/secret", "symlink", "hardlink"]) {
    expect(await grade({ path, equals: "outside" }, capture({}), root)).toMatchObject({
      pass: false,
      metadata: { graderError: true },
    });
  }
  expect(await grade({ path: "nested/missing", absent: true }, capture({}), root)).toMatchObject({
    pass: false,
    metadata: { graderError: true },
  });
});
test("absence requires an existing safe retained root and safe existing ancestors", async () => {
  const root = await retainedRoot();
  await mkdir(join(root, "directory"));
  await writeFile(join(root, "file"), "present");
  await symlink(join(root, "missing"), join(root, "dangling"));
  for (const path of ["missing", "missing/child", "directory/missing"]) {
    expect(await grade({ path, absent: true }, capture({}), root)).toMatchObject({
      pass: true,
    });
  }
  for (const path of ["dangling", "dangling/child", "file/child"]) {
    expect(await grade({ path, absent: true }, capture({}), root)).toMatchObject({
      pass: false,
      metadata: { graderError: true },
    });
  }
  expect(
    await grade({ path: "missing", absent: true }, capture({}), join(root, "missing")),
  ).toMatchObject({ pass: false, metadata: { graderError: true } });
});
test("retained files are bounded at 16 MiB", async () => {
  const root = await retainedRoot();
  const target = join(root, "large");
  await writeFile(target, "");
  await truncate(target, 16 * 1024 * 1024);
  expect(
    await grade({ path: "large", byteLength: 16 * 1024 * 1024 }, capture({}), root),
  ).toMatchObject({ pass: true });
  await truncate(target, 16 * 1024 * 1024 + 1);
  expect(await grade({ path: "large" }, capture({}), root)).toMatchObject({
    pass: false,
    reason: expect.stringContaining("16 MiB read limit"),
    metadata: { graderError: true },
  });
});
test.each([2, 16 * 1024 * 1024 + 1])(
  "file growth to %i bytes before open is rejected",
  async (size) => {
    const root = await retainedRoot();
    const target = join(root, "growing");
    await writeFile(target, "a");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    // Advance the file at the lstat/open boundary, without concurrent writers.
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      await truncate(target, size);
      return actual.open(...args);
    });
    expect(await grade({ path: "growing" }, capture({}), root)).toMatchObject({
      pass: false,
      reason: expect.stringContaining(
        size > 16 * 1024 * 1024 ? "16 MiB read limit" : "changed while opening",
      ),
      metadata: { graderError: true },
    });
  },
);
test("captured bytes and deletions win without consulting unsafe or missing retained roots", async () => {
  const root = await retainedRoot();
  const outside = await retainedRoot();
  const alias = join(root, "alias");
  await symlink(outside, alias, "dir");
  await writeFile(join(outside, "result"), "live");
  await truncate(join(outside, "result"), 16 * 1024 * 1024 + 1);
  const snapshot = capture({ result: "captured" }, ["deleted"]);
  for (const retained of [alias, join(root, "missing")]) {
    expect(await grade({ path: "result", equals: "captured" }, snapshot, retained)).toMatchObject({
      pass: true,
    });
    expect(await grade({ path: "deleted", absent: true }, snapshot, retained)).toMatchObject({
      pass: true,
    });
  }
});
test.each([16 * 1024 * 1024, 16 * 1024 * 1024 + 1])(
  "captured bytes of length %i obey the 16 MiB read limit",
  async (size) => {
    const result = await grade(
      { path: "large", byteLength: size },
      capture({ large: Buffer.alloc(size) }),
    );
    expect(result).toMatchObject(
      size <= 16 * 1024 * 1024
        ? { pass: true }
        : {
            pass: false,
            reason: expect.stringContaining("16 MiB read limit"),
            metadata: { graderError: true },
          },
    );
  },
);
test("partial or corrupt capture cannot certify a missing file", async () => {
  for (const fileChanges of [
    { ...capture({}), status: "failed", failure: { message: "capture failed" } },
    {
      ...capture({}),
      status: "truncated",
      truncated: true,
      truncation: { codes: ["FILE_BYTES"], omittedPaths: ["big"] },
    },
    {
      ...capture({ a: "ok" }),
      changedFiles: { a: { encoding: "base64", content: "!!!", size: 2, kind: "file" } },
    },
    {
      ...capture({ a: "ok" }),
      changedFiles: { a: { ...capture({ a: "ok" }).changedFiles.a, size: 20 } },
    },
  ])
    expect(await grade({ path: "a", absent: true }, fileChanges)).toMatchObject({
      pass: false,
      metadata: { graderError: true },
    });
});
test("encoding and byte length operate on final bytes, JSON fields must exist", async () => {
  expect(
    await grade(
      { path: "utf16", encoding: "utf16le", equals: "雪", byteLength: 2 },
      capture({ utf16: Buffer.from("雪", "utf16le") }),
    ),
  ).toMatchObject({ pass: true });
  expect(
    await grade({ path: "bad", encoding: "utf8" }, capture({ bad: Buffer.from([255]) })),
  ).toMatchObject({ pass: false, metadata: {} });
  expect(
    await grade(
      { path: "json", jsonPath: { path: "/missing", equals: null } },
      capture({ json: '{"present":null}' }),
    ),
  ).toMatchObject({ pass: false });
  expect(await grade({ path: "json", isJson: true }, capture({ json: "not-json" }))).toMatchObject({
    pass: false,
    metadata: {},
  });
  expect(await grade({ path: "a", byteLength: 1 }, capture({ a: "雪" }))).toMatchObject({
    pass: false,
  });
});

test("exact text checks preserve byte-order marks and partial captures retain explicit deletions", async () => {
  expect(
    await grade({ path: "bom", equals: "text" }, capture({ bom: "\uFEFFtext" })),
  ).toMatchObject({ pass: false, metadata: {} });
  expect(
    await grade({ path: "bom", equals: "\uFEFFtext" }, capture({ bom: "\uFEFFtext" })),
  ).toMatchObject({ pass: true });
  expect(
    await grade(
      { path: "gone", absent: true },
      {
        ...capture({}, ["gone"]),
        status: "truncated",
        truncated: true,
        truncation: { codes: ["FILE_COUNT"], omittedPaths: ["other"] },
      },
    ),
  ).toMatchObject({ pass: true });
});
