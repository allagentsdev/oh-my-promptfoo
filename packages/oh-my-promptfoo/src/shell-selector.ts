import { closed } from "./config.js";
export interface ParsedCommand {
  program: string;
  args: string[];
  conditional: boolean;
}
export interface ShellCommandSelector {
  program?: string | { regex: string; flags?: string };
  args?: (string | { regex: string; flags?: string })[];
  regex?: string | { regex: string; flags?: string };
}
type WordToken = { word: string; assignment: boolean };
type Token = WordToken | { op: string };
function tokens(source: string): Token[] {
  const result: Token[] = [];
  let word = "",
    active = false,
    quote = "",
    unquoted = true,
    assignment = false;
  const flush = () => {
    if (active) result.push({ word, assignment });
    word = "";
    active = false;
    unquoted = true;
    assignment = false;
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote === "'") {
      if (c === "'") quote = "";
      else word += c;
      continue;
    }
    if (c === "\\") {
      const next = source[++i];
      if (next === undefined) throw new Error("Unfinished shell escape");
      if (next !== "\n") {
        unquoted = false;
        if (quote === '"' && !["$", "`", '"', "\\"].includes(next)) word += "\\";
        word += next;
        active = true;
      }
      continue;
    }
    if (c === "$" || c === "`")
      throw new Error("Shell expansion/substitution is not statically observable");
    if (quote === '"') {
      if (c === '"') quote = "";
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      unquoted = false;
      active = true;
      continue;
    }
    if (c === "#" && !active) {
      while (i < source.length && source[i] !== "\n") i++;
      flush();
      result.push({ op: ";" });
      continue;
    }
    if ("(){}".includes(c)) throw new Error("Shell groups and substitutions are not supported");
    if (c === "\n" || c === ";" || c === "|" || c === "&" || c === ">" || c === "<") {
      let op: string = c === "\n" ? ";" : c;
      if (source[i + 1] === c && ["|", "&", ">", "<"].includes(c)) {
        op += c;
        i++;
      }
      if (op === "&" || op === "<<" || (source[i + 1] === "&" && (op === ">" || op === "<")))
        throw new Error(
          "Background commands, heredocs and descriptor duplication are not supported",
        );
      // Only an entirely unquoted, unescaped decimal word is a descriptor.
      if ((op === ">" || op === ">>" || op === "<") && unquoted && /^\d+$/.test(word)) {
        word = "";
        active = false;
      }
      flush();
      result.push({ op });
      continue;
    }
    if (/\s/.test(c)) {
      flush();
      continue;
    }
    if ("*?[~".includes(c))
      throw new Error("Shell glob and tilde expansion are not statically observable");
    // Assignment syntax is decided at the unquoted equals sign, before quote removal.
    // Quotes and escapes in the value do not change an already recognized assignment.
    if (c === "=" && unquoted && /^[A-Za-z_][A-Za-z0-9_]*$/.test(word)) assignment = true;
    active = true;
    word += c;
  }
  if (quote) throw new Error("Unterminated shell quote");
  flush();
  return result;
}
const reserved =
  /^(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|function|!|select|time|coproc)$/;
const executionBuiltins = /^(?:eval|source|\.|builtin|trap|alias|unalias|enable|hash|bind|fc)$/;
/**
 * Static simple-command subset, not a shell interpreter. Supports quotes/escapes,
 * leading assignments, > / >> / < redirects, pipes/lists, command [-p] [--] and
 * exec [--]. Expansions, control groups, backgrounding, heredocs, descriptor
 * duplication and unmodeled execution/resolution-changing builtins fail closed.
 * External wrappers, interpreters and scripts are not recursively interpreted.
 */
export function parseShell(source: string): ParsedCommand[] {
  if (source.includes("\0")) throw new Error("NUL in shell command");
  const commands: ParsedCommand[] = [];
  let words: WordToken[] = [],
    conditional = false,
    requiresCommand = false;
  const flush = () => {
    let offset = 0;
    while (words[offset]?.assignment) offset++;
    const hadCommand = offset < words.length;
    if (hadCommand) {
      if (reserved.test(words[offset].word))
        throw new Error(`Unsupported shell control syntax: ${words[offset].word}`);
      let external = false;
      while (words[offset].word === "command" || words[offset].word === "exec") {
        const builtin = words[offset++].word;
        if (builtin === "command" && words[offset]?.word === "-p") offset++;
        if (words[offset]?.word === "--") offset++;
        else if (words[offset]?.word.startsWith("-"))
          throw new Error(`Unsupported ${builtin} builtin options`);
        if (!words[offset]) throw new Error(`${builtin} builtin requires an executable`);
        // exec replaces the shell with an external executable; it cannot invoke
        // another shell builtin. Neither wrapper operand is an assignment prefix.
        if (builtin === "exec") {
          external = true;
          break;
        }
      }
      const program = words[offset].word;
      if (!external && executionBuiltins.test(program))
        throw new Error(`Unsupported shell execution builtin: ${program}`);
      commands.push({
        program: program.split("/").at(-1) ?? program,
        args: words.slice(offset + 1).map((token) => token.word),
        conditional,
      });
    }
    words = [];
    return hadCommand;
  };
  const input = tokens(source);
  for (let i = 0; i < input.length; i++) {
    const token = input[i];
    if ("word" in token) {
      words.push(token);
      requiresCommand = false;
      continue;
    }
    if ([">", ">>", "<"].includes(token.op)) {
      if (!input[i + 1] || !("word" in input[i + 1]))
        throw new Error("Shell redirection requires a target");
      i++;
      continue;
    }
    const hadCommand = flush();
    if (token.op !== ";" && !hadCommand) throw new Error("Shell operator requires a command");
    if (token.op === ";") {
      if (requiresCommand) throw new Error("Shell operator requires a following command");
      conditional = false;
    } else {
      if (token.op === "&&" || token.op === "||") conditional = true;
      requiresCommand = true;
    }
  }
  flush();
  if (requiresCommand) throw new Error("Shell operator requires a following command");
  return commands;
}
function matcher(value: unknown, literal: boolean): (text: string) => boolean {
  if (typeof value === "string" && literal) return (text) => text === value;
  const spec =
    typeof value === "string" ? { regex: value } : closed(value, ["regex", "flags"], "shell regex");
  if (
    typeof spec.regex !== "string" ||
    (spec.flags !== undefined && typeof spec.flags !== "string")
  )
    throw new Error("Shell regex requires a string pattern and optional flags");
  const regex = new RegExp(spec.regex, spec.flags as string | undefined);
  return (text) => {
    regex.lastIndex = 0;
    return regex.test(text);
  };
}
function normalize(args: string[]): string[] {
  return args.flatMap((arg) => {
    const framework = /^(?:--framework|-f|-p:TargetFramework)(?:=(.*))?$/.exec(arg);
    if (framework)
      return framework[1] === undefined ? ["--framework"] : ["--framework", framework[1]];
    const option = /^(--[^=]+)=(.*)$/.exec(arg);
    return option ? [option[1], option[2]] : [arg];
  });
}
export function shellMatcher(value: unknown): (command: ParsedCommand) => boolean {
  const spec = closed(value, ["program", "args", "regex"], "shell command selector");
  if (Object.keys(spec).length === 0)
    throw new Error("Shell command selector must have program, args or regex");
  const program = spec.program === undefined ? undefined : matcher(spec.program, true);
  const regex = spec.regex === undefined ? undefined : matcher(spec.regex, false);
  if (spec.args !== undefined && (!Array.isArray(spec.args) || !spec.args.length))
    throw new Error("Shell command args must be a nonempty token selector list");
  const args =
    spec.args === undefined
      ? undefined
      : (spec.args as unknown[]).flatMap((entry) =>
          typeof entry === "string"
            ? normalize([entry]).map((token) => matcher(token, true))
            : [matcher(entry, true)],
        );
  return (command) => {
    if (program && !program(command.program)) return false;
    const actual = normalize(command.args);
    if (
      args &&
      !actual.some((_, offset) =>
        args.every(
          (match, index) => actual[offset + index] !== undefined && match(actual[offset + index]),
        ),
      )
    )
      return false;
    return !regex || regex([command.program, ...command.args].join(" "));
  };
}
