import type { UserConfig } from "tsdown";

// Both groups share dist, including tsdown's shared runtime and declaration chunks.
export const shared = {
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

/** Entries that run as their own Node processes beside the library bundles. */
export const processEntries = {
  ...shared,
  entry: {
    "delegate-runner": "packages/oh-my-promptfoo/src/delegate-runner.ts",
    "workspace-reader": "packages/oh-my-promptfoo/src/workspace-reader.ts",
    "copilot-endpoint-worker": "packages/oh-my-promptfoo/src/copilot-endpoint-worker.ts",
    cli: "packages/oh-my-promptfoo/src/cli.ts",
  },
  format: ["esm"],
  dts: false,
  clean: false,
  banner: {
    js: '#!/usr/bin/env node\nimport {createRequire as __allagentsCreateRequire} from "node:module";const require=__allagentsCreateRequire(import.meta.url);',
  },
} satisfies UserConfig;
