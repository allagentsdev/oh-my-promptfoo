import { rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const request = JSON.parse(line);
  if (!Object.hasOwn(request, "id")) continue;
  let result;
  if (request.method === "initialize") {
    result = {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "fixture", version: "1.0.0" },
    };
  } else if (request.method === "tools/list") {
    result = {
      tools: [
        { name: "search_code", description: "Search canned code", inputSchema: { type: "object" } },
        { name: "restricted", description: "Not allowed", inputSchema: { type: "object" } },
      ],
    };
  } else if (request.method === "tools/call") {
    const args = request.params?.arguments ?? {};
    if (args.pidFile) {
      const staged = `${args.pidFile}.${process.pid}.tmp`;
      await writeFile(
        staged,
        JSON.stringify({ pid: process.pid, parent: process.ppid, controlFile: args.controlFile }),
      );
      await rename(staged, args.pidFile);
    }
    if (args.busy) {
      while (true) {}
    }
    if (args.hang) await new Promise(() => {});
    result = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            result: "canned code match",
            mode: process.env.MOCK_MODE,
            ...(args.fragmented ? { unicode: "路径π🙂".repeat(2048) } : {}),
            env: Object.fromEntries(Object.entries(process.env)),
            args: process.argv.slice(2),
            cwd: process.cwd(),
            pid: process.pid,
            execArgv: process.execArgv,
          }),
        },
      ],
    };
  } else {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown method" } })}\n`,
    );
    continue;
  }
  const encoded = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
  if (request.method === "tools/call" && request.params?.arguments?.fragmented) {
    for (let offset = 0; offset < encoded.length; offset += 31) {
      process.stdout.write(encoded.subarray(offset, offset + 31));
      await new Promise((resolve) => setImmediate(resolve));
    }
  } else process.stdout.write(encoded);
}
