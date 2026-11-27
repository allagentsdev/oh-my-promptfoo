import { basename } from "node:path";
import { closed, object } from "./config.js";
import {
  type ParsedCommand,
  parseShell,
  type ShellCommandSelector,
  shellMatcher,
} from "./shell-selector.js";
import { type ToolCall, toolInventory } from "./tool-inventory.js";

export type ToolName = string | RegExp | { regex: string; flags?: string };
export interface ToolSelector {
  name?: ToolName;
  mcpServer?: string;
  argumentsMatch?:
    | { path: string; regex: string | RegExp | { regex: string; flags?: string } }
    | { path: string; shell: true; command: ShellCommandSelector; includeConditional?: boolean };
}
export interface ToolAssertionConfig extends ToolSelector {
  before?: ToolSelector;
}
export interface SkillNotLoadedConfig {
  name: ToolName;
}
export interface FileReadConfig {
  filename: string;
}
interface InventoryAssertionContext {
  config?: unknown;
  providerResponse?: { metadata?: unknown };
}
interface Grade {
  pass: boolean;
  score: number;
  reason: string;
  metadata: {
    graderError?: true;
    matchedCallIds?: string[];
    parsedCommands?: (ParsedCommand & { callId: string })[];
  };
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
function selector(
  value: unknown,
  parsedCommands: (ParsedCommand & { callId: string })[],
): (call: ToolCall) => boolean {
  const spec = closed(value, ["name", "mcpServer", "argumentsMatch"], "tool selector");
  const matchesName = spec.name === undefined ? undefined : nameMatcher(spec.name);
  if (spec.mcpServer !== undefined && (typeof spec.mcpServer !== "string" || !spec.mcpServer))
    throw new Error("mcpServer must be a nonempty string");
  let argumentPattern: RegExp | undefined;
  let commandMatcher: ((command: ParsedCommand) => boolean) | undefined;
  let includeConditional = false;
  let path: string[] = [];
  if (spec.argumentsMatch !== undefined) {
    const match = closed(
      spec.argumentsMatch,
      ["path", "regex", "shell", "command", "includeConditional"],
      "argumentsMatch",
    );
    if (typeof match.path !== "string") throw new Error("argumentsMatch.path must be a string");
    path = pathSegments(match.path);
    if (match.shell === true) {
      if (match.regex !== undefined) throw new Error("Shell selectors put regex inside command");
      if (match.includeConditional !== undefined && typeof match.includeConditional !== "boolean")
        throw new Error("includeConditional must be boolean");
      includeConditional = match.includeConditional === true;
      commandMatcher = shellMatcher(match.command);
    } else {
      if (
        match.shell !== undefined ||
        match.command !== undefined ||
        match.includeConditional !== undefined
      )
        throw new Error("Shell selector requires shell: true");
      argumentPattern = regex(match.regex);
    }
  }
  return (call) => {
    if (matchesName && !matchesName(call.name)) return false;
    if (spec.mcpServer !== undefined && call.mcpServer !== spec.mcpServer) return false;
    if (!argumentPattern && !commandMatcher) return true;
    let value = call.arguments;
    for (const part of path) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) {
        if (commandMatcher)
          throw new Error(`Shell command argument path is missing in call ${call.id}`);
        return false;
      }
      // Inventory JSON validation and the own-property guard establish this lookup.
      const record = value as Record<string, unknown>;
      value = record[part];
    }
    if (commandMatcher) {
      if (typeof value !== "string")
        throw new Error(`Shell command argument in call ${call.id} must be a string`);
      const commands = parseShell(value);
      for (const command of commands) parsedCommands.push({ callId: call.id, ...command });
      return commands.some(
        (command) => (includeConditional || !command.conditional) && commandMatcher(command),
      );
    }
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (!argumentPattern) return false;
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
    const parsedCommands: (ParsedCommand & { callId: string })[] = [];
    const matches = selector(spec, parsedCommands);
    let boundary = inventory.calls.length;
    if (before !== undefined) {
      const reference = selector(before, parsedCommands);
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
      metadata: {
        matchedCallIds: matched.map((call) => call.id),
        ...(parsedCommands.length ? { parsedCommands } : {}),
      },
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
const filesystemReadTools = new Set(["view", "read", "read_file"]);
const catReadOption =
  /^(?:-[AbEnstTuv]+|--(?:show-all|number-nonblank|show-ends|number|squeeze-blank|show-tabs|show-nonprinting))$/;

function catReadsFile(args: string[], filename: string): boolean {
  let optionsEnded = false;
  let matched = false;
  for (const arg of args) {
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
    } else if (!optionsEnded && arg.startsWith("-") && arg !== "-") {
      if (!catReadOption.test(arg)) return false;
    } else if (arg !== "-" && basename(arg) === filename) {
      matched = true;
    }
  }
  return matched;
}

function bashReadsFile(command: string, filename: string): boolean {
  let commands: ParsedCommand[];
  try {
    commands = parseShell(command);
  } catch {
    // An unsupported Bash call cannot provide evidence, but another call may.
    return false;
  }
  return commands.some(({ program, args, conditional }, index) => {
    const previous = commands[index - 1];
    // Accept the common `cd dir && cat file` guard, not arbitrary conditional commands.
    const directoryGuard =
      previous?.program === "cd" && !previous.conditional && !command.includes("||");
    return program === "cat" && (!conditional || directoryGuard) && catReadsFile(args, filename);
  });
}

export function fileRead(_output: unknown, context?: InventoryAssertionContext): Grade {
  try {
    const { filename } = closed(context?.config, ["filename"], "file-read config");
    if (
      typeof filename !== "string" ||
      !filename ||
      filename === "." ||
      filename === ".." ||
      basename(filename) !== filename
    ) {
      throw new Error("file-read requires a filename without a directory path");
    }
    const inventory = evidence(context);
    for (const call of inventory.calls) {
      if (call.mcpServer || call.mcpTool || call.success !== true || call.argumentsTruncated)
        continue;
      const args = call.arguments;
      if (!args || typeof args !== "object" || Array.isArray(args)) continue;
      const { path, command } = args as Record<string, unknown>;
      const direct =
        filesystemReadTools.has(call.name) &&
        typeof path === "string" &&
        basename(path) === filename;
      const shell =
        call.name === "bash" && typeof command === "string" && bashReadsFile(command, filename);
      if (!direct && !shell) continue;
      return {
        pass: true,
        score: 1,
        reason: direct
          ? `Read ${filename}`
          : `Successful Bash call contained a cat read of ${filename}`,
        metadata: { matchedCallIds: [call.id] },
      };
    }
    return { pass: false, score: 0, reason: `No successful read of ${filename}`, metadata: {} };
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : String(cause));
  }
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
