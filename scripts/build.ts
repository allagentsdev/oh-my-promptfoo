import { copyFile } from "node:fs/promises";
import { build } from "tsup";

await build({
  entry: { index: "packages/promptfoo-integration/src/index.ts" },
  outDir: "packages/promptfoo-integration/dist",
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  splitting: false,
  shims: true,
  sourcemap: true,
  target: "node22",
  external: ["promptfoo", "@github/copilot-sdk"],
  noExternal: ["@allagents/workspace-core", "diff"],
});
await build({
  entry: {
    "delegate-runner": "packages/promptfoo-integration/src/delegate-runner.ts",
    cli: "packages/promptfoo-integration/src/cli.ts",
  },
  outDir: "packages/promptfoo-integration/dist",
  format: ["esm"],
  splitting: false,
  shims: true,
  sourcemap: true,
  target: "node22",
  external: ["promptfoo", "@github/copilot-sdk"],
  banner: {
    js: '#!/usr/bin/env node\nimport {createRequire as __allagentsCreateRequire} from "node:module";const require=__allagentsCreateRequire(import.meta.url);',
  },
});
await copyFile("LICENSE", "packages/promptfoo-integration/LICENSE");
await copyFile("README.md", "packages/promptfoo-integration/README.md");
