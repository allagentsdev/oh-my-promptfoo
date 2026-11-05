import { execFile } from "node:child_process";
import { dirname, matchesGlob, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";
import { redact, secrets } from "./redaction.js";
import type { CaseReport, EvaluationReport } from "./reporting.js";
import { record } from "./result-cost.js";

export interface SourceOptions {
  configPath: string;
  repositoryRoot: string;
  repositoryUrl: string;
  revision: string;
}

export function sourceUrl(input: unknown): string | undefined {
  if (typeof input !== "string") return;
  try {
    const url = new URL(input);
    if (url.protocol === "https:" && !url.username && !url.password && !url.search)
      return url.href.replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`);
  } catch {}
}

/** Locate authored definitions in committed blobs; never load providers or select cases. */
export async function addSourceLinks(
  report: EvaluationReport,
  options: SourceOptions,
  document?: unknown,
  sensitiveValues: string[] = [],
): Promise<EvaluationReport> {
  const base = sourceUrl(options.repositoryUrl);
  if (!base || new URL(base).hash || !/^[a-f\d]{40,64}$/i.test(options.revision)) return report;
  const root = resolve(options.repositoryRoot);
  const config = relative(root, resolve(root, options.configPath)).split(sep).join("/");
  const git = async (...args: string[]) =>
    (await promisify(execFile)("git", ["-C", root, ...args], { maxBuffer: 8 * 1024 * 1024 }))
      .stdout;
  try {
    const tracked = (await git("ls-tree", "-r", "--name-only", "-z", options.revision))
      .split("\0")
      .filter(Boolean);
    if (!tracked.includes(config)) return report;
    const sensitive = [...secrets(record(record(document).config), {}), ...sensitiveValues];
    const link = (path: string, line?: number) => {
      if (redact(path, sensitive) !== path) return;
      const url = `${base.replace(/\/$/, "")}/blob/${options.revision}/${path.split("/").map(encodeURIComponent).join("/")}${line ? `#L${line}` : ""}`;
      return redact(url, sensitive) === url ? sourceUrl(url) : undefined;
    };
    const candidates: {
      description?: string;
      vars: Record<string, unknown>;
      url: string;
      file: string;
    }[] = [];
    const files = new Set<string>();
    const visited = new Set<string>();
    let opaque = false;
    const scan = async (path: string, configFile = false): Promise<void> => {
      if (visited.has(path)) return;
      visited.add(path);
      const fileUrl = link(path);
      if (fileUrl && !configFile) files.add(fileUrl);
      if (!/\.(?:ya?ml|json)$/i.test(path)) {
        opaque = true;
        return;
      }
      const counter = new LineCounter();
      const parsed = parseDocument(await git("show", `${options.revision}:${path}`), {
        lineCounter: counter,
        logLevel: "silent",
      });
      if (parsed.errors.length) {
        opaque = true;
        return;
      }
      const collect = async (node: unknown): Promise<void> => {
        if (isSeq(node)) {
          for (const item of node.items) await collect(item);
        } else if (isScalar(node) && typeof node.value === "string") {
          const resource = node.value.replace(/^file:\/\//, "");
          if (/^[\w+.-]+:\/\//.test(resource) || resource.includes("{{")) {
            opaque = true;
            return;
          }
          const pattern = relative(root, resolve(root, dirname(path), resource))
            .split(sep)
            .join("/");
          let found = false;
          for (const file of tracked)
            if (matchesGlob(file, pattern)) {
              found = true;
              await scan(file);
            }
          if (!found) opaque = true;
        } else if (isMap(node) && node.has("path")) {
          const reference = node.get("path", true);
          if (isScalar(reference) && typeof reference.value === "string") await collect(reference);
          else opaque = true;
        } else if (isMap(node) && node.range) {
          const description = node.get("description");
          const vars = node.get("vars", true);
          const url = link(path, counter.linePos(node.range[0]).line);
          if (url)
            candidates.push({
              ...(typeof description === "string" ? { description } : {}),
              vars: isMap(vars) ? record(vars.toJSON()) : {},
              url,
              file: path,
            });
        }
      };
      if (configFile && isMap(parsed.contents)) {
        await collect(parsed.contents.get("tests", true));
        const scenarios = parsed.contents.get("scenarios", true);
        if (isSeq(scenarios))
          for (const scenario of scenarios.items)
            if (isMap(scenario)) await collect(scenario.get("tests", true));
      } else await collect(parsed.contents);
    };
    await scan(config, true);
    const byDescription = new Map<string | undefined, typeof candidates>();
    for (const candidate of candidates) {
      const bucket = byDescription.get(candidate.description) ?? [];
      bucket.push(candidate);
      byDescription.set(candidate.description, bucket);
    }
    const exported = record(record(document).results).results;
    const rows = Array.isArray(exported) ? exported : [];
    return {
      ...report,
      cases: report.cases.map((item): CaseReport => {
        const test = record(record(rows[item.row - 1]).testCase);
        const description = typeof test.description === "string" ? test.description : item.label;
        const described = description?.trim() ? (byDescription.get(description) ?? []) : [];
        let matches = described;
        if (matches.length !== 1)
          matches = candidates.filter((candidate) => {
            if (candidate.description !== undefined && candidate.description !== description)
              return false;
            const entries = Object.entries(candidate.vars);
            return (
              entries.length > 0 &&
              entries.every(([key, value]) => isDeepStrictEqual(value, record(test.vars)[key]))
            );
          });
        const urls = new Set(opaque ? [] : matches.map((candidate) => candidate.url));
        const origins = new Set(
          opaque ? [] : (matches.length ? matches : described).map((candidate) => candidate.file),
        );
        const fallback =
          origins.size === 1
            ? link([...origins][0])
            : candidates.length === 0 && files.size === 1
              ? [...files][0]
              : link(config);
        const url = urls.size === 1 ? [...urls][0] : fallback;
        return url
          ? { ...item, source: { url, location: urls.size === 1 ? "test" : "file" } }
          : item;
      }),
    };
  } catch {
    return report;
  }
}
