import { realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  type Baseline,
  captureFileChanges,
  establishBaseline,
  type FileChanges,
} from "../../workspace-core/src/file-changes.js";
import {
  localSourceBoundary,
  RUNTIME_CHANNELS,
  type WorkspaceHandle,
  WorkspaceManager,
  type WorkspaceSpec,
} from "../../workspace-core/src/index.js";
import { nextCaseIndex, publishProgress } from "../../workspace-core/src/progress.js";
import { type CallOptions, Calls } from "./calls.js";
import {
  type AgentConfig,
  envelope,
  immutable,
  type JsonObject,
  type ProviderOptions,
  promptConfig,
  resolveSourcePaths,
  validateAgentConfig,
} from "./config.js";
import { copilotFailure } from "./copilot-accounting.js";
import { jsonSafe, redact, runDelegate, secrets, wireContext } from "./protocol.js";

export interface WorkspaceMetadata {
  schemaVersion: 1;
  path: string;
  manifestDigest: `sha256:${string}`;
  sources: WorkspaceHandle["sources"];
  cleanup: "best-effort-evaluation";
}

export class Agent extends Calls {
  readonly config: AgentConfig;
  private readonly basePath: string;
  private readonly manager: WorkspaceManager;
  private readonly providerId: string;
  private cleanupPromise?: Promise<void>;
  constructor(options: ProviderOptions = {}) {
    super();
    const { config, basePath } = envelope(options);
    const validated = validateAgentConfig(JSON.parse(jsonSafe(config)));
    this.config = immutable({
      ...validated,
      workspace: resolveSourcePaths(validated.workspace, basePath),
    });
    this.basePath = basePath;
    this.providerId = options.id ?? "allagents:workspace";
    const channels: Record<string, string | undefined> = {};
    for (const key of RUNTIME_CHANNELS) channels[key] = options.env?.[key] ?? process.env[key];
    // Without a runner override, local sources stay inside the repository holding the config.
    if (
      channels.ALLAGENTS_LOCAL_SOURCE_ROOT === undefined &&
      Array.isArray(this.config.workspace.sources) &&
      this.config.workspace.sources.some((source) => source?.type === "local")
    )
      channels.ALLAGENTS_LOCAL_SOURCE_ROOT = localSourceBoundary(basePath);
    this.manager = new WorkspaceManager(
      this.config.workspace as unknown as WorkspaceSpec,
      channels,
      this.config.workspaceTimeoutMs,
    );
  }
  id(): string {
    return this.providerId;
  }
  async callApi(prompt: string, context?: unknown, options?: CallOptions): Promise<JsonObject> {
    const caseIndex = nextCaseIndex();
    publishProgress("case-start", caseIndex);
    let outcome: "ok" | "error" = "error";
    try {
      const result = await this.callCase(prompt, context, options, caseIndex);
      outcome = Object.hasOwn(result, "error") ? "error" : "ok";
      if (caseIndex === undefined) return result;
      const metadata = result.metadata;
      return {
        ...result,
        metadata: {
          ...(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {}),
          allagentsCaseIndex: caseIndex,
        },
      };
    } finally {
      publishProgress("case-finished", caseIndex, undefined, undefined, outcome);
    }
  }
  private async callCase(
    prompt: string,
    context: unknown,
    options: CallOptions | undefined,
    caseIndex: number | undefined,
  ): Promise<JsonObject> {
    const env = this.config.delegate.env ?? {};
    let merged: JsonObject;
    let ctx: JsonObject;
    try {
      if (typeof prompt !== "string") throw new Error("Provider prompt must be a string");
      merged = promptConfig(context, this.config.delegate.id, this.config.delegate.config ?? {});
      ctx = wireContext(context);
    } catch (error) {
      return {
        error: redact((error as Error).message, secrets(this.config.delegate.config ?? {}, env)),
      };
    }
    let response: JsonObject | undefined;
    try {
      return await this.execute(options?.abortSignal, async (signal) => {
        let handle: WorkspaceHandle | undefined;
        let baseline: Baseline | undefined;
        let baselineError: string | undefined;
        let published = false;
        try {
          handle = await this.manager.prepare(signal, caseIndex);
          const workingDir = this.config.workingDir
            ? await workspaceWorkingDir(handle, this.config.workingDir)
            : handle.path;
          if (this.config.fileChanges) {
            try {
              baseline = await establishBaseline(handle);
            } catch (error) {
              baselineError =
                error instanceof Error ? error.message : "Unable to establish file baseline";
            }
          }
          publishProgress("agent-start", caseIndex);
          try {
            response = await runDelegate(
              {
                version: 1,
                type: "call",
                delegate: this.config.delegate.id,
                basePath: this.basePath,
                workingDir,
                config: merged,
                prompt,
                context: ctx,
              },
              env,
              this.config.timeoutMs ?? 900_000,
              signal,
            );
            publishProgress(
              "agent-finished",
              caseIndex,
              undefined,
              undefined,
              Object.hasOwn(response, "error") ? "error" : "ok",
            );
          } catch (error) {
            publishProgress("agent-finished", caseIndex, undefined, undefined, "error");
            throw error;
          }
          await this.manager.validateProtected(handle, caseIndex);
          const metadata = response.metadata === undefined ? {} : response.metadata;
          if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
            throw new Error("Delegate metadata must be a JSON object");
          if (Object.hasOwn(metadata, "workspace") || Object.hasOwn(metadata, "fileChanges"))
            throw new Error("Delegate metadata owns reserved workspace or fileChanges keys");
          let fileChanges: FileChanges | undefined;
          if (this.config.fileChanges) {
            fileChanges = baseline
              ? await captureFileChanges(handle, baseline)
              : {
                  schemaVersion: 2,
                  status: "failed",
                  changedFiles: {},
                  deletedFiles: [],
                  truncated: false,
                  failure: {
                    code: "BASELINE_FAILED",
                    message: baselineError ?? "Baseline unavailable",
                  },
                };
          }
          const workspace: WorkspaceMetadata = {
            schemaVersion: 1,
            path: handle.path,
            manifestDigest: handle.manifestDigest,
            sources: handle.sources,
            cleanup: "best-effort-evaluation",
          };
          const result = {
            ...response,
            metadata: { ...metadata, workspace, ...(fileChanges ? { fileChanges } : {}) },
          };
          const encoded = jsonSafe(result, 32 * 1024 * 1024);
          published = true;
          return JSON.parse(redact(encoded, secrets(merged, env))) as JsonObject;
        } finally {
          if (handle && !published) await this.manager.release(handle);
        }
      });
    } catch (error) {
      const message = redact(
        error instanceof Error ? error.message : String(error),
        secrets(merged, env),
      );
      return (response && copilotFailure(response, message)) ?? { error: message };
    }
  }
  cleanup(): Promise<void> {
    this.cleanupPromise ??= (async () => {
      await this.stopCalls();
      await this.manager.cleanup();
    })();
    return this.cleanupPromise;
  }
}

async function workspaceWorkingDir(handle: WorkspaceHandle, path: string): Promise<string> {
  const workingDir = resolve(handle.path, path);
  let actual: string;
  try {
    actual = await realpath(workingDir);
    if (!(await stat(actual)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error("config.workingDir must identify an existing directory in the workspace");
  }
  const roots = [
    await realpath(handle.path),
    ...(await Promise.all(
      handle.adapters
        .filter((view) => view.adapter === "read-only")
        .map((view) => realpath(view.path)),
    )),
  ];
  if (
    !roots.some((root) => {
      const rel = relative(root, actual);
      return !rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
    })
  )
    throw new Error("config.workingDir must stay inside the workspace or a protected source");
  return workingDir;
}
