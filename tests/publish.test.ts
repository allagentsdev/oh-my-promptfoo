import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fakeNpm = `#!/usr/bin/env node
const {readFileSync,writeFileSync}=require('node:fs');
const args=process.argv.slice(2);
if(args[0]==='view'){
  if(process.env.FAKE_REGISTRY_MODE==='missing') {console.error('E404');process.exit(1);}
  if(args[2]==='dist-tags') console.log(JSON.stringify({next:process.env.FAKE_REGISTRY_MODE==='wrong-tag'?'0.9.0':'1.0.0-rc.1'}));
  else console.log(JSON.stringify('1.0.0-rc.1'));
}else if(args[0]==='publish'){
  const manifest=JSON.parse(readFileSync('package.json','utf8'));
  writeFileSync(process.env.FAKE_PUBLISH_MARKER,manifest.version);
}else process.exit(2);
`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "allagents-publish-test-"));
  await mkdir(join(root, "scripts"));
  await mkdir(join(root, "bin"));
  await mkdir(join(root, "packages", "promptfoo-integration"), { recursive: true });
  await copyFile(
    join(import.meta.dir, "..", "scripts", "publish.ts"),
    join(root, "scripts", "publish.ts"),
  );
  await writeFile(join(root, "bin", "npm"), fakeNpm, { mode: 0o755 });
  const manifestPath = join(root, "packages", "promptfoo-integration", "package.json");
  const original = `${JSON.stringify({ name: "@allagents/promptfoo-integration", version: "1.0.0" })}\n`;
  await writeFile(manifestPath, original);
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ version: "1.0.0", private: true })}\n`,
  );
  return {
    root,
    manifestPath,
    original,
    marker: join(root, "published-version"),
    output: join(root, "output"),
  };
}

function run(root: string, marker: string, output: string, mode: string) {
  return spawnSync(process.execPath, [join(root, "scripts", "publish.ts")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      RELEASE_REF: "v1.0.0-rc.1",
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/oidc",
      GITHUB_OUTPUT: output,
      FAKE_REGISTRY_MODE: mode,
      FAKE_PUBLISH_MARKER: marker,
    },
  });
}

describe("trusted release publish", () => {
  test("stamps a candidate only during publication and restores the reviewed manifest", async () => {
    const f = await fixture();
    try {
      const result = run(f.root, f.marker, f.output, "missing");
      expect(result.status).toBe(0);
      expect(await readFile(f.marker, "utf8")).toBe("1.0.0-rc.1");
      expect(await readFile(f.manifestPath, "utf8")).toBe(f.original);
      expect(await readFile(f.output, "utf8")).toContain("version=1.0.0-rc.1\nnpm_tag=next");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test("a repeat verifies the existing dist-tag without republishing", async () => {
    const f = await fixture();
    try {
      const result = run(f.root, f.marker, f.output, "existing");
      expect(result.status).toBe(0);
      expect(await readFile(f.manifestPath, "utf8")).toBe(f.original);
      expect(await readFile(f.output, "utf8")).toContain("version=1.0.0-rc.1");
      expect(await Bun.file(f.marker).exists()).toBe(false);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test("a published version under the wrong dist-tag fails closed", async () => {
    const f = await fixture();
    try {
      const result = run(f.root, f.marker, f.output, "wrong-tag");
      expect(result.status).not.toBe(0);
      expect(await Bun.file(f.marker).exists()).toBe(false);
      expect(await Bun.file(f.output).exists()).toBe(false);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test("rejects a release when root and public package versions disagree", async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.root, "package.json"), JSON.stringify({ version: "1.1.0" }));
      const result = run(f.root, f.marker, f.output, "missing");
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Root version 1.1.0 differs from package version 1.0.0");
      expect(await Bun.file(f.marker).exists()).toBe(false);
      expect(await Bun.file(f.output).exists()).toBe(false);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
