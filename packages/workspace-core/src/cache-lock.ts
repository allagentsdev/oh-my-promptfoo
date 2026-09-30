import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { assertNoSymlinkAncestors } from "./fs.ts";

export const DEFAULT_LOCK_TIMEOUT_MS = 180000;

/** Advisory locks are released by the OS on process death, never by PID guessing. */
export async function withLock<T>(
  path: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
): Promise<T> {
  signal?.throwIfAborted();
  const parent = resolve(dirname(path));
  await mkdir(parent, { recursive: true, mode: 0o700 });
  // Windows realpath expands short (8.3) directory names even without a link.
  // lstat each ancestor instead; preserve the stricter POSIX realpath check.
  if (process.platform === "win32") await assertNoSymlinkAncestors(parent);
  const canonicalParent = await realpath(parent);
  if (process.platform !== "win32" && canonicalParent !== parent)
    throw new Error("Symlinked cache lock parent");
  const lockPath = join(canonicalParent, `${basename(path)}.flock`);
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
  try {
    const opened = await fd.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      (info && (info.dev !== opened.dev || info.ino !== opened.ino))
    )
      throw new Error("Unsafe kernel lock path");
    const javascript =
      'process.stdout.write("locked\\n");process.stdin.resume();process.stdin.on("end",()=>process.exit(0))';
    // macOS has no flock utility. Its system Python uses the same native advisory primitive.
    const python =
      'import fcntl,os,select,sys,time\nend=time.monotonic()+float(sys.argv[1])\nwhile True:\n try:\n  fcntl.flock(3,fcntl.LOCK_EX|fcntl.LOCK_NB);break\n except BlockingIOError:\n  if time.monotonic()>end:sys.exit(2)\n  time.sleep(0.02)\nsys.stdout.write("locked\\n");sys.stdout.flush();sys.stdin.read()';
    // A named kernel mutex is independent of lockfile inode replacement.
    // Abandoned ownership transfers to the next waiter after process death.
    const windows = `
$ErrorActionPreference = 'Stop'
$mutex = [System.Threading.Mutex]::new($false, $env:ALLAGENTS_LOCK_NAME)
$acquired = $false
try {
  try { $acquired = $mutex.WaitOne([TimeSpan]::FromMilliseconds([double]$env:ALLAGENTS_LOCK_TIMEOUT_MS)) }
  catch [System.Threading.AbandonedMutexException] { $acquired = $true }
  if (-not $acquired) { exit 2 }
  [Console]::Out.Write("locked\u0060n")
  [Console]::Out.Flush()
  [Console]::In.ReadToEnd() | Out-Null
} finally {
  if ($acquired) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
`;
    const platform = process.platform;
    const mutexName =
      platform === "win32"
        ? `Global\\allagents-cache-lock-${createHash("sha256")
            .update(lockPath.toLowerCase())
            .digest("hex")}`
        : undefined;
    const child = spawn(
      platform === "linux"
        ? "/usr/bin/flock"
        : platform === "win32"
          ? join(
              process.env.SystemRoot ?? "C:\\Windows",
              "System32",
              "WindowsPowerShell",
              "v1.0",
              "powershell.exe",
            )
          : "/usr/bin/python3",
      platform === "linux"
        ? [
            "-x",
            "-w",
            String(timeoutMs / 1000),
            "/proc/self/fd/3",
            process.execPath,
            "-e",
            javascript,
          ]
        : platform === "win32"
          ? [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-EncodedCommand",
              Buffer.from(windows, "utf16le").toString("base64"),
            ]
          : ["-I", "-c", python, String(timeoutMs / 1000)],
      {
        stdio: platform === "win32" ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", fd.fd],
        windowsHide: true,
        env:
          platform === "win32"
            ? {
                SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
                ALLAGENTS_LOCK_NAME: mutexName,
                ALLAGENTS_LOCK_TIMEOUT_MS: String(timeoutMs),
              }
            : { PATH: "/usr/bin:/bin" },
      },
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
              "Native cache lock backend unavailable: Linux requires flock; macOS requires system Python 3 (Xcode command line tools); Windows requires Windows PowerShell",
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
    }
  } finally {
    await fd.close();
  }
}
