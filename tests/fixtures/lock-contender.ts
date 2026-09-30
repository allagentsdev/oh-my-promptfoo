import { mock } from "bun:test";
import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { fstatSync, statSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const original = { ...childProcess };
const options = JSON.parse(process.argv[3]!);
const admissionPath = join(options.channels.ALLAGENTS_CACHE_ROOT, "locks", "admission.flock");
const admission = statSync(admissionPath);
// Match withLock's canonical parent and basename, not the file's alias spelling.
const windowsLockName =
  process.platform === "win32"
    ? `Global\\allagents-cache-lock-${createHash("sha256")
        .update(join(await realpath(dirname(admissionPath)), basename(admissionPath)).toLowerCase())
        .digest("hex")}`
    : undefined;
// Scale only the native backend's wait clock. The competing lock and all
// filesystem/provider operations remain real; POSIX 1800s becomes 2s.
// Windows scales only the contended admission mutex; short bootstrap waits
// otherwise expire under loaded runners before acquisition even starts.
mock.module("node:child_process", () => ({
  ...original,
  spawn(command: string, args: readonly string[], settings: childProcess.SpawnOptions) {
    const scaled = [...args];
    let spawnSettings = settings;
    if (command === "/usr/bin/flock") {
      const at = scaled.indexOf("-w") + 1;
      scaled[at] = String(Number(scaled[at]) / 900);
    } else if (command === "/usr/bin/python3" && scaled.includes("-I")) {
      const at = scaled.length - 1;
      scaled[at] = String(Number(scaled[at]) / 900);
    } else if (
      process.platform === "win32" &&
      command.toLowerCase().endsWith("\\powershell.exe") &&
      settings.env?.ALLAGENTS_LOCK_TIMEOUT_MS &&
      settings.env.ALLAGENTS_LOCK_NAME === windowsLockName
    ) {
      spawnSettings = {
        ...settings,
        env: {
          ...settings.env,
          ALLAGENTS_LOCK_TIMEOUT_MS: String(Number(settings.env.ALLAGENTS_LOCK_TIMEOUT_MS) / 300),
        },
      };
    } else return original.spawn(command, args, settings);
    if (process.platform === "win32") {
      if (settings.env?.ALLAGENTS_LOCK_NAME === windowsLockName) console.log("contending");
    } else {
      const fd = Array.isArray(settings.stdio) ? settings.stdio[3] : undefined;
      if (typeof fd === "number") {
        const lock = fstatSync(fd);
        if (lock.dev === admission.dev && lock.ino === admission.ino) console.log("contending");
      }
    }
    return original.spawn(command, scaled, spawnSettings);
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
