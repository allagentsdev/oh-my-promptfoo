import { spawnSync } from "node:child_process";
import { chmod, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
export class CopilotClient {
  constructor(options) {
    this.options = options;
    if (options.env.ALLAGENTS_GIT_TOKEN) throw Error("Source credential leaked");
  }
  async createSession(config) {
    if (config.model === "fixture-create-error") {
      this.sessionCreationFailed = true;
      throw Error("fixture session creation failed");
    }
    if (config.provider && typeof config.provider !== "object")
      throw Error("Endpoint must be object");
    let callback = () => {};
    const client = this;
    const invokedSkills = [];
    const rpc = {
      skills: {
        async getInvoked() {
          for (const event of scenario?.skillRpcEvents ?? []) callback(event);
          if (scenario?.skillState === "throw") throw Error("fixture skill RPC failed");
          if (scenario?.skillState === "hang") await new Promise(() => {});
          if (scenario?.skillState === "malformed") return { skills: "not-an-array" };
          if (scenario?.verifiedSkill) {
            const path = resolve(config.workingDirectory, scenario.verifiedSkill);
            const content = (await readFile(path, "utf8"))
              .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
              .trim();
            return {
              skills: [
                { name: scenario.verifiedSkill.split("/").at(-2), path, content, invokedAtTurn: 1 },
                { name: {}, path: "/unrelated/SKILL.md", content: "malformed unrelated name" },
              ],
            };
          }
          if (scenario?.skills !== undefined) return { skills: scenario.skills };
          return { skills: invokedSkills };
        },
      },
    };
    let scenario;
    let settled = false;
    let disconnected = false;
    let unsubscribed = false;
    let captures = 0;
    let rejectSend;
    return {
      rpc,
      on(fn) {
        callback = fn;
        return () => {
          unsubscribed = true;
          callback = () => {};
        };
      },
      async sendAndWait({ prompt }) {
        if (prompt.startsWith("inventory:")) {
          scenario = JSON.parse(prompt.slice("inventory:".length));
          client.inventoryStopErrors = scenario.stopErrors;
          if (config.includeSubAgentStreamingEvents !== true)
            throw Error("Subagent tool streaming must be enabled");
          if (scenario.skillState === "unsupported") delete rpc.skills;
          if (scenario.eventBytes)
            callback({ type: "session.info", data: { content: "x".repeat(scenario.eventBytes) } });
          if (scenario.unsafeArguments) {
            callback({
              type: "tool.execution_start",
              data: { toolCallId: "unsafe", toolName: "read", arguments: () => "unsafe" },
            });
            callback({
              type: "tool.execution_complete",
              data: { toolCallId: "unsafe", success: true },
            });
          }
          for (let i = 0; i < (scenario.repeat ?? 0); i++) {
            if (scenario.repeatKind === "events") callback({ type: "session.info", data: {} });
            else {
              callback({
                type: "tool.execution_start",
                data: {
                  toolCallId: `call-${i}`,
                  toolName: "read",
                  arguments: { value: "x".repeat(scenario.argumentBytes ?? 0) },
                },
              });
              callback({
                type: "tool.execution_complete",
                data: { toolCallId: `call-${i}`, success: true },
              });
            }
          }
          for (const event of scenario.events ?? []) {
            // A subagent event is emitted only when the real session option enables it.
            if (!event.agentId || config.includeSubAgentStreamingEvents) callback(event);
          }
          if (scenario.executionError) throw Error("fixture inventory execution failed");
          if (scenario.sessionError)
            callback({
              type: "session.error",
              data: { message: "fixture inventory session failed" },
            });
          const content = "inventory fixture output";
          callback({ type: "assistant.message", data: { content } });
          if (!scenario.missingIdle)
            callback({ type: "session.idle", data: scenario.idleData ?? {} });
          for (const event of scenario.afterIdleEvents ?? []) callback(event);
          return { data: { content } };
        }
        if (prompt.startsWith("accounting:")) {
          scenario = JSON.parse(prompt.slice("accounting:".length));
          if (scenario.metrics !== "unsupported") {
            rpc.usage = {
              async getMetrics() {
                if (!settled || unsubscribed || disconnected || ++captures !== 1)
                  throw Error("Metrics must be captured once after execution and before cleanup");
                if (scenario.metrics === "hang") await new Promise(() => {});
                if (scenario.metrics === "throw") throw Error("private telemetry failure");
                const totals = {
                  complete: 2_500_000_000,
                  zero: 0,
                  invalid: "2500000000",
                  unsafe: Number.MAX_SAFE_INTEGER + 1,
                  fractional: 0.5,
                  negative: -1,
                  nan: NaN,
                  infinity: Infinity,
                };
                return {
                  ...(scenario.metrics in totals ? { totalNanoAiu: totals[scenario.metrics] } : {}),
                  currentModel: "fixture-current",
                  totalPremiumRequestCost: 1.5,
                  totalUserRequests: 2,
                  modelMetrics: { "fixture-current": { totalNanoAiu: 9_000_000_000 } },
                  agentMetrics: { main: { totalNanoAiu: 8_000_000_000 } },
                  privateTelemetry: "must not escape",
                };
              },
            };
          }
          for (const cost of scenario.eventCosts ?? [0.25, 0.5])
            callback({ type: "assistant.usage", data: { inputTokens: 3, outputTokens: 2, cost } });
          callback({ type: "session.usage_info", data: { totalNanoAiu: 7_000_000_000 } });
          callback({ type: "session.shutdown", data: { totalNanoAiu: 6_000_000_000 } });
          const content = scenario.output ?? "accounting fixture output";
          callback({ type: "assistant.message", data: { content } });
          if (scenario.waitForAbort) {
            await new Promise((_, reject) => {
              rejectSend = reject;
              void writeFile(join(config.workingDirectory, "accounting-started"), "ready").catch(
                reject,
              );
            });
          }
          if (scenario.mutateProtected) {
            const target = join(config.workingDirectory, "repo/input.txt");
            await chmod(target, 0o644);
            await writeFile(target, "modified protected source");
          }
          settled = true;
          if (scenario.executionError)
            throw Error(scenario.executionError === "empty" ? "" : "fixture execution failed");
          callback({ type: "session.idle", data: {} });
          return { data: { content } };
        }
        if (prompt.startsWith("workspace-selector:")) {
          const request = JSON.parse(prompt.slice("workspace-selector:".length));
          const root = config.workingDirectory;
          const inputPath = join(root, "project/input.txt");
          const readInput = async () => {
            try {
              return await readFile(inputPath, "utf8");
            } catch (error) {
              if (error.code !== "ENOENT") throw error;
              return null;
            }
          };
          const initialInput = await readInput();
          const inputMode = initialInput === null ? null : (await stat(inputPath)).mode & 0o777;
          await writeFile(join(root, `case-${request.id}.txt`), request.id);
          if (request.editSource) await writeFile(inputPath, request.id);
          const barrier = client.options.env.E2E_SELECTOR_BARRIER;
          if (!barrier) throw Error("Workspace selector fixture requires its barrier directory");
          const ready = async () => {
            const pending = join(barrier, `${request.id}.pending`);
            await writeFile(pending, JSON.stringify({ path: root }));
            await rename(pending, join(barrier, `${request.id}.json`));
          };
          if (request.waitForAbort) {
            const { promise, reject } = Promise.withResolvers();
            rejectSend = reject;
            void ready().catch(reject);
            await promise;
          }
          await ready();
          const deadline = Date.now() + 15_000;
          while (
            (await readdir(barrier)).filter((name) => name.endsWith(".json")).length <
            (request.participants ?? 1)
          ) {
            if (Date.now() >= deadline) throw Error("Workspace selector cases did not overlap");
            await delay(10);
          }
          const git = spawnSync("git", ["-C", join(root, "repo"), "rev-parse", "HEAD"], {
            encoding: "utf8",
          });
          const content = JSON.stringify({
            ok: true,
            id: request.id,
            initialInput,
            finalInput: await readInput(),
            inputMode,
            gitCommit: git.status === 0 ? git.stdout.trim() : null,
          });
          await writeFile(join(root, "result.txt"), content);
          callback({ type: "assistant.message", data: { content } });
          callback({ type: "session.idle", data: {} });
          return { data: { content } };
        }
        if (prompt.includes("AGENT_ASSERT_E2E:")) {
          const requests = await Promise.all(
            ["read", "write", "shell", "url", "mcp"].map((kind) =>
              config.onPermissionRequest({
                kind,
                path: join(config.workingDirectory, "result.txt"),
              }),
            ),
          );
          const denied =
            requests.map(({ kind }) => kind).join(",") ===
            "approve-once,reject,reject,reject,reject";
          const result = await readFile(join(config.workingDirectory, "result.txt"), "utf8");
          const input = await readFile(join(config.workingDirectory, "project/input.txt"), "utf8");
          const evidence = JSON.parse(prompt.split("Untrusted evidence (JSON):\n").at(-1));
          const verified =
            denied &&
            prompt.includes(result) &&
            evidence.fileChanges?.changedFiles?.some((file) => file.path === "result.txt") &&
            input === "immutable input\n";
          const content = JSON.stringify({
            components: [
              {
                metric: "workspace-inspected",
                score: verified ? 1 : 0,
                reason:
                  "Copilot fixture inspected the live workspace; write, shell and network requests were denied",
              },
            ],
          });
          callback({
            type: "assistant.usage",
            data: { inputTokens: 13, outputTokens: 5, cost: 0.001 },
          });
          callback({ type: "assistant.message", data: { content } });
          callback({ type: "session.idle", data: {} });
          return { data: { content } };
        }
        if (prompt === "hang") {
          await new Promise(() => {});
        }
        if (prompt.startsWith("auto-skill-review")) {
          const skill = ".agents/skills/cw-sql-schema-migration/SKILL.md";
          if (
            config.enableSkills === true &&
            config.enableConfigDiscovery === false &&
            config.skillDirectories?.includes(join(config.workingDirectory, ".agents/skills"))
          ) {
            const file = resolve(config.workingDirectory, skill);
            const content = (await readFile(file, "utf8"))
              .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
              .trim();
            // Copilot CLI masks secret-shaped prose such as "Bearer authentication".
            const maskFirst = (body, pattern, count) => {
              let masked = 0;
              return body.replace(pattern, (match) => (masked++ < count ? "******" : match));
            };
            const masked = {
              ":masked": (body) => body.replace("Bearer authentication", "******"),
              ":masked-multiline": (body) => body.replace("Bearer authentication;\nKeep", "******"),
              ":masked-altered": (body) =>
                body.replace("Bearer authentication", "******").replace("Keep", "Drop"),
              // Short single-line masks that together hide over 10% of the body.
              ":masked-most": (body) =>
                maskFirst(body, /Review each column before migrating\./g, 12),
              ":masked-long-span": (body) => body.replace("Inventory first. ".repeat(16), "******"),
              // 64 redactions plus the body's literal ****** make 65 masks, one past the limit.
              ":masked-too-many": (body) => maskFirst(body, /^R(?=eview)/gm, 64),
            }[prompt.slice("auto-skill-review".length)];
            invokedSkills.push({
              name: "cw-sql-schema-migration",
              path: file,
              content: prompt.endsWith(":mismatch")
                ? "wrong skill content"
                : masked
                  ? masked(content)
                  : content,
              invokedAtTurn: 1,
            });
            if (prompt.endsWith(":dual")) {
              callback({
                type: "tool.execution_start",
                data: {
                  toolCallId: "separate-read",
                  toolName: "read_file",
                  arguments: { path: skill },
                },
              });
              callback({
                type: "tool.execution_complete",
                data: { toolCallId: "separate-read", success: true },
              });
            }
          }
          callback({ type: "session.idle", data: {} });
          return { data: { content: "reviewed" } };
        }
        if (prompt.startsWith("read:")) {
          const request = JSON.parse(prompt.slice(5));
          if (request.mode !== "text-only") {
            callback({
              type: "tool.execution_start",
              data: {
                toolCallId: "read1",
                toolName: request.toolName ?? "read_file",
                arguments: { [request.argumentKey ?? "path"]: request.path },
                ...(request.mcpServerName ? { mcpServerName: request.mcpServerName } : {}),
              },
            });
            if (request.mode !== "started-only") {
              let success = false;
              if (request.mode !== "failed") {
                try {
                  await readFile(resolve(config.workingDirectory, request.path), "utf8");
                  success = true;
                } catch {
                  // A failed read still emits a completion event.
                }
              }
              callback({
                type: "tool.execution_complete",
                data: { toolCallId: "read1", success },
              });
            }
          }
          const content = request.mode === "text-only" ? "I read SKILL.md" : "read attempted";
          callback({ type: "assistant.message", data: { content } });
          callback({ type: "session.idle", data: {} });
          return { data: { content } };
        }
        callback({
          type: "tool.execution_start",
          data: { toolCallId: "write1", toolName: "write_file", arguments: { path: "result.txt" } },
        });
        await writeFile(join(config.workingDirectory, "result.txt"), prompt);
        callback({
          type: "tool.execution_complete",
          data: { toolCallId: "write1", success: true },
        });
        callback({
          type: "assistant.usage",
          data: { inputTokens: 11, outputTokens: 7, cost: 0.001 },
        });
        const content = JSON.stringify({ task: prompt, ok: true });
        callback({ type: "assistant.message", data: { content } });
        callback({ type: "session.idle", data: {} });
        return { data: { content } };
      },
      async abort() {
        settled = true;
        rejectSend?.(Error("fixture execution aborted"));
      },
      async disconnect() {
        if (unsubscribed && scenario?.disconnectEvents?.length)
          throw Error("Observation detached before disconnect");
        for (const event of scenario?.disconnectEvents ?? []) callback(event);
        disconnected = true;
        // SDK _markDisconnected clears the registered event handlers.
        callback = () => {};
        if (scenario?.cleanupError) throw Error("fixture cleanup failed");
      },
    };
  }
  async stop() {
    if (this.inventoryStopErrors) return [Error("fixture shutdown failed")];
    if (this.sessionCreationFailed)
      await writeFile(join(this.options.workingDirectory, "accounting-stopped"), "stopped");
    return [];
  }
  async forceStop() {}
}
