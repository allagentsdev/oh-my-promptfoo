import { type BatchedRubricConfig, gradeRubric, prepareRubric } from "./rubric-contract.js";

export { type AgentRubricConfig, agentAssert } from "./agent-assert.js";
export type { BatchedRubricConfig, RubricComponent } from "./rubric-contract.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** Score all named criteria with one judge request; every criterion must pass. */
export async function llmAssert(
  output: unknown,
  context?: { config?: BatchedRubricConfig; vars?: Record<string, unknown> },
) {
  const rubric = prepareRubric(output, context);

  const model = process.env.OPENAI_MODEL;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!model || !apiKey)
    throw new Error("OPENAI_MODEL and OPENAI_API_KEY are required for LLM grading");

  const baseUrl = (process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const parsedBaseUrl = new URL(baseUrl);
  const azureOpenAI = parsedBaseUrl.hostname.endsWith(".openai.azure.com");
  const prefix = azureOpenAI && parsedBaseUrl.pathname === "/" ? "/openai/v1" : "";
  const messages = [
    { role: "system", content: rubric.system },
    { role: "user", content: rubric.user },
  ];
  return gradeRubric(rubric, JSON.stringify(messages), async () => {
    const response = await fetch(`${baseUrl}${prefix}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [azureOpenAI ? "api-key" : "authorization"]: azureOpenAI ? apiKey : `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`LLM grading failed with HTTP ${response.status}`);
    const responseBody = (await response.json()) as {
      choices?: { message?: { content?: string | { text?: string }[] } }[];
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
    };
    const content = responseBody.choices?.[0]?.message?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((part) => part.text || "").join("")
          : null;
    return {
      ...(text ? { text } : { error: "LLM grader returned no response text" }),
      ...(responseBody.usage
        ? {
            usage: {
              prompt: responseBody.usage.prompt_tokens,
              completion: responseBody.usage.completion_tokens,
              total: responseBody.usage.total_tokens,
            },
          }
        : {}),
    };
  });
}
