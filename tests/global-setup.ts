import { fileURLToPath } from "node:url";
import { build } from "tsdown";
import { processEntries } from "../scripts/build-options.ts";

/** Bundled process entries for providers loaded from source (OH_MY_PROMPTFOO_TEST_ENTRIES). */
export const testEntries = fileURLToPath(
  new URL("../node_modules/.cache/oh-my-promptfoo/entries", import.meta.url),
);

// Spawning TypeScript sources through a loader adds startup time that deadline tests count.
export default async function setup() {
  await build({ ...processEntries, outDir: testEntries, clean: true, logLevel: "warn" });
}
