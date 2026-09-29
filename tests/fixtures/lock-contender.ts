import { mock } from "bun:test";
import * as childProcess from "node:child_process";
import { fstatSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const original = { ...childProcess };
const options = JSON.parse(process.argv[3]!);
const admission = statSync(join(options.channels.ALLAGENTS_CACHE_ROOT, "locks", "admission.flock"));
// Scale only the native backend's wait clock. The competing lock and all
// filesystem/provider operations remain real; 180s becomes 200ms, 1800s becomes 2s.
mock.module("node:child_process", () => ({
  ...original,
  spawn(command: string, args: readonly string[], settings: childProcess.SpawnOptions) {
    const scaled = [...args];
    if (command === "/usr/bin/flock") {
      const at = scaled.indexOf("-w") + 1;
      scaled[at] = String(Number(scaled[at]) / 900);
    } else if (command === "/usr/bin/python3" && scaled.includes("-I")) {
      const at = scaled.length - 1;
      scaled[at] = String(Number(scaled[at]) / 900);
    } else return original.spawn(command, args, settings);
    const fd = Array.isArray(settings.stdio) ? settings.stdio[3] : undefined;
    if (typeof fd === "number") {
      const lock = fstatSync(fd);
      if (lock.dev === admission.dev && lock.ino === admission.ino) console.log("contending");
    }
    return original.spawn(command, scaled, settings);
  },
}));
const { WorkspaceManager } = await import(process.argv[2]!);
const manager = new WorkspaceManager(options.spec, options.channels);
try {
  const handle = await manager.prepare();
  if ((await readFile(join(handle.path, "project/source.txt"), "utf8")) !== "immutable input\n")
    throw new Error("Contended acquisition returned invalid source content");
} finally {
  await manager.cleanup();
}
console.log("complete");
