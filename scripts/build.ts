import { copyFile } from "node:fs/promises";
import { build } from "tsup";

await build({
  entry: {
    index: "packages/oh-my-promptfoo/src/index.ts",
    assertions: "packages/oh-my-promptfoo/src/assertions.ts",
  },
  outDir: "packages/oh-my-promptfoo/dist",
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
    "delegate-runner": "packages/oh-my-promptfoo/src/delegate-runner.ts",
    cli: "packages/oh-my-promptfoo/src/cli.ts",
  },
  outDir: "packages/oh-my-promptfoo/dist",
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
await copyFile("LICENSE", "packages/oh-my-promptfoo/LICENSE");
await copyFile("README.md", "packages/oh-my-promptfoo/README.md");
