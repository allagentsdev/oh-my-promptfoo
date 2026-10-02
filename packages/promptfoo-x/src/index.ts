import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type Baseline,
  captureFileChanges,
  establishBaseline,
  type FileChanges,
} from "../../workspace-core/src/file-changes.js";
import {
  RUNTIME_CHANNELS,
  type WorkspaceHandle,
  WorkspaceManager,
  type WorkspaceSpec,
} from "../../workspace-core/src/index.js";
import { nextCaseIndex, publishProgress } from "../../workspace-core/src/progress.js";
import {
  type CopilotSdkProviderConfig,
  envelope,
  immutable,
  type JsonObject,
  type ProviderConfig,
  type ProviderOptions,
  promptConfig,
  validateCopilotConfig,
  validateProviderConfig,
} from "./config.js";
import { jsonSafe, redact, runDelegate, secrets, wireContext } from "./protocol.js";

export type { CapturedFile, FileChanges } from "../../workspace-core/src/file-changes.js";
export type {
  GitSource,
  OciSource,
  ResolvedSource,
  WorkspaceHandle,
  WorkspaceSource,
  WorkspaceSpec,
} from "../../workspace-core/src/index.js";
export type {
  ClaudeDelegate,
  CodexDelegate,
  CopilotDelegate,
  CopilotSdkProviderConfig,
  Delegate,
  ProviderConfig,
  ProviderOptions,
} from "./config.js";
export interface CallOptions {
  abortSignal?: AbortSignal;
}
export interface WorkspaceMetadata {
  schemaVersion: 1;
  path: string;
  manifestDigest: `sha256:${string}`;
  sources: WorkspaceHandle["sources"];
  cleanup: "best-effort-evaluation";
}

class Calls {
  private closed = false;
  private active = new Map<AbortController, Promise<unknown>>();
  protected execute<T>(
    signal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Provider is closed"));
    if (signal?.aborted) return Promise.reject(new Error("Provider call aborted before execution"));
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    // Start in a microtask so cleanup always sees the promise before execution begins.
    const call = Promise.resolve()
      .then(() => run(controller.signal))
      .finally(() => {
        signal?.removeEventListener("abort", abort);
        this.active.delete(controller);
      });
    this.active.set(controller, call);
    return call;
  }
  protected async stopCalls(): Promise<void> {
    this.closed = true;
    for (const controller of this.active.keys()) controller.abort();
    await Promise.allSettled(this.active.values());
  }
}

export class Provider extends Calls {
  // Promptfoo 0.122 unwraps a module's default before selecting its named
  // package export. Keep the ordinary default class while exposing that loader's
  // named constructors and a default alias on the same function object.
  static readonly Provider = Provider;
  static readonly default = Provider;
  static get CopilotSdkProvider(): typeof CopilotSdkProvider {
    return CopilotSdkProvider;
  }
  readonly config: ProviderConfig;
  private readonly basePath: string;
  private readonly manager: WorkspaceManager;
  private readonly providerId: string;
  private cleanupPromise?: Promise<void>;
  constructor(options: ProviderOptions = {}) {
    super();
    const { config, basePath } = envelope(options);
    this.config = immutable(validateProviderConfig(JSON.parse(jsonSafe(config))));
    this.basePath = basePath;
    this.providerId = options.id ?? "allagents:workspace";
    const channels: Record<string, string | undefined> = {};
    for (const key of RUNTIME_CHANNELS) channels[key] = options.env?.[key] ?? process.env[key];
    this.manager = new WorkspaceManager(
      this.config.workspace as unknown as WorkspaceSpec,
      channels,
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
    try {
      return await this.execute(options?.abortSignal, async (signal) => {
        let handle: WorkspaceHandle | undefined;
        let baseline: Baseline | undefined;
        let baselineError: string | undefined;
        let published = false;
        try {
          handle = await this.manager.prepare(signal, caseIndex);
          if (this.config.fileChanges) {
            try {
              baseline = await establishBaseline(handle);
            } catch (error) {
              baselineError =
                error instanceof Error ? error.message : "Unable to establish file baseline";
            }
          }
          publishProgress("agent-start", caseIndex);
          let response: JsonObject;
          try {
            response = await runDelegate(
              {
                version: 1,
                type: "call",
                delegate: this.config.delegate.id,
                basePath: this.basePath,
                workingDir: handle.path,
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
          await this.manager.validateProtected(handle);
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
                  schemaVersion: 1,
                  status: "failed",
                  generatedFiles: {},
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
      return {
        error: redact(error instanceof Error ? error.message : String(error), secrets(merged, env)),
      };
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

export class CopilotSdkProvider extends Calls {
  readonly config: CopilotSdkProviderConfig;
  private readonly basePath: string;
  private readonly providerId: string;
  constructor(options: ProviderOptions = {}) {
    super();
    const { config, basePath } = envelope(options);
    this.config = immutable(validateCopilotConfig(JSON.parse(jsonSafe(config))));
    this.basePath = basePath;
    this.providerId = options.id ?? "copilot-sdk";
  }
  id(): string {
    return this.providerId;
  }
  async callApi(prompt: string, context?: unknown, options?: CallOptions): Promise<JsonObject> {
    const { working_dir, env = {}, ...original } = this.config;
    try {
      if (typeof prompt !== "string") throw new Error("Provider prompt must be a string");
      const config = promptConfig(context, "copilot-sdk", original);
      const ctx = wireContext(context);
      return await this.execute(options?.abortSignal, async (signal) => {
        const workingDir = await realpath(resolve(this.basePath, working_dir));
        if (!(await stat(workingDir)).isDirectory())
          throw new Error("working_dir must identify an existing directory");
        return runDelegate(
          {
            version: 1,
            type: "call",
            delegate: "copilot-sdk",
            basePath: this.basePath,
            workingDir,
            config,
            prompt,
            context: ctx,
          },
          env,
          this.config.timeoutMs ?? 900_000,
          signal,
        );
      });
    } catch (error) {
      return {
        error: redact(
          error instanceof Error ? error.message : String(error),
          secrets(original, env),
        ),
      };
    }
  }
  async cleanup(): Promise<void> {
    await this.stopCalls();
  }
}

export default Provider;
