import childProcess from "node:child_process";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { promisify } from "node:util";

const denied = () => {
  throw new Error("Replay attempted provider, grader or network I/O");
};
globalThis.fetch = denied;
http.request = denied;
https.request = denied;
net.Socket.prototype.connect = denied;
childProcess.spawn = denied;
childProcess.spawnSync = denied;
childProcess.exec = denied;
childProcess.execSync = denied;
childProcess.execFileSync = denied;
const execFile = childProcess.execFile;
childProcess.execFile = function (file, ...args) {
  if (file !== "git") return denied();
  return execFile.call(this, file, ...args);
};
childProcess.execFile[promisify.custom] = (file, ...args) => {
  if (file !== "git") return denied();
  return promisify(execFile)(file, ...args);
};
syncBuiltinESMExports();
