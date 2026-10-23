import { copyFile } from "node:fs/promises";
import { build, type UserConfig } from "tsdown";

// Both groups share dist, including tsdown's shared runtime and declaration chunks.
const shared = {
  outDir: "packages/oh-my-promptfoo/dist",
  platform: "node",
  shims: true,
  sourcemap: true,
  target: "node22",
  outExtensions: ({ format }) => ({
    js: format === "cjs" ? ".cjs" : ".js",
    dts: format === "cjs" ? ".d.cts" : ".d.ts",
  }),
  deps: {
    neverBundle: ["promptfoo", "@github/copilot-sdk"],
    alwaysBundle: ["@allagents/workspace-core", "diff", "ignore"],
    // All non-peer implementation dependencies belong in the published bundle.
    onlyBundle: false,
  },
} satisfies UserConfig;

await build({
  ...shared,
  entry: {
    index: "packages/oh-my-promptfoo/src/index.ts",
    assertions: "packages/oh-my-promptfoo/src/assertions.ts",
    providers: "packages/oh-my-promptfoo/src/providers.ts",
  },
  format: ["esm", "cjs"],
  // CJS consumers receive the same named exports and .default as ESM consumers.
  outputOptions: { exports: "named" },
  // The pinned declaration plugin supports TypeScript 7.0's native CLI backend.
  // It emits with --noCheck; the independent typecheck script remains mandatory.
  dts: { generator: "tsgo" },
  clean: true,
});
await build({
  ...shared,
  entry: {
    "delegate-runner": "packages/oh-my-promptfoo/src/delegate-runner.ts",
    "workspace-reader": "packages/oh-my-promptfoo/src/workspace-reader.ts",
    cli: "packages/oh-my-promptfoo/src/cli.ts",
  },
  format: ["esm"],
  dts: false,
  clean: false,
  banner: {
    js: '#!/usr/bin/env node\nimport {createRequire as __allagentsCreateRequire} from "node:module";const require=__allagentsCreateRequire(import.meta.url);',
  },
});
await copyFile("LICENSE", "packages/oh-my-promptfoo/LICENSE");
await copyFile("README.md", "packages/oh-my-promptfoo/README.md");
