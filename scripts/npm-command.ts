import { dirname, join } from "node:path";

/**
 * Node cannot spawn the Windows `npm.cmd`/`npx.cmd` shims without a shell, so on Windows
 * run npm's own CLI, bundled beside the running Node, directly. Other commands pass through.
 */
export function npmCommand(command: string, args: string[]): [string, string[]] {
  if (process.platform !== "win32" || (command !== "npm" && command !== "npx"))
    return [command, args];
  const cli = join(dirname(process.execPath), "node_modules", "npm", "bin", `${command}-cli.js`);
  return [process.execPath, [cli, ...args]];
}
