import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";

const HELPER = "/usr/local/libexec/allagents-workspace-helper";
const PRIVILEGED_HELPER_DISABLED =
  "Privileged workspace helper is forbidden by ALLAGENTS_NO_PRIVILEGED_HELPER";
export async function helperAvailable(): Promise<boolean> {
  if (process.env.ALLAGENTS_NO_PRIVILEGED_HELPER === "1") return false;
  const stat = await lstat(HELPER).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.mode & 0o022)
    throw new Error(
      "Root-owned allagents-workspace-helper is required for bounded tmpfs; install scripts/workspace-helper.py with the documented exact sudo policy",
    );
  return true;
}
export async function helperInvoke(
  verb: "acquire-tmpfs" | "release-tmpfs",
  args: string[],
): Promise<void> {
  if (process.env.ALLAGENTS_NO_PRIVILEGED_HELPER === "1")
    throw new Error(PRIVILEGED_HELPER_DISABLED);
  if (!(await helperAvailable()))
    throw new Error(
      "Root-owned allagents-workspace-helper is required for bounded tmpfs; install scripts/workspace-helper.py with the documented exact sudo policy",
    );
  await new Promise<void>((resolve, reject) => {
    execFile(
      process.getuid?.() === 0 ? HELPER : "/usr/bin/sudo",
      process.getuid?.() === 0 ? [verb, ...args] : ["-n", HELPER, verb, ...args],
      {
        timeout: 30000,
        maxBuffer: 65536,
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" },
      },
      (error, _stdout, stderr) =>
        error
          ? reject(new Error(`Workspace helper ${verb} failed: ${stderr.slice(0, 2048)}`))
          : resolve(),
    );
  });
}
