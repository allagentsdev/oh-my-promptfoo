import * as fs from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";

const original = { ...fs };
let release!: () => void;
const resumed = new Promise<void>((resolve) => {
  release = resolve;
});
process.stdin.once("data", () => {
  release();
  process.stdin.pause();
});
// Hold the completed marker before publication; the other process uses real fs.
// Patch the builtin before importing fs.ts so its named import sees the wrapper.
const builtin: typeof fs = createRequire(import.meta.url)("node:fs/promises");
Object.assign(builtin, {
  rename: async (source: string, destination: string) => {
    if (basename(destination) === ".allagents-owner.json") {
      console.log("paused");
      await resumed;
    }
    return original.rename(source, destination);
  },
});
syncBuiltinESMExports();
const { ownedRoot } = await import(process.argv[2]!);
await ownedRoot(process.argv[3]!, "runtime-parent");
