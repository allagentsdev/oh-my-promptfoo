import { execFile, spawn } from "node:child_process";
import { constants, realpathSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  statfs,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { alive, atomicJson, hash, PACKAGE, processIdentity } from "../fs.ts";
import type { ProcessIdentity, RuntimeChannels } from "../types.ts";

export const SOURCE_OUTPUT_LIMIT = 4 * 1024 * 1024;
/** Conservative block admission happens before every parent-created inode or write. */
export class PhysicalWriter {
  private reserved = 0;
  private files = new Map<string, number>();
  private directories = new Set<string>();
  private constructor(
    readonly root: string,
    readonly maximum: number,
    readonly blockSize: number,
  ) {
    this.directories.add(root);
  }
  static async create(root: string, maximum: number): Promise<PhysicalWriter> {
    const fs = await statfs(root);
    return new PhysicalWriter(resolve(root), maximum, Number(fs.bsize));
  }
  private charge(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || this.reserved + bytes > this.maximum)
      throw new Error("Controlled source write exceeds physical staging reservation");
    this.reserved += bytes;
  }
  async directory(path: string): Promise<void> {
    path = resolve(path);
    if (path !== this.root && !path.startsWith(`${this.root}${sep}`))
      throw new Error("Controlled source writer escapes staging");
    if (this.directories.has(path)) return;
    await this.directory(dirname(path));
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new Error("Unsafe source staging directory");
    if (!stat) {
      this.charge(this.blockSize);
      await mkdir(path, { mode: 0o755 });
    }
    this.directories.add(path);
  }
  reserveFile(path: string, bytes: number): void {
    path = resolve(path);
    if (!path.startsWith(`${this.root}${sep}`))
      throw new Error("Controlled source writer escapes staging");
    const blocks = Math.max(this.blockSize, Math.ceil(bytes / this.blockSize) * this.blockSize);
    const previous = this.files.get(path) ?? 0;
    if (blocks > previous) this.charge(blocks - previous);
    this.files.set(path, blocks);
  }
  async file(path: string, bytes: Uint8Array | string, mode = 0o644): Promise<void> {
    await this.directory(dirname(path));
    this.reserveFile(path, typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.byteLength);
    await writeFile(path, bytes, { flag: "wx", mode });
  }
  async link(path: string, target: string): Promise<void> {
    await this.directory(dirname(path));
    this.reserveFile(path, Buffer.byteLength(target));
    await symlink(target, path);
  }
}
export function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${hash(bytes)}`;
}
export function redact(
  message: string,
  channels: RuntimeChannels,
  privatePaths: string[] = [],
): string {
  for (const secret of [
    channels.ALLAGENTS_GIT_TOKEN,
    channels.ALLAGENTS_GIT_USERNAME,
    channels.ALLAGENTS_ORAS_AUTH_FILE,
    ...privatePaths,
  ]) {
    if (secret) message = message.split(secret).join("[redacted]");
  }
  return message;
}
export function sourceEnvironment(home: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: home,
    TMPDIR: home,
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
  };
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    // Preserve only the Windows loader's necessary settings. Credentials and
    // per-user paths remain confined to the disposable acquisition directory.
    Object.assign(environment, {
      SystemRoot: systemRoot,
      windir: systemRoot,
      ComSpec: join(systemRoot, "System32", "cmd.exe"),
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      TEMP: home,
      TMP: home,
      USERPROFILE: home,
    });
  }
  return environment;
}
export interface RunOptions {
  env: NodeJS.ProcessEnv;
  channels: RuntimeChannels;
  signal?: AbortSignal;
  limit?: number;
  input?: string;
  privatePaths?: string[];
  onChunk?: (chunk: Buffer) => Promise<void>;
}

/** No shell, no inherited credentials; stdout is bounded or consumed by a bounded writer. */
export async function runSource(
  command: string,
  args: string[],
  options: RunOptions,
): Promise<Buffer> {
  options.signal?.throwIfAborted();
  const child = spawn(command, args, {
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let spawnError: Error | undefined;
  const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on("error", (error) => {
        spawnError = error;
      });
      child.on("close", (code, signal) => resolve({ code, signal }));
    },
  );
  let stopping: Promise<void> | undefined;
  const terminate = () => {
    if (!child.pid) return;
    if (process.platform === "win32") {
      if (child.exitCode != null || child.signalCode != null) return;
      // Windows has no POSIX process groups. taskkill /T terminates children
      // spawned by Git/ORAS as well as the original acquisition process.
      stopping ??= new Promise<void>((resolve) => {
        const killer = spawn(
          join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"],
          { stdio: "ignore", windowsHide: true },
        );
        killer.once("error", () => resolve());
        killer.once("close", () => resolve());
      });
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* Already gone. */
      }
    }
  };
  const abort = () => terminate();
  options.signal?.addEventListener("abort", abort, { once: true });
  let stderr = Buffer.alloc(0);
  child.stderr.on("data", (chunk: Buffer) => {
    const remaining = SOURCE_OUTPUT_LIMIT - stderr.length;
    if (remaining > 0) stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
  });
  child.stdin.on("error", () => {});
  child.stdin.end(options.input);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const value of child.stdout) {
      options.signal?.throwIfAborted();
      const chunk = Buffer.from(value);
      if (options.onChunk) await options.onChunk(chunk);
      else {
        size += chunk.length;
        if (size > (options.limit ?? SOURCE_OUTPUT_LIMIT))
          throw new Error("Source subprocess output exceeds its byte limit");
        chunks.push(chunk);
      }
    }
    const result = await completed;
    options.signal?.throwIfAborted();
    if (spawnError) throw new Error(`Cannot execute acquisition tool: ${spawnError.message}`);
    if (result.code !== 0)
      throw new Error(
        `Acquisition tool failed (${result.code ?? result.signal}): ${stderr.toString("utf8")}`,
      );
    return Buffer.concat(chunks);
  } catch (error) {
    terminate();
    await Promise.all([completed, stopping]);
    throw new Error(
      redact(
        error instanceof Error ? error.message : String(error),
        options.channels,
        options.privatePaths,
      ),
    );
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}

let ownWindowsSid: Promise<string> | undefined;
async function privateWindowsPath(path: string, directory: boolean): Promise<void> {
  const system = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  const execute = (command: string, args: string[]): Promise<string> =>
    new Promise((resolve, reject) =>
      execFile(
        join(system, command),
        args,
        { env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" }, windowsHide: true },
        (error, output) => (error ? reject(error) : resolve(output)),
      ),
    );
  if (!ownWindowsSid)
    ownWindowsSid = execute("whoami.exe", ["/user", "/fo", "csv", "/nh"]).then((output) => {
      const sid = /,"(S-\d+(?:-\d+)+)"\s*$/.exec(output)?.[1];
      if (!sid) throw new Error("Cannot establish private acquisition owner");
      return sid;
    });
  // A newly created directory has only inherited entries. Give the owner an
  // explicit inheritable ACE before stripping every inherited broad ACE.
  const sid = await ownWindowsSid;
  await execute("icacls.exe", [
    path,
    "/grant:r",
    `*${sid}:${directory ? "(OI)(CI)" : ""}F`,
    "/L",
    "/Q",
  ]);
  await execute("icacls.exe", [path, "/inheritance:r", "/L", "/Q"]);
}

export async function withPrivateAcquisition<T>(
  channels: RuntimeChannels,
  fn: (root: string, env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  await reapPrivateAcquisitions();
  const root = await mkdtemp(join(realpathSync(tmpdir()), "allagents-acquisition-"));
  try {
    await chmod(root, 0o700);
    if (process.platform === "win32") await privateWindowsPath(root, true);
    await atomicJson(join(root, ".allagents-owner.json"), {
      schemaVersion: 1,
      package: PACKAGE,
      kind: "source-acquisition",
      identity: await processIdentity(),
    });
    return await fn(root, sourceEnvironment(root));
  } catch (error) {
    throw new Error(
      redact(error instanceof Error ? error.message : String(error), channels, [root]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function reapPrivateAcquisitions(): Promise<void> {
  const temporaryRoot = realpathSync(tmpdir());
  const mountinfo =
    process.platform === "linux" ? await readFile("/proc/self/mountinfo", "utf8") : "";
  for (const name of await readdir(temporaryRoot)) {
    if (!/^allagents-acquisition-[A-Za-z0-9]+$/.test(name)) continue;
    const root = join(temporaryRoot, name);
    const stat = await lstat(root).catch(() => undefined);
    if (
      !stat ||
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (process.platform !== "win32" &&
        (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))
    )
      continue;
    try {
      const markerPath = join(root, ".allagents-owner.json");
      const markerStat = await lstat(markerPath);
      if (
        !markerStat.isFile() ||
        markerStat.isSymbolicLink() ||
        markerStat.nlink !== 1 ||
        markerStat.size > 4096 ||
        (process.platform !== "win32" &&
          (markerStat.uid !== stat.uid || (markerStat.mode & 0o077) !== 0))
      )
        continue;
      const marker = JSON.parse(await readFile(markerPath, "utf8")) as {
        schemaVersion: number;
        package: string;
        kind: string;
        identity: ProcessIdentity;
      };
      if (
        marker.package !== PACKAGE ||
        marker.schemaVersion !== 1 ||
        marker.kind !== "source-acquisition" ||
        !marker.identity ||
        !Number.isSafeInteger(marker.identity.pid) ||
        typeof marker.identity.start !== "string" ||
        typeof marker.identity.boot !== "string" ||
        typeof marker.identity.hostname !== "string"
      )
        continue;
      if (await alive(marker.identity)) continue;
      const mounted = mountinfo.split("\n").some((line) => {
        const path = line
          .split(" ")[4]
          ?.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
            String.fromCharCode(Number.parseInt(octal, 8)),
          );
        return path === root || path?.startsWith(`${root}${sep}`);
      });
      if (!mounted) await rm(root, { recursive: true, force: true });
    } catch {
      /* Malformed or racing roots grant no deletion authority. */
    }
  }
}

export async function orasEnvironment(
  root: string,
  env: NodeJS.ProcessEnv,
  channels: RuntimeChannels,
): Promise<{ env: NodeJS.ProcessEnv; args: string[]; redactions: string[] }> {
  const auth = channels.ALLAGENTS_ORAS_AUTH_FILE;
  if (!auth) return { env, args: [], redactions: [] };
  const target = join(root, "registry-auth.json");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const source = await lstat(auth);
  if (
    !source.isFile() ||
    source.isSymbolicLink() ||
    source.nlink !== 1 ||
    source.size > 1024 * 1024
  )
    throw new Error("Unsafe or oversized ORAS registry auth file");
  const fd = await open(auth, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: string;
  try {
    const actual = await fd.stat();
    if (!actual.isFile() || actual.nlink !== 1 || actual.size > 1024 * 1024)
      throw new Error("Unsafe or oversized ORAS registry auth file");
    bytes = await fd.readFile("utf8");
  } finally {
    await fd.close();
  }
  if (Buffer.byteLength(bytes) > 1024 * 1024) throw new Error("ORAS auth file exceeds 1 MiB");
  await writeFile(target, bytes, { mode: 0o600, flag: "wx" });
  if (process.platform === "win32") await privateWindowsPath(target, false);
  const redactions = [bytes];
  const collect = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (
        typeof entry === "string" &&
        ["auth", "password", "identitytoken", "registrytoken"].includes(key.toLowerCase())
      ) {
        if (entry) redactions.push(entry);
        if (key === "auth") {
          const decoded = Buffer.from(entry, "base64").toString();
          redactions.push(decoded, ...decoded.split(":").filter(Boolean));
        }
      } else if (entry && typeof entry === "object") collect(entry);
    }
  };
  try {
    collect(JSON.parse(bytes));
  } catch {
    throw new Error("Malformed ORAS registry auth JSON");
  }
  return { env, args: ["--registry-config", target], redactions };
}
