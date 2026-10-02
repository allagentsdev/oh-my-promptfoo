import { copyFile } from "node:fs/promises";
import { build } from "tsup";

await build({
  entry: { index: "packages/promptfoo-x/src/index.ts" },
  outDir: "packages/promptfoo-x/dist",
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
    "delegate-runner": "packages/promptfoo-x/src/delegate-runner.ts",
    cli: "packages/promptfoo-x/src/cli.ts",
  },
  outDir: "packages/promptfoo-x/dist",
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
await copyFile("LICENSE", "packages/promptfoo-x/LICENSE");
await copyFile("README.md", "packages/promptfoo-x/README.md");
