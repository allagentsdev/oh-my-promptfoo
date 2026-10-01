import { isAbsolute, posix } from "node:path";
import type { SourceLimits, WorkspaceSpec } from "./types.js";
export const DEFAULT_LIMITS: SourceLimits = {
  maxSources: 8,
  maxDownloadBytes: 268435456,
  maxExtractedBytes: 536870912,
  timeoutMs: 120000,
};
export const RUNTIME_CHANNELS = [
  "ALLAGENTS_GIT_USERNAME",
  "ALLAGENTS_GIT_TOKEN",
  "ALLAGENTS_GIT_STAGING_ROOT",
  "ALLAGENTS_ORAS_PATH",
  "ALLAGENTS_ORAS_AUTH_FILE",
  "ALLAGENTS_WORKSPACE_ROOT",
  "ALLAGENTS_CACHE_ROOT",
] as const;
export function object(value: unknown, name: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}
export function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`Unknown ${name} key: ${key}`);
}
export function destination(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.normalize("NFC") ||
    isAbsolute(value) ||
    value.includes("\\") ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32) ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").some((p) => !p || p === "." || p === "..") ||
    posix.normalize(value) !== value
  )
    throw new Error("Source destination must be a normalized contained relative path");
  return value;
}
export function validateWorkspace(value: unknown): WorkspaceSpec {
  const config = object(value, "workspace");
  exactKeys(config, ["sources", "limits", "viewMode"], "workspace");
  if (!Array.isArray(config.sources)) throw new Error("workspace.sources must be an array");
  if (
    config.viewMode !== undefined &&
    config.viewMode !== "auto" &&
    config.viewMode !== "copy-only"
  )
    throw new Error("workspace.viewMode must be auto or copy-only");
  const limits = { ...DEFAULT_LIMITS };
  if (config.limits !== undefined) {
    const authored = object(config.limits, "workspace.limits");
    exactKeys(authored, Object.keys(limits), "workspace.limits");
    for (const key of Object.keys(authored) as (keyof SourceLimits)[]) {
      const n = authored[key];
      if (
        !Number.isSafeInteger(n) ||
        (n as number) <= 0 ||
        (n as number) >
          {
            maxSources: 64,
            maxDownloadBytes: 50 * 1024 ** 3,
            maxExtractedBytes: 50 * 1024 ** 3,
            timeoutMs: 3600000,
          }[key]
      )
        throw new Error(`Invalid source limit ${key}`);
      limits[key] = n as number;
    }
  }
  if (config.sources.length > limits.maxSources) throw new Error("Too many workspace sources");
  const seen: string[] = [];
  const sources = config.sources.map((raw, index) => {
    const source = object(raw, `source ${index}`);
    const type = source.type;
    if (type !== "git" && type !== "oci") throw new Error("Unsupported workspace source type");
    exactKeys(
      source,
      type === "git"
        ? ["type", "repository", "ref", "destination", "permissions"]
        : ["type", "repository", "digest", "tag", "destination", "permissions"],
      "source",
    );
    const dest = destination(source.destination);
    if (seen.some((s) => s === dest || s.startsWith(`${dest}/`) || dest.startsWith(`${s}/`)))
      throw new Error("Source destinations overlap");
    seen.push(dest);
    if (
      source.permissions !== undefined &&
      source.permissions !== "all" &&
      source.permissions !== "read-only"
    )
      throw new Error("Invalid source permissions");
    if (typeof source.repository !== "string" || !source.repository)
      throw new Error("Source repository required");
    if (type === "git") {
      let url: URL;
      try {
        url = new URL(source.repository);
      } catch {
        throw new Error("Invalid Git repository URL");
      }
      if (
        !["https:", "file:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol === "file:" && url.hostname && url.hostname !== "localhost")
      )
        throw new Error("Git repository must be credential-free https:// or file:// URL");
      if (
        typeof source.ref !== "string" ||
        !source.ref ||
        Array.from(source.ref).some((char) => char.charCodeAt(0) <= 32) ||
        source.ref.startsWith("-")
      )
        throw new Error("Invalid Git ref");
    } else {
      if (
        /[@\s]/u.test(source.repository) ||
        source.repository.includes("://") ||
        source.repository.startsWith("/") ||
        source.repository.includes("..") ||
        !source.repository.includes("/")
      )
        throw new Error("Invalid OCI repository");
      if ((source.tag === undefined) === (source.digest === undefined))
        throw new Error("OCI source requires exactly one tag or digest");
      if (
        source.digest !== undefined &&
        (typeof source.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(source.digest))
      )
        throw new Error("Invalid OCI digest");
      if (
        source.tag !== undefined &&
        (typeof source.tag !== "string" || !/^[\w][\w.-]{0,127}$/.test(source.tag))
      )
        throw new Error("Invalid OCI tag");
    }
    return { ...source, destination: dest, permissions: source.permissions ?? "all" };
  });
  return { sources, limits, viewMode: config.viewMode ?? "auto" } as WorkspaceSpec;
}
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  throw new Error("Non-JSON canonical value");
}
