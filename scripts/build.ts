import { copyFile } from "node:fs/promises";
import { build } from "tsdown";
import { processEntries, shared } from "./build-options.ts";

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
await build(processEntries);
await copyFile("LICENSE", "packages/oh-my-promptfoo/LICENSE");
await copyFile("README.md", "packages/oh-my-promptfoo/README.md");
