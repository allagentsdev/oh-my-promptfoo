import { once } from "node:events";
import { createServer } from "node:http";
import { type JsonObject, object } from "../../packages/oh-my-promptfoo/src/config";

export interface PiModelRequest {
  messages: { role: string; content: unknown }[];
  system: unknown;
  tools: string[];
}
export type PiModelReply =
  | { text: string; chunkSize?: number }
  | { tools: { id: string; name: string; args: JsonObject }[] }
  | { status: number; error: string }
  | { hang: true };
export interface PiModelServer {
  url: string;
  requests: PiModelRequest[];
  failures: Error[];
  close(): Promise<void>;
}

/** Local model-service endpoint; the Pi SDK and its filesystem tools stay real. */
export async function startPiModelServer(
  reply: (request: PiModelRequest, index: number) => PiModelReply | Promise<PiModelReply>,
): Promise<PiModelServer> {
  const requests: PiModelRequest[] = [];
  const failures: Error[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (new URL(request.url ?? "/", "http://localhost").pathname !== "/v1/messages")
        throw new Error(`Unexpected Pi model request route: ${request.url}`);
      if (request.headers["x-api-key"] !== "pi-local-test")
        throw new Error(
          `Unexpected Pi model authentication headers: ${Object.keys(request.headers).join(",")}`,
        );
      let text = "";
      for await (const chunk of request) {
        text += chunk;
        if (text.length > 1024 * 1024) throw new Error("Model request exceeds fixture bound");
      }
      const body = object(JSON.parse(text), "model request");
      if (!Array.isArray(body.messages) || !Array.isArray(body.tools))
        throw new Error("Model request requires messages and tools");
      const parsed: PiModelRequest = {
        messages: body.messages.map((value: unknown) => {
          const message = object(value, "message");
          if (typeof message.role !== "string") throw new Error("Message role is missing");
          return { role: message.role, content: message.content };
        }),
        system: body.system,
        tools: body.tools.map((value: unknown) => {
          const tool = object(value, "tool");
          if (typeof tool.name !== "string") throw new Error("Tool name is missing");
          return tool.name;
        }),
      };
      requests.push(parsed);
      const result = await reply(parsed, requests.length - 1);
      if ("status" in result) {
        response.writeHead(result.status, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            type: "error",
            error: { type: "authentication_error", message: result.error },
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const event = (type: string, data: JsonObject) => {
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      };
      event("message_start", {
        message: {
          id: `pi-message-${requests.length}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 11,
            output_tokens: 0,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 2,
          },
        },
      });
      if ("hang" in result) return;
      if ("tools" in result) {
        for (const [index, tool] of result.tools.entries()) {
          event("content_block_start", {
            index,
            content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} },
          });
          event("content_block_delta", {
            index,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.args) },
          });
          event("content_block_stop", { index });
        }
      } else {
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        const chunkSize = result.chunkSize ?? Math.max(result.text.length, 1);
        for (let offset = 0; offset < result.text.length; offset += chunkSize)
          event("content_block_delta", {
            index: 0,
            delta: { type: "text_delta", text: result.text.slice(offset, offset + chunkSize) },
          });
        event("content_block_stop", { index: 0 });
      }
      event("message_delta", {
        delta: { stop_reason: "tools" in result ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: 7 },
      });
      event("message_stop", {});
      response.end();
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: failures.at(-1)?.message }));
    }
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Model fixture has no TCP port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    failures,
    async close() {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

export function toolResults(request: PiModelRequest): JsonObject[] {
  return request.messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.flatMap((value: unknown) => {
          const block = object(value, "content block");
          return block.type === "tool_result" ? [block] : [];
        })
      : [],
  );
}
