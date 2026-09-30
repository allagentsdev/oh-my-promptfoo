import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const DEFAULT_LOCK_TIMEOUT_MS = 180000;

/** Advisory locks are released by the OS on process death, never by PID guessing. */
export async function withLock<T>(
  path: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
): Promise<T> {
  signal?.throwIfAborted();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if ((await realpath(dirname(path))) !== resolve(dirname(path)))
    throw new Error("Symlinked cache lock parent");
  const lockPath = `${path}.flock`;
  const info = await lstat(lockPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info?.isSymbolicLink() || (info && (!info.isFile() || info.nlink !== 1)))
    throw new Error("Unsafe kernel lock path");
  const fd = await open(
    lockPath,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  const javascript =
    'process.stdout.write("locked\\n");process.stdin.resume();process.stdin.on("end",()=>process.exit(0))';
  // macOS has no flock utility. Its system Python uses the same native advisory primitive.
  const python =
    'import fcntl,os,select,sys,time\nend=time.monotonic()+float(sys.argv[1])\nwhile True:\n try:\n  fcntl.flock(3,fcntl.LOCK_EX|fcntl.LOCK_NB);break\n except BlockingIOError:\n  if time.monotonic()>end:sys.exit(2)\n  time.sleep(0.02)\nsys.stdout.write("locked\\n");sys.stdout.flush();sys.stdin.read()';
  const child = spawn(
    process.platform === "linux" ? "/usr/bin/flock" : "/usr/bin/python3",
    process.platform === "linux"
      ? [
          "-x",
          "-w",
          String(timeoutMs / 1000),
          "/proc/self/fd/3",
          process.execPath,
          "-e",
          javascript,
        ]
      : ["-I", "-c", python, String(timeoutMs / 1000)],
    { stdio: ["pipe", "pipe", "pipe", fd.fd], env: { PATH: "/usr/bin:/bin" } },
  );
  let exited = false;
  const exitPromise = new Promise<void>((res) => {
    child.once("exit", () => {
      exited = true;
      res();
    });
    child.once("error", () => {
      exited = true;
      res();
    });
  });
  const abort = () => child.kill("SIGKILL");
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    await new Promise<void>((res, rej) => {
      let output = "";
      child.stdout!.on("data", (chunk) => {
        output += chunk.toString();
        if (output.includes("locked\n")) res();
      });
      child.once("error", () =>
        rej(
          new Error(
            "Native cache lock backend unavailable: Linux requires flock; macOS requires system Python 3 (Xcode command line tools)",
          ),
        ),
      );
      child.once("exit", (code) =>
        rej(
          signal?.aborted
            ? signal.reason
            : new Error(`Cache kernel lock unavailable or timed out (${code})`),
        ),
      );
    });
    signal?.throwIfAborted();
    signal?.removeEventListener("abort", abort);
    return await operation();
  } finally {
    signal?.removeEventListener("abort", abort);
    if (!exited) child.stdin!.end();
    await exitPromise;
    await fd.close();
  }
}
