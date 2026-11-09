import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readProgress, readWorkspaceTiming } from "./eval-progress.js";
import { secrets } from "./redaction.js";
import {
  addSourceLinks,
  type EvaluationProgress,
  type EvaluationReport,
  type ReportOptions,
  renderConsoleSummary,
  renderProgress,
  renderSummary,
  summarizeEvaluation,
} from "./reporting.js";

export interface EvaluationOptions extends ReportOptions {
  config: string;
  outputDirectory: string;
  workingDirectory?: string;
  args?: string[];
  github?: boolean;
  /** Called as native afterEach hooks complete; final exports remain authoritative. */
  onProgress?: (progress: EvaluationProgress) => void;
}
export interface EvaluationRun {
  directory: string;
  resultPath: string;
  logPath: string;
  reportPath: string;
  summaryPath: string;
  resultsAvailable: boolean;
  exitCode: number | null;
  report: EvaluationReport;
}

const reservedNativeOptions = new Set([
  "config",
  "output",
  "share",
  "no-share",
  "write",
  "no-write",
  "watch",
  "resume",
  "retry-errors",
  "help",
  "version",
  "suggest-prompts",
]);

interface NativeOption {
  required: boolean;
  optional: boolean;
}
const nativeOptions = new Map<string, Promise<Map<string, NativeOption>>>();

/** Option arity comes from the installed CLI's public help, never its private parser. */
function readNativeOptions(
  executable: string,
  env: NodeJS.ProcessEnv,
): Promise<Map<string, NativeOption>> {
  let pending = nativeOptions.get(executable);
  if (pending) return pending;
  pending = (async () => {
    const help = [];
    // CLI startup initializes its own config database even for help; serialize
    // these public calls against the invocation's private config directory.
    for (const command of [[], ["eval"]]) {
      help.push(
        await promisify(execFile)(process.execPath, [executable, ...command, "--help"], {
          cwd: dirname(executable),
          env: { ...env, FORCE_COLOR: "0" },
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
        }),
      );
    }
    const options = new Map<string, NativeOption>();
    for (const { stdout } of help)
      for (const line of stdout.split("\n")) {
        if (/^Global Options:/i.test(line.trim())) break;
        const column = line.trim().split(/\s{2,}/)[0];
        if (!column.startsWith("-")) continue;
        const names = column.match(/--[\w-]+|-[A-Za-z?]/g) ?? [];
        for (const name of names)
          options.set(name, { required: column.includes("<"), optional: column.includes("[") });
      }
    if (!options.get("--config")?.required || !options.get("--output")?.required)
      throw new Error("Native CLI help did not declare config/output ownership");
    return options;
  })();
  nativeOptions.set(executable, pending);
  pending.catch(() => nativeOptions.delete(executable));
  return pending;
}

export function validateNativeArgs(
  args: unknown,
  options = new Map<string, NativeOption>(),
): asserts args is string[] {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0")))
    throw new Error("Native arguments must be a JSON array of strings");
  const reserved = (flag: string) => {
    if (reservedNativeOptions.has(flag.slice(2)) || ["-c", "-o", "-w", "-h", "-V"].includes(flag))
      throw new Error("A reserved native argument was supplied");
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") throw new Error("A reserved native argument was supplied");
    if (!arg.startsWith("-") || arg === "-") continue;
    const flags = arg.startsWith("--")
      ? [arg.split("=", 1)[0]]
      : [...arg.slice(1)].map((letter) => `-${letter}`);
    for (const [offset, flag] of flags.entries()) {
      reserved(flag);
      const option = options.get(flag);
      const attached = arg.startsWith("--") ? arg.includes("=") : offset < flags.length - 1;
      if (option?.required) {
        if (!attached && args[++index] === undefined)
          throw new Error("A native argument value is missing");
        break;
      }
      if (option?.optional) {
        if (!attached && args[index + 1] !== undefined && !args[index + 1].startsWith("-")) index++;
        break;
      }
    }
  }
}

async function promptfooExecutable(): Promise<string> {
  let directory = dirname(createRequire(import.meta.url).resolve("promptfoo"));
  while (true) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (manifest.name === "promptfoo" && typeof manifest.bin?.promptfoo === "string")
        return resolve(directory, manifest.bin.promptfoo);
    } catch {}
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Promptfoo executable unavailable");
    directory = parent;
  }
}

async function files(outputDirectory: string, options: ReportOptions): Promise<EvaluationRun> {
  await mkdir(outputDirectory, { recursive: true });
  const directory = await mkdtemp(join(outputDirectory, "run-"));
  return {
    directory,
    resultPath: join(directory, "results.json"),
    logPath: join(directory, "native.log"),
    reportPath: join(directory, "report.json"),
    summaryPath: join(directory, "summary.md"),
    resultsAvailable: false,
    exitCode: null,
    report: summarizeEvaluation(undefined, null, options),
  };
}

async function readResults(
  run: EvaluationRun,
  options: ReportOptions,
  exitCode?: number | null,
): Promise<void> {
  try {
    const document = JSON.parse(await readFile(run.resultPath, "utf8"));
    run.resultsAvailable = true;
    run.report = summarizeEvaluation(document, exitCode, options);
    if (options.publicLabels && options.source)
      run.report = await addSourceLinks(
        run.report,
        options.source,
        document,
        options.sensitiveValues,
      );
  } catch {
    run.report = summarizeEvaluation(undefined, exitCode, options);
  }
}

function reportingOptions(options: ReportOptions): ReportOptions {
  return {
    suiteNumber: options.suiteNumber,
    source: options.source,
    publicLabels: options.publicLabels,
    sensitiveValues: options.publicLabels
      ? [
          ...(options.sensitiveValues ?? []),
          ...secrets(
            {},
            Object.fromEntries(
              Object.entries(process.env).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
              ),
            ),
          ),
        ]
      : [],
  };
}

async function finish(
  run: EvaluationRun,
  github: boolean,
  reportingStarted: number,
): Promise<EvaluationRun> {
  // Include normalization, source links and initial rendering; file publication follows.
  renderSummary(run.report);
  run.report.timings = { ...run.report.timings, reportingMs: performance.now() - reportingStarted };
  const markdown = renderSummary(run.report);
  await writeFile(run.reportPath, `${JSON.stringify(run.report, null, 2)}\n`, { mode: 0o600 });
  await writeFile(run.summaryPath, markdown, { mode: 0o600 });
  if (github) {
    if (process.env.GITHUB_OUTPUT) {
      const outputs = {
        "result-path": run.resultPath,
        "results-available": String(run.resultsAvailable),
        "artifact-directory": run.directory,
        "log-path": run.logPath,
        "report-path": run.reportPath,
        "summary-path": run.summaryPath,
        "evaluation-status": run.report.status,
        "evaluation-exit-code": run.exitCode === null ? "unknown" : String(run.exitCode),
        replayed: String(run.report.replayed === true),
      };
      for (const [name, value] of Object.entries(outputs)) {
        const delimiter = randomUUID();
        await appendFile(
          process.env.GITHUB_OUTPUT,
          `${name}<<${delimiter}\n${value}\n${delimiter}\n`,
        );
      }
    }
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
  }
  return run;
}

async function discoverSource(
  config: string | undefined,
  cwd: string,
  reporting: ReportOptions,
  github: boolean,
): Promise<void> {
  if (
    !config ||
    !github ||
    !reporting.publicLabels ||
    reporting.source ||
    !process.env.GITHUB_REPOSITORY
  )
    return;
  try {
    const repositoryRoot = process.env.GITHUB_WORKSPACE || cwd;
    const { stdout } = await promisify(execFile)("git", [
      "-C",
      repositoryRoot,
      "rev-parse",
      "HEAD",
    ]);
    reporting.source = {
      configPath: resolve(cwd, config),
      repositoryRoot,
      repositoryUrl: `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${process.env.GITHUB_REPOSITORY}`,
      revision: stdout.trim(),
    };
  } catch {}
}

function toolchainTiming(): NonNullable<EvaluationReport["timings"]> {
  const value = process.env.ALLAGENTS_EVAL_TOOLCHAIN_MS;
  return value && Number.isFinite(Number(value)) && Number(value) >= 0
    ? { toolchainMs: Number(value) }
    : {};
}

/** Run one authored config through the installed peer's native CLI, retaining output on failure. */
export async function runEvaluation(options: EvaluationOptions): Promise<EvaluationRun> {
  const setupStarted = performance.now();
  const cwd = resolve(options.workingDirectory || process.cwd());
  const reporting = reportingOptions(options);
  const run = await files(resolve(cwd, options.outputDirectory), reporting);
  const log = await open(run.logPath, "wx", 0o600);
  const timings = toolchainTiming();
  let reportingStarted = setupStarted;
  try {
    const args = options.args === undefined ? [] : options.args;
    const config = resolve(cwd, options.config);
    if (!(await stat(config)).isFile()) throw new Error("One local config file is required");
    await discoverSource(config, cwd, reporting, options.github === true);
    const executable = await promptfooExecutable();
    const environment = {
      ...process.env,
      PROMPTFOO_DISABLE_SHARING: "1",
      PROMPTFOO_DISABLE_TELEMETRY: "1",
      PROMPTFOO_DISABLE_UPDATE: "1",
      PROMPTFOO_CONFIG_DIR: join(run.directory, "promptfoo"),
      PROMPTFOO_LOG_DIR: join(run.directory, "logs"),
      PROMPTFOO_FAILED_TEST_EXIT_CODE: "100",
    };
    validateNativeArgs(args, await readNativeOptions(executable, environment));
    const hookPath = join(
      process.env.OH_MY_PROMPTFOO_TEST_ENTRIES || dirname(fileURLToPath(import.meta.url)),
      "eval-progress.js",
    );
    if (!(await stat(hookPath)).isFile()) throw new Error("Evaluation progress hook unavailable");
    const progressHook = `file://${hookPath}`;
    timings.setupMs = performance.now() - setupStarted;
    const evaluationStarted = performance.now();
    const workspaces = new Set<number>();
    let workspaceSeen = false,
      workspaceMs = 0;
    try {
      run.exitCode = await new Promise<number | null>((resolveExit, reject) => {
        const child = spawn(
          process.execPath,
          [
            executable,
            "eval",
            ...args,
            "--config",
            config,
            "--output",
            run.resultPath,
            "--no-share",
            "--no-write",
            "--no-table",
            "--no-progress-bar",
            "--extension",
            `${progressHook}:afterEach`,
            "--extension",
            `${progressHook}:beforeAll`,
          ],
          {
            cwd,
            stdio: ["ignore", log.fd, log.fd, "ipc"],
            env: environment,
          },
        );
        let progressFailed = false;
        let progressError: unknown;
        let termination: ReturnType<typeof setTimeout> | undefined;
        child.once("error", reject);
        child.on("message", (input) => {
          if (progressFailed) return;
          const workspace = readWorkspaceTiming(input);
          if (workspace) {
            workspaceSeen = true;
            if (workspace.phase === "start") workspaces.add(workspace.caseIndex);
            else if (workspaces.delete(workspace.caseIndex)) workspaceMs += workspace.elapsedMs!;
            return;
          }
          const progress = readProgress(input);
          if (progress) {
            try {
              options.onProgress?.(progress);
            } catch (error) {
              progressFailed = true;
              progressError = error;
              child.kill();
              termination = setTimeout(() => child.kill("SIGKILL"), 5_000);
              termination.unref();
            }
          }
        });
        child.once("close", (code) => {
          clearTimeout(termination);
          if (progressFailed) reject(progressError);
          else resolveExit(code);
        });
      });
    } finally {
      timings.nativeEvaluationMs = performance.now() - evaluationStarted;
      if (workspaceSeen) timings.workspacePreparationMs = workspaces.size ? null : workspaceMs;
    }
    reportingStarted = performance.now();
    await readResults(run, reporting, run.exitCode);
    if (run.resultsAvailable) await chmod(run.resultPath, 0o600);
  } catch (error) {
    if (timings.setupMs === undefined) timings.setupMs = performance.now() - setupStarted;
    reportingStarted = performance.now();
    await log.write(error instanceof Error ? `${error.stack}\n` : "Evaluation setup failed\n");
    run.report = summarizeEvaluation(undefined, null, reporting);
  } finally {
    await log.close();
  }
  run.report.timings = timings;
  return finish(run, options.github === true, reportingStarted);
}

/** Re-render a native export locally, including files produced by a direct promptfoo eval. */
export async function reportEvaluation(
  resultPath: string,
  outputDirectory: string,
  options: ReportOptions & {
    replay?: boolean;
    github?: boolean;
    config?: string;
    workingDirectory?: string;
  } = {},
): Promise<EvaluationRun> {
  const reportingStarted = performance.now();
  const cwd = resolve(options.workingDirectory || process.cwd());
  const reporting = reportingOptions(options);
  const run = await files(resolve(cwd, outputDirectory), reporting);
  run.resultPath = resolve(cwd, resultPath);
  await writeFile(
    run.logPath,
    options.replay
      ? "Replayed a recorded native result; no candidate or grader calls.\n"
      : "Rendered a native result export.\n",
    { mode: 0o600 },
  );
  await discoverSource(options.config, cwd, reporting, options.github === true);
  await readResults(run, reporting);
  if (options.replay) run.report.replayed = true;
  run.report.timings = toolchainTiming();
  return finish(run, options.github === true, reportingStarted);
}

export async function evaluationCommand(command: "eval" | "report", args: string[]): Promise<void> {
  const separator = args.indexOf("--");
  const own = separator < 0 ? args : args.slice(0, separator);
  const native = separator < 0 ? [] : args.slice(separator + 1);
  const values = new Map<string, string>();
  let github = false;
  let replay = false;
  const valid =
    command === "eval"
      ? new Set(["--config", "--output-dir", "--working-directory", "--args-json", "--args-file"])
      : new Set(["--results", "--output-dir", "--config", "--working-directory"]);
  valid.add("--suite-number");
  valid.add("--public-labels");
  for (let i = 0; i < own.length; i++) {
    const option = own[i];
    if (option === "--github") {
      github = true;
      continue;
    }
    if (option === "--replay" && command === "report") {
      replay = true;
      continue;
    }
    if (!valid.has(option) || values.has(option) || own[i + 1] === undefined)
      throw new Error("Invalid evaluation command arguments");
    values.set(option, own[++i]);
  }
  const output = values.get("--output-dir") || ".promptfoo-ci";
  const suite = values.get("--suite-number") ?? "1";
  const labels = values.get("--public-labels") ?? "false";
  if (!/^[1-9]\d*$/.test(suite) || !Number.isSafeInteger(Number(suite)))
    throw new Error("Suite number must be a positive safe integer");
  if (!["true", "false"].includes(labels)) throw new Error("public-labels must be true or false");
  const reporting = { suiteNumber: Number(suite), publicLabels: labels === "true" };
  let run: EvaluationRun;
  if (command === "eval") {
    const config = values.get("--config");
    const argsFile = values.get("--args-file");
    if (
      !config ||
      (values.has("--args-json") && separator >= 0) ||
      (argsFile && separator >= 0) ||
      (argsFile && values.has("--args-json") && values.get("--args-json") !== "[]")
    )
      throw new Error("One config and one native argument source are required");
    let parsed: unknown;
    try {
      parsed = argsFile
        ? JSON.parse(
            await readFile(
              resolve(values.get("--working-directory") || process.cwd(), argsFile),
              "utf8",
            ),
          )
        : values.has("--args-json")
          ? JSON.parse(values.get("--args-json")!)
          : native;
    } catch {
      parsed = null;
    }
    let completed = 0;
    console.log("Evaluation started");
    run = await runEvaluation({
      config,
      outputDirectory: output,
      workingDirectory: values.get("--working-directory"),
      args: parsed as string[],
      github,
      onProgress: (progress) => console.log(renderProgress(progress, ++completed)),
      ...reporting,
    });
  } else {
    const results = values.get("--results");
    if (!results || native.length) throw new Error("One native result is required");
    run = await reportEvaluation(results, output, {
      ...reporting,
      replay,
      github,
      config: values.get("--config"),
      workingDirectory: values.get("--working-directory"),
    });
  }
  console.log(renderConsoleSummary(run.report));
  console.log(
    `Promptfoo: ${run.report.status}; pass=${run.report.counts.pass}, fail=${run.report.counts.fail}, error=${run.report.counts.error}`,
  );
  if (!github)
    console.log(
      JSON.stringify({
        directory: run.directory,
        resultPath: run.resultPath,
        reportPath: run.reportPath,
        summaryPath: run.summaryPath,
      }),
    );
  process.exitCode = run.report.status === "pass" ? 0 : 1;
}
