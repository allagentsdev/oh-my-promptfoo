import { mock } from "bun:test";
import * as fs from "node:fs/promises";
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
mock.module("node:fs/promises", () => ({
  ...original,
  rename: async (source: string, destination: string) => {
    if (basename(destination) === ".allagents-owner.json") {
      console.log("paused");
      await resumed;
    }
    return original.rename(source, destination);
  },
}));
const { ownedRoot } = await import(process.argv[2]!);
await ownedRoot(process.argv[3]!, "runtime-parent");
