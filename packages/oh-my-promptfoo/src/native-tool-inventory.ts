import type { JsonObject } from "./config.js";
import { MAX_TOOL_CALLS, type ToolInventory, ToolInventoryBuilder } from "./tool-inventory.js";

interface NativeSpan {
  name: string;
  attributes: Record<string, unknown>;
  startTime: [number, number];
  endTime?: [number, number];
  status: { code: number };
  spanContext(): { spanId: string };
}
const CODEX_TOOLS = new Set([
  "command_execution",
  "file_change",
  "web_search",
  "mcp_tool_call",
  "collaboration_tool_call",
  "spawn_agent",
  "send_input",
  "agent_wait",
  "todo_list",
]);
function time(value: [number, number]): string {
  return new Date(value[0] * 1000 + value[1] / 1e6).toISOString();
}
function decoded(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function isToolSpan(attrs: Record<string, unknown>): boolean {
  const type = attrs["codex.item.type"];
  const codexTool = typeof type === "string" && CODEX_TOOLS.has(type);
  const operation = attrs["gen_ai.operation.name"];
  if (typeof operation === "string" && operation !== "execute_tool" && !codexTool) return false;
  return (
    codexTool ||
    typeof attrs["gen_ai.tool.name"] === "string" ||
    typeof attrs["tool.name"] === "string"
  );
}

/** Native trace evidence is useful observation, never a full-stream certificate. */
export class NativeToolInventory {
  private readonly builder: ToolInventoryBuilder;
  private readonly pending = new Map<string, NativeSpan>();
  private summaryId = 0;
  constructor(sensitive: string[]) {
    this.builder = new ToolInventoryBuilder(sensitive);
    this.builder.incomplete("delegate-does-not-expose-tool-stream");
  }
  span(span: NativeSpan, ended: boolean): void {
    const id = span.spanContext().spanId;
    if (!ended) {
      if (!isToolSpan(span.attributes)) return;
      if (this.pending.size < MAX_TOOL_CALLS) this.pending.set(id, span);
      else this.builder.incomplete("tool-call-limit");
      return;
    }
    this.pending.delete(id);
    this.record(span, true);
  }
  private record(span: NativeSpan, ended: boolean): void {
    const attrs = span.attributes;
    const toolName = attrs["gen_ai.tool.name"] ?? attrs["tool.name"];
    if (!isToolSpan(attrs)) return;
    const id = String(
      attrs["gen_ai.tool.call.id"] ??
        attrs["codex.item.id"] ??
        `native:${span.spanContext().spanId}`,
    );
    let args =
      attrs["gen_ai.tool.call.arguments"] ??
      attrs["tool.arguments"] ??
      attrs["tool.input"] ??
      attrs["codex.mcp.input"];
    if (args === undefined && attrs["codex.command"] !== undefined)
      args = { command: attrs["codex.command"] };
    if (args === undefined && attrs["codex.search.query"] !== undefined)
      args = { query: attrs["codex.search.query"] };
    if (!this.builder.has(id)) {
      const call = this.builder.start(
        id,
        toolName ?? span.name,
        decoded(args),
        time(span.startTime),
        attrs["gen_ai.tool.mcp.server"] ?? attrs["codex.mcp.server"],
        attrs["gen_ai.tool.mcp.tool"] ?? attrs["codex.mcp.tool"],
      );
      if (
        call &&
        typeof args === "string" &&
        /\[truncated\]|<unserializable>|\[copilot:elided/.test(args)
      ) {
        call.argumentsTruncated = true;
        this.builder.incomplete("native-tool-arguments-truncated");
      }
    }
    if (ended && attrs["tool.incomplete"] !== true) {
      let success: boolean | null = null;
      if (typeof attrs["tool.is_error"] === "boolean") success = !attrs["tool.is_error"];
      else if (span.status.code === 1) success = true;
      else if (span.status.code === 2) success = false;
      this.builder.end(id, success, span.endTime ? time(span.endTime) : null);
    }
  }
  private identity(id: unknown, source: string): string {
    if (typeof id === "string" && id) return id;
    this.builder.incomplete("native-tool-identity-unavailable");
    return `native-summary:${source}:${++this.summaryId}`;
  }
  response(response: JsonObject): void {
    for (const span of this.pending.values()) this.record(span, false);
    this.pending.clear();
    const metadata = response.metadata;
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
      if (Object.hasOwn(metadata, "toolInventory"))
        throw new Error("Delegate metadata owns reserved toolInventory key");
      const calls = "toolCalls" in metadata ? metadata.toolCalls : undefined;
      if (Array.isArray(calls))
        for (const call of calls) {
          if (!call || typeof call !== "object" || Array.isArray(call)) {
            this.builder.incomplete("malformed-native-tool-call");
            continue;
          }
          const entry = call as JsonObject;
          const id = this.identity(entry.id, "claude");
          if (this.builder.has(id)) continue;
          this.builder.start(id, entry.name, entry.input, null);
          // A retained result proves observation, but peer summaries do not carry event timestamps.
          if (entry.output !== undefined && entry.output !== null)
            this.builder.end(
              id,
              typeof entry.is_error === "boolean" ? !entry.is_error : null,
              null,
            );
        }
    }
    let raw = response.raw;
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
      } catch {
        return;
      }
    }
    const items =
      raw && typeof raw === "object" && !Array.isArray(raw) && "items" in raw
        ? raw.items
        : undefined;
    if (Array.isArray(items))
      for (const item of items) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const entry = item as JsonObject;
        if (typeof entry.type !== "string" || !CODEX_TOOLS.has(entry.type)) continue;
        const id = this.identity(entry.id, "codex");
        if (this.builder.has(id)) continue;
        const args =
          entry.type === "command_execution"
            ? { command: entry.command ?? null }
            : (entry.arguments ??
              entry.args ??
              entry.input ??
              (entry.query === undefined ? null : { query: entry.query }));
        this.builder.start(
          id,
          entry.tool ?? entry.type,
          decoded(args),
          null,
          entry.server,
          entry.server === undefined ? undefined : entry.tool,
        );
        if (entry.status === "failed" || (entry.error !== undefined && entry.error !== null))
          this.builder.end(id, false, null);
        else if (entry.status === "completed") {
          let success: boolean | null = true;
          if (entry.type === "command_execution")
            success = typeof entry.exit_code === "number" ? entry.exit_code === 0 : null;
          this.builder.end(id, success, null);
        }
      }
  }
  finish(): ToolInventory {
    for (const span of this.pending.values()) this.record(span, false);
    this.pending.clear();
    const inventory = this.builder.finish();
    inventory.calls.sort((a, b) =>
      a.startedAt && b.startedAt ? Date.parse(a.startedAt) - Date.parse(b.startedAt) : 0,
    );
    return inventory;
  }
}
