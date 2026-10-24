import { createInterface } from "node:readline";

// Suite-authored offline MCP fixture: no model service or network connection.
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  let result;
  let error;
  if (method === "initialize") {
    result = {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "canned-github", version: "1.0.0" },
    };
  } else if (method === "ping") {
    result = {};
  } else if (method === "tools/list") {
    result = {
      tools: [
        {
          name: "search_code",
          description: "Search the suite's offline GitHub code fixtures",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ],
    };
  } else if (method === "tools/call" && params?.name === "search_code") {
    result = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            mode: process.env.MOCK_MODE,
            matches: [
              {
                path: "src/workspace.ts",
                symbol: "prepareWorkspace",
                repository: "example/project",
              },
            ],
          }),
        },
      ],
    };
  } else {
    error = { code: -32601, message: "Unknown fixture method or tool" };
  }
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) })}\n`,
  );
}
