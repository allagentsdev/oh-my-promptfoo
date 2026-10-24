import { closed, object } from "./config.js";
import { type ToolCall, toolInventory } from "./tool-inventory.js";

export type ToolName = string | RegExp | { regex: string; flags?: string };
export interface ToolSelector {
  name?: ToolName;
  mcpServer?: string;
  argumentsMatch?: { path: string; regex: string | RegExp | { regex: string; flags?: string } };
}
export interface ToolAssertionConfig extends ToolSelector {
  before?: ToolSelector;
}
export interface SkillNotLoadedConfig {
  name: ToolName;
}
interface InventoryAssertionContext {
  config?: unknown;
  providerResponse?: { metadata?: unknown };
}
interface Grade {
  pass: boolean;
  score: number;
  reason: string;
  metadata: { graderError?: true; matchedCallIds?: string[] };
}
function error(reason: string): Grade {
  return { pass: false, score: 0, reason, metadata: { graderError: true } };
}
function regex(value: unknown): RegExp {
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (typeof value === "string") return new RegExp(value);
  const spec = closed(value, ["regex", "flags"], "regex selector");
  if (
    typeof spec.regex !== "string" ||
    (spec.flags !== undefined && typeof spec.flags !== "string")
  )
    throw new Error("A regex selector requires a string regex and optional flags");
  return new RegExp(spec.regex, spec.flags as string | undefined);
}
function nameMatcher(value: unknown): (name: string) => boolean {
  if (typeof value === "string") return (name) => name === value;
  const pattern = regex(value);
  return (name) => {
    pattern.lastIndex = 0;
    return pattern.test(name);
  };
}
function pathSegments(path: string): string[] {
  if (path === "" || path === "$") return [];
  if (path.startsWith("/")) {
    if (/~(?![01])/.test(path))
      throw new Error("Invalid JSON Pointer escape in argumentsMatch.path");
    return path
      .slice(1)
      .split("/")
      .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  }
  const parts = path.replace(/^\$\./, "").split(".");
  if (parts.some((part) => !part))
    throw new Error("argumentsMatch.path requires JSON Pointer or dotted property names");
  return parts;
}
function selector(value: unknown): (call: ToolCall) => boolean {
  const spec = closed(value, ["name", "mcpServer", "argumentsMatch"], "tool selector");
  const matchesName = spec.name === undefined ? undefined : nameMatcher(spec.name);
  if (spec.mcpServer !== undefined && (typeof spec.mcpServer !== "string" || !spec.mcpServer))
    throw new Error("mcpServer must be a nonempty string");
  let argumentPattern: RegExp | undefined;
  let path: string[] = [];
  if (spec.argumentsMatch !== undefined) {
    const match = closed(spec.argumentsMatch, ["path", "regex"], "argumentsMatch");
    if (typeof match.path !== "string") throw new Error("argumentsMatch.path must be a string");
    path = pathSegments(match.path);
    argumentPattern = regex(match.regex);
  }
  return (call) => {
    if (matchesName && !matchesName(call.name)) return false;
    if (spec.mcpServer !== undefined && call.mcpServer !== spec.mcpServer) return false;
    if (!argumentPattern) return true;
    let value = call.arguments;
    for (const part of path) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return false;
      // Inventory JSON validation and the own-property guard establish this lookup.
      const record = value as Record<string, unknown>;
      value = record[part];
    }
    const text = typeof value === "string" ? value : JSON.stringify(value);
    argumentPattern.lastIndex = 0;
    return typeof text === "string" && argumentPattern.test(text);
  };
}
function evidence(context?: InventoryAssertionContext) {
  const metadata = object(context?.providerResponse?.metadata, "providerResponse.metadata");
  const inventory = toolInventory(metadata.toolInventory);
  if (inventory.status !== "complete")
    throw new Error(`Tool inventory is incomplete: ${inventory.incompleteReasons.join(", ")}`);
  return inventory;
}
function toolAssertion(wanted: boolean, context?: InventoryAssertionContext): Grade {
  try {
    const inventory = evidence(context);
    const config = closed(
      context?.config ?? {},
      ["name", "mcpServer", "argumentsMatch", "before"],
      "tool assertion config",
    );
    const { before, ...spec } = config;
    const matches = selector(spec);
    let boundary = inventory.calls.length;
    if (before !== undefined) {
      const reference = selector(before);
      boundary = inventory.calls.findIndex(reference);
      if (boundary < 0)
        return error(
          "The before selector has no observed invocation; chronology cannot be evaluated",
        );
    }
    // SDK callbacks define a total start-event order, including concurrent and same-time calls.
    const matched = inventory.calls.slice(0, boundary).filter(matches);
    const pass = wanted ? matched.length > 0 : matched.length === 0;
    return {
      pass,
      score: pass ? 1 : 0,
      reason: `${matched.length} matching tool invocation(s)${before === undefined ? "" : " before the first reference invocation"}`,
      metadata: { matchedCallIds: matched.map((call) => call.id) },
    };
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : String(cause));
  }
}
export function toolCalled(_output: unknown, context?: InventoryAssertionContext): Grade {
  return toolAssertion(true, context);
}
export function toolNotCalled(_output: unknown, context?: InventoryAssertionContext): Grade {
  return toolAssertion(false, context);
}
export function skillNotLoaded(_output: unknown, context?: InventoryAssertionContext): Grade {
  try {
    const inventory = evidence(context);
    if (inventory.skillInventory !== "sdk")
      return error("Skill absence requires an authoritative SDK skill inventory");
    const config = closed(context?.config, ["name"], "skill-not-loaded config");
    if (config.name === undefined) throw new Error("skill-not-loaded requires config.name");
    const matches = nameMatcher(config.name);
    const found = inventory.loadedSkills.filter(matches);
    const pass = found.length === 0;
    return {
      pass,
      score: pass ? 1 : 0,
      reason: `${found.length} matching SDK-loaded skill(s)`,
      metadata: {},
    };
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : String(cause));
  }
}
