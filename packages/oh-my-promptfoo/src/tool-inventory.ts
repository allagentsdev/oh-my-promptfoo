import { closed, type JsonObject, object } from "./config.js";
import { jsonSafe, redact } from "./protocol.js";

export const MAX_TOOL_CALLS = 1024;
export const MAX_TOOL_ARGUMENT_BYTES = 8192;
export const MAX_TOOL_INVENTORY_BYTES = 4 * 1024 * 1024;
const MAX_NAME = 512;

export interface ToolCall {
  id: string;
  name: string;
  mcpServer?: string;
  mcpTool?: string;
  arguments: unknown;
  argumentsTruncated: boolean;
  startedAt: string | null;
  endedAt: string | null;
  success: boolean | null;
}
export interface ToolInventory {
  schemaVersion: 1;
  status: "complete" | "incomplete";
  incompleteReasons: string[];
  calls: ToolCall[];
  skillInventory: "sdk" | "read-tool-only" | "failed";
  /** Complete SDK-reported invocation names, not the filtered legacy skillCalls evidence. */
  loadedSkills: string[];
}

function name(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_NAME;
}
function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 40 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

/** Validate durable evidence at the adapter/host and public assertion boundaries. */
export function toolInventory(value: unknown): ToolInventory {
  const inventory = closed(
    value,
    ["schemaVersion", "status", "incompleteReasons", "calls", "skillInventory", "loadedSkills"],
    "toolInventory",
  );
  if (
    inventory.schemaVersion !== 1 ||
    !["complete", "incomplete"].includes(inventory.status as string)
  )
    throw new Error("Unsupported toolInventory schema or status");
  if (
    !Array.isArray(inventory.incompleteReasons) ||
    inventory.incompleteReasons.length > 32 ||
    inventory.incompleteReasons.some((reason) => !name(reason))
  )
    throw new Error("Malformed toolInventory incompleteReasons");
  if (!["sdk", "read-tool-only", "failed"].includes(inventory.skillInventory as string))
    throw new Error("Malformed toolInventory skillInventory");
  if (
    !Array.isArray(inventory.loadedSkills) ||
    inventory.loadedSkills.length > MAX_TOOL_CALLS ||
    inventory.loadedSkills.some((skill) => !name(skill)) ||
    new Set(inventory.loadedSkills).size !== inventory.loadedSkills.length
  )
    throw new Error("Malformed toolInventory loadedSkills");
  if (inventory.skillInventory !== "sdk" && inventory.loadedSkills.length)
    throw new Error("Non-SDK inventory cannot certify loadedSkills");
  if (!Array.isArray(inventory.calls) || inventory.calls.length > MAX_TOOL_CALLS)
    throw new Error("Malformed toolInventory calls");
  const ids = new Set<string>();
  for (const entry of inventory.calls) {
    const call = closed(
      entry,
      [
        "id",
        "name",
        "mcpServer",
        "mcpTool",
        "arguments",
        "argumentsTruncated",
        "startedAt",
        "endedAt",
        "success",
      ],
      "toolInventory call",
    );
    if (
      !name(call.id) ||
      !name(call.name) ||
      ids.has(call.id) ||
      (call.mcpServer !== undefined && !name(call.mcpServer)) ||
      (call.mcpTool !== undefined && !name(call.mcpTool))
    )
      throw new Error("Malformed or duplicate toolInventory call identity");
    ids.add(call.id);
    if (
      !Object.hasOwn(call, "arguments") ||
      typeof call.argumentsTruncated !== "boolean" ||
      (call.startedAt !== null && !timestamp(call.startedAt)) ||
      (call.endedAt !== null && !timestamp(call.endedAt)) ||
      (call.success !== null && typeof call.success !== "boolean")
    )
      throw new Error("Malformed toolInventory call evidence");
    jsonSafe(call.arguments, MAX_TOOL_ARGUMENT_BYTES);
    if (
      call.startedAt !== null &&
      call.endedAt !== null &&
      Date.parse(call.endedAt as string) < Date.parse(call.startedAt as string)
    )
      throw new Error("Tool completion precedes its start");
    if (
      inventory.status === "complete" &&
      (call.argumentsTruncated ||
        call.startedAt === null ||
        call.endedAt === null ||
        call.success === null)
    )
      throw new Error("Incomplete call in complete toolInventory");
  }
  if (
    inventory.status === "complete"
      ? inventory.incompleteReasons.length !== 0 || inventory.skillInventory !== "sdk"
      : inventory.incompleteReasons.length === 0
  )
    throw new Error("Contradictory toolInventory completeness certificate");
  jsonSafe(inventory, MAX_TOOL_INVENTORY_BYTES);
  return inventory as unknown as ToolInventory;
}

/** Bounded collector of invocations, including unsuccessful and unfinished attempts. */
export class ToolInventoryBuilder {
  private readonly calls = new Map<string, ToolCall>();
  private readonly completed = new Set<string>();
  private readonly reasons = new Set<string>();
  private bytes = 0;
  private skills: string[] = [];
  private skillStatus: ToolInventory["skillInventory"] = "read-tool-only";
  constructor(private readonly sensitive: string[]) {}
  incomplete(reason: string): void {
    this.reasons.add(reason);
  }
  has(id: string): boolean {
    return this.calls.has(id);
  }
  start(
    id: unknown,
    toolName: unknown,
    args: unknown,
    startedAt: unknown = new Date().toISOString(),
    mcpServer?: unknown,
    mcpTool?: unknown,
  ): ToolCall | undefined {
    if (
      !name(id) ||
      !name(toolName) ||
      (mcpServer !== undefined && !name(mcpServer)) ||
      (mcpTool !== undefined && !name(mcpTool))
    ) {
      this.incomplete("malformed-tool-event");
      return;
    }
    for (const value of [id, toolName, mcpServer, mcpTool])
      if (typeof value === "string" && redact(value, this.sensitive) !== value)
        this.incomplete("tool-evidence-redacted");
    if (this.calls.has(id)) {
      this.incomplete("duplicate-tool-identity");
      return;
    }
    if (this.calls.size >= MAX_TOOL_CALLS) {
      this.incomplete("tool-call-limit");
      return;
    }
    let argumentsValue: unknown = null;
    let argumentsTruncated = false;
    if (args === undefined) this.incomplete("missing-tool-arguments");
    try {
      const source = jsonSafe(args === undefined ? null : args);
      const encoded = redact(source, this.sensitive);
      if (encoded !== source) this.incomplete("tool-evidence-redacted");
      if (Buffer.byteLength(encoded) > MAX_TOOL_ARGUMENT_BYTES) {
        argumentsValue = {
          preview: Buffer.from(encoded.slice(0, MAX_TOOL_ARGUMENT_BYTES))
            .subarray(0, (MAX_TOOL_ARGUMENT_BYTES - 64) / 2)
            .toString("utf8"),
        };
        argumentsTruncated = true;
      } else argumentsValue = JSON.parse(encoded);
    } catch {
      argumentsTruncated = true;
      this.incomplete("tool-arguments-unserializable");
    }
    if (argumentsTruncated) this.incomplete("tool-arguments-truncated");
    if (startedAt !== null && !timestamp(startedAt)) {
      this.incomplete("malformed-tool-timestamp");
      startedAt = null;
    }
    const call: ToolCall = {
      id: redact(id, this.sensitive),
      name: redact(toolName, this.sensitive),
      ...(mcpServer === undefined
        ? {}
        : { mcpServer: redact(mcpServer as string, this.sensitive) }),
      ...(mcpTool === undefined ? {} : { mcpTool: redact(mcpTool as string, this.sensitive) }),
      arguments: argumentsValue,
      argumentsTruncated,
      startedAt: startedAt as string | null,
      endedAt: null,
      success: null,
    };
    const bytes = Buffer.byteLength(jsonSafe(call)) + 128;
    // Leave room for the bounded skill list, reasons and enclosing response fields.
    if (this.bytes + bytes > MAX_TOOL_INVENTORY_BYTES - 1024 * 1024) {
      this.incomplete("tool-inventory-byte-limit");
      return;
    }
    this.bytes += bytes;
    this.calls.set(id, call);
    return call;
  }
  end(id: unknown, success: unknown, endedAt: unknown = new Date().toISOString()): void {
    const call = typeof id === "string" ? this.calls.get(id) : undefined;
    if (!call || typeof id !== "string" || this.completed.has(id)) {
      this.incomplete("unmatched-tool-completion");
      return;
    }
    this.completed.add(id);
    if (typeof success !== "boolean") this.incomplete("missing-tool-success");
    else call.success = success;
    if (endedAt !== null && !timestamp(endedAt)) {
      this.incomplete("malformed-tool-timestamp");
      endedAt = null;
    }
    if (
      call.startedAt &&
      typeof endedAt === "string" &&
      Date.parse(endedAt) < Date.parse(call.startedAt)
    ) {
      this.incomplete("tool-timestamp-order");
      endedAt = null;
    }
    call.endedAt = endedAt as string | null;
  }
  sdkSkills(entries: unknown): void {
    if (!Array.isArray(entries) || entries.length > MAX_TOOL_CALLS)
      throw new Error("Malformed SDK skill inventory");
    const names = entries.map((entry) => object(entry, "SDK invoked skill").name);
    if (names.some((entry) => !name(entry))) throw new Error("Malformed SDK invoked skill name");
    const redacted = [
      ...new Set((names as string[]).map((entry) => redact(entry, this.sensitive))),
    ];
    if (redacted.some((entry) => !name(entry))) throw new Error("Unbounded SDK invoked skill name");
    if ((names as string[]).some((entry) => redact(entry, this.sensitive) !== entry))
      this.incomplete("skill-evidence-redacted");
    jsonSafe(redacted, 768 * 1024);
    this.skills = redacted;
    this.skillStatus = "sdk";
  }
  skillFailure(): void {
    this.skillStatus = "failed";
    this.skills = [];
    this.incomplete("sdk-skill-inventory-failed");
  }
  finish(): ToolInventory {
    if (this.skillStatus !== "sdk") this.incomplete("sdk-skill-inventory-unavailable");
    for (const [id, call] of this.calls) {
      if (!call.startedAt) this.incomplete("missing-tool-start-timestamp");
      if (!this.completed.has(id) || call.success === null)
        this.incomplete("missing-tool-completion");
      else if (!call.endedAt) this.incomplete("missing-tool-end-timestamp");
    }
    return toolInventory({
      schemaVersion: 1,
      status: this.reasons.size ? "incomplete" : "complete",
      incompleteReasons: [...this.reasons],
      calls: [...this.calls.values()],
      skillInventory: this.skillStatus,
      loadedSkills: this.skills,
    });
  }
}

// Private process-local provenance, never serialized and never inferred from metadata shape.
const hostResponses = new WeakSet<object>();
export function attachToolInventory(response: JsonObject, inventory: unknown): JsonObject {
  const metadata =
    response.metadata === undefined ? {} : object(response.metadata, "delegate metadata");
  if (Object.hasOwn(metadata, "toolInventory"))
    throw new Error("Delegate metadata owns reserved toolInventory key");
  const result = {
    ...response,
    metadata: { ...metadata, toolInventory: toolInventory(inventory) },
  };
  hostResponses.add(result);
  return result;
}
export function hasHostToolInventory(response: object): boolean {
  return hostResponses.has(response);
}
