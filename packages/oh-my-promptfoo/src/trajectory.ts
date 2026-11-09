import { object } from "./config.js";

// Adapted from Promptfoo's MIT-licensed trajectoryUtils.ts and toolAttributes.ts,
// upstream 67651ef13adb9a3b621335a56bcc3264b7c9b3d1. The summary helper is not a
// public export. Parity is checked through the public native goal-success assertion.
interface Span {
  name: string;
  startTime: number;
  endTime?: number;
  attributes?: Record<string, unknown>;
  statusCode?: number;
  statusMessage?: string;
}
interface Step {
  index: number;
  type: "command" | "tool" | "search" | "reasoning" | "message" | "span";
  name: string;
  spanName?: string;
  status?: { code: number; message?: string };
  collapsedCount?: number;
}
const families = [
  {
    prefix: "tool",
    names: [".name", "_name"],
    args: [".args", ".arguments", ".input", "_args", "_arguments", "_input"],
    extraNames: ["tool"],
  },
  {
    prefix: "function",
    names: [".name", "_name"],
    args: [".args", ".arguments", ".input", "_args", "_arguments"],
  },
  { prefix: "ai.toolCall", names: [".name"], args: [".args", ".arguments", ".input"] },
  {
    prefix: "gen_ai.tool",
    names: [".name"],
    args: [".args", ".arguments", ".input"],
    extraArgs: ["gen_ai.tool.call.args", "gen_ai.tool.call.arguments"],
  },
  {
    prefix: "agent.tool",
    names: ["_name"],
    args: [".args", ".arguments", ".input"],
    extraNames: ["agent.tool", "agent.toolName"],
  },
  {
    prefix: "codex.mcp",
    names: [],
    args: [".args", ".arguments", ".input"],
    extraNames: ["codex.mcp.tool"],
  },
];
const toolNames = families.flatMap((family) => [
  ...family.names.map((suffix) => family.prefix + suffix),
  ...(family.extraNames ?? []),
]);
const toolArgs = [
  ...families.flatMap((family) => [
    ...family.args.map((suffix) => family.prefix + suffix),
    ...(family.extraArgs ?? []),
  ]),
  "args",
  "arguments",
  "input",
];
function firstString(attributes: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = attributes[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
}
function structured(value: unknown): unknown {
  if (typeof value === "string") {
    if (!value.trim()) return undefined;
    try {
      return JSON.parse(value.trim());
    } catch {
      return value.trim();
    }
  }
  if (
    value !== null &&
    (typeof value === "number" || typeof value === "boolean" || typeof value === "object")
  )
    return value;
}
function toolName(span: Span, attributes: Record<string, unknown>) {
  const direct = firstString(attributes, toolNames);
  if (direct) return direct;
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value !== "string" || !value.trim()) continue;
    const trimmed = value.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      const parsed = structured(trimmed);
      if (parsed !== null && typeof parsed === "object") continue;
    }
    if (/tool.?name|function.?name/i.test(key)) return trimmed;
    if (/(^|[._])tool($|[._])/i.test(key) && !/result|output|definition/i.test(key)) return trimmed;
  }
  if (span.name.startsWith("mcp ")) {
    const slash = span.name.lastIndexOf("/");
    if (slash !== -1 && slash < span.name.length - 1) return span.name.slice(slash + 1).trim();
  }
}
function argumentsOf(attributes: Record<string, unknown>) {
  for (const key of toolArgs) {
    const value = structured(attributes[key]);
    if (value !== undefined) return value;
  }
  for (const [key, raw] of Object.entries(attributes)) {
    if (
      /result|output|error|status/i.test(key) ||
      !/(^|[._])(arguments|args|input)($|[._])/i.test(key)
    )
      continue;
    const value = structured(raw);
    if (value !== undefined) return value;
  }
}
function command(span: Span, attributes: Record<string, unknown>, isCommand: boolean) {
  const direct = firstString(attributes, [
    "codex.command",
    "command",
    "command.name",
    "command_name",
  ]);
  if (direct) return direct;
  for (const [key, value] of Object.entries(attributes)) {
    if (
      typeof value === "string" &&
      value.trim() &&
      /command/i.test(key) &&
      !/output|result/i.test(key)
    )
      return value.trim();
  }
  if (isCommand) {
    const args = argumentsOf(attributes);
    if (args && typeof args === "object") {
      const values = args as Record<string, unknown>;
      // Native extraction treats an explicit null as present, rather than falling back.
      const selected =
        values.cmd !== undefined
          ? values.cmd
          : values.command !== undefined
            ? values.command
            : values.commands;
      if (typeof selected === "string" && selected.trim()) return selected.trim();
      if (Array.isArray(selected)) {
        const joined = selected
          .map((part) => String(part).trim())
          .filter(Boolean)
          .join(values.cmd === undefined && values.command === undefined ? "; " : " ");
        if (joined) return joined;
      }
    }
  }
  if (span.name.startsWith("exec ")) return span.name.slice(5).trim();
}
function search(span: Span, attributes: Record<string, unknown>) {
  const direct = firstString(attributes, ["codex.search.query", "search.query", "search_query"]);
  if (direct) return direct;
  const query = firstString(attributes, ["query"]);
  if (
    query &&
    (/(^|[\s._:/-])(search|find|lookup|retriev(?:e|al))($|[\s._:/-])/i.test(span.name) ||
      span.name.startsWith("search ") ||
      Object.keys(attributes).some(
        (key) => key !== "query" && /(^|[._])(search|lookup|retriev(?:e|al))($|[._])/i.test(key),
      ))
  )
    return query;
  if (span.name.startsWith("search ")) return span.name.slice(7).replace(/^"|"$/g, "").trim();
}
function step(span: Span, index: number, commands: Set<string>): Step {
  const attributes = span.attributes ?? {};
  const tool = toolName(span, attributes);
  const isCommand = !!tool && commands.has(tool.trim().toLowerCase());
  const cmd = command(span, attributes, isCommand);
  const query = search(span, attributes);
  let type: Step["type"] = "span",
    name = span.name;
  if (cmd && isCommand) {
    type = "command";
    name = cmd;
  } else if (tool) {
    type = "tool";
    name = tool;
  } else if (cmd) {
    type = "command";
    name = cmd;
  } else if (query) {
    type = "search";
    name = query;
  } else if (
    attributes["codex.item.type"] === "reasoning" ||
    /^reasoning([_\s]|$)/i.test(span.name)
  )
    type = "reasoning";
  else if (
    attributes["codex.item.type"] === "agent_message" ||
    span.name === "agent response" ||
    span.name === "send input"
  )
    type = "message";
  return {
    index: index + 1,
    type,
    name,
    ...(span.name === name ? {} : { spanName: span.name }),
    ...(span.statusCode === undefined || span.statusCode === 0
      ? {}
      : {
          status: {
            code: span.statusCode,
            ...(span.statusMessage ? { message: span.statusMessage } : {}),
          },
        }),
  };
}

/** Native-style judge summary, without relying on private Promptfoo package imports. */
export function summarizeTrajectory(input: unknown): string {
  const trace = object(input, "llmAssert trajectory trace");
  if (
    typeof trace.traceId !== "string" ||
    !trace.traceId.trim() ||
    !Array.isArray(trace.spans) ||
    trace.spans.length === 0
  )
    throw new Error(
      "llmAssert mode: trajectory requires a nonempty row trace; enable tracing.enabled",
    );
  const spans = trace.spans.map((value) => {
    const span = object(value, "trajectory span");
    if (
      typeof span.name !== "string" ||
      !Number.isFinite(span.startTime) ||
      (span.endTime !== undefined && !Number.isFinite(span.endTime)) ||
      (span.statusCode !== undefined && !Number.isFinite(span.statusCode)) ||
      (span.statusMessage !== undefined && typeof span.statusMessage !== "string")
    )
      throw new Error("Malformed trajectory span name, timing or status");
    if (span.attributes !== undefined) object(span.attributes, "trajectory span attributes");
    return span as unknown as Span;
  });
  const metadata =
    trace.metadata === undefined ? {} : object(trace.metadata, "trajectory metadata");
  const commands = new Set(["exec_command", "local_shell", "shell"]);
  if (Array.isArray(metadata.commandToolNames)) {
    for (const name of metadata.commandToolNames)
      if (typeof name === "string" && name.trim()) commands.add(name.trim().toLowerCase());
  }
  spans.sort(
    (a, b) => a.startTime - b.startTime || (a.endTime ?? a.startTime) - (b.endTime ?? b.startTime),
  );
  const compacted: Step[] = [];
  for (const [index, span] of spans.entries()) {
    const current = step(span, index, commands),
      previous = compacted.at(-1);
    if (
      previous &&
      previous.type === current.type &&
      previous.name === current.name &&
      previous.spanName === current.spanName &&
      previous.status?.code === current.status?.code &&
      previous.status?.message === current.status?.message
    )
      previous.collapsedCount = (previous.collapsedCount ?? 1) + 1;
    else compacted.push(current);
  }
  return JSON.stringify(
    {
      traceId: trace.traceId,
      stepCount: spans.length,
      compactedStepCount: compacted.length,
      steps:
        compacted.length <= 24
          ? compacted
          : [
              ...compacted.slice(0, 12),
              { omittedCount: compacted.length - 24 },
              ...compacted.slice(-12),
            ],
    },
    null,
    2,
  );
}
