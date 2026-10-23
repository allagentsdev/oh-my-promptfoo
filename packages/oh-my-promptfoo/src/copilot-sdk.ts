import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { type CallOptions, Calls } from "./calls.js";
import {
  type CopilotSdkConfig,
  envelope,
  immutable,
  type JsonObject,
  type ProviderOptions,
  promptConfig,
  validateCopilotConfig,
} from "./config.js";
import { jsonSafe, redact, runDelegate, secrets, wireContext } from "./protocol.js";

export class CopilotSdk extends Calls {
  readonly config: CopilotSdkConfig;
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
