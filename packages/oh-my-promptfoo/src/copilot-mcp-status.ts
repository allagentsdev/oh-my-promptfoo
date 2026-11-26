import type { JsonObject } from "./config.js";

function record(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function startupCause(detail: unknown): string | undefined {
  if (typeof detail !== "string") return;
  // SDK errors can include arbitrary server stderr: paths, environment values and
  // credentials with no known redaction pattern. Only emit fixed diagnostic labels.
  const head = detail.slice(0, 8192);
  const tail = detail.length > 8192 ? detail.slice(-8192) : "";
  for (const [pattern, label] of [
    [
      /\b(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find (?:module|package))\b/,
      "missing module",
    ],
    [/\bERR_REQUIRE_ESM\b|\bSyntaxError\b/, "module format or syntax error"],
    [/\bENOENT\b/, "file or executable not found"],
    [/\b(?:EACCES|EPERM)\b/, "permission denied"],
    [/\b(?:ETIMEDOUT|timed out|timeout)\b/i, "connection timed out"],
  ] as const) {
    if (pattern.test(head) || pattern.test(tail)) return label;
  }
}

export class CopilotMcpStatus {
  private readonly configured: Set<string>;
  private readonly failed = new Map<string, string | undefined>();

  constructor(servers: readonly { name: string }[]) {
    this.configured = new Set(servers.map(({ name }) => name));
  }

  observe(name: unknown, status: unknown, detail: unknown): void {
    if (typeof name !== "string" || !this.configured.has(name)) return;
    if (status === "failed") this.failed.set(name, startupCause(detail) ?? this.failed.get(name));
    else if (status === "connected") this.failed.delete(name);
  }

  async refresh(
    readStatus: () => Promise<unknown> | undefined,
    deadlineMs: number | undefined,
  ): Promise<void> {
    if (!this.configured.size) return;
    const budget = Math.min(500, (deadlineMs ?? Infinity) - Date.now() - 50);
    if (budget <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = readStatus();
      if (!request) return;
      const result = await Promise.race([
        request,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, budget);
        }),
      ]);
      const servers = record(result)?.servers;
      if (Array.isArray(servers))
        for (const row of servers.slice(0, 1024)) {
          const entry = record(row);
          const live = record(entry?.live);
          this.observe(entry?.name, live?.status, live?.error);
        }
    } catch {
      // Older or unhealthy peers may not answer. Keep the observed events.
    } finally {
      clearTimeout(timer);
    }
  }

  error(): string | undefined {
    if (!this.failed.size) return;
    const failures: string[] = [];
    for (const [name, cause] of this.failed) {
      if (failures.length === 5) break;
      failures.push(`MCP server "${name}" failed to start${cause ? `: ${cause}` : ""}`);
    }
    const omitted = this.failed.size - failures.length;
    return `Copilot ${failures.join("; ")}${omitted ? ` (and ${omitted} more)` : ""}. Check the configured MCP script and its startup stderr locally.`;
  }
}
