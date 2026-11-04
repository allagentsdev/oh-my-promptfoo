import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "import-meta-resolve";
import { parse } from "yaml";

export const liveConfig = new URL(
  "../packages/oh-my-promptfoo/evals/live/promptfooconfig.yaml",
  import.meta.url,
);

export function requireFreeModel(id, catalog) {
  const model = catalog.find((entry) => entry.id === id);
  const zero = (value) =>
    typeof value === "string" &&
    value.trim() !== "" &&
    Number.isFinite(Number(value)) &&
    Number(value) === 0;
  if (
    typeof id !== "string" ||
    !id.endsWith(":free") ||
    !model ||
    !zero(model.pricing?.prompt) ||
    !zero(model.pricing?.completion) ||
    (model.pricing?.request !== undefined && !zero(model.pricing.request)) ||
    !model.supported_parameters?.includes("tools")
  )
    throw new Error("The configured model must be an available free model with tool calling");
}

/** Check the authored candidate and grader before either can make an inference request. */
export async function checkLiveAgentEval({
  configPath = liveConfig,
  fetcher = fetch,
  env = process.env,
} = {}) {
  if (!env.OPENROUTER_API_KEY?.trim())
    throw new Error("Set the OPENROUTER_API_KEY repository secret");
  const config = parse(await readFile(configPath, "utf8"));
  const graders = config.defaultTest.assert.filter(
    (assertion) => assertion.value === "package:oh-my-promptfoo/assertions:agentAssert",
  );
  if (config.providers.length !== 1 || graders.length !== 1)
    throw new Error("Live dogfood requires exactly one candidate and one workspace grader");
  const candidate = config.providers[0].config.delegate;
  const grader = graders[0].config.grader;
  const delegates = [candidate, grader];
  if (
    delegates.some(
      (delegate) =>
        delegate?.id !== "pi-sdk" ||
        delegate.config?.provider !== "openrouter" ||
        delegate.config?.baseUrl,
    )
  )
    throw new Error(
      "Live dogfood requires the built-in Pi OpenRouter endpoint for candidate and grader",
    );
  const response = await fetcher("https://openrouter.ai/api/v1/models", {
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error("OpenRouter model availability could not be checked");
  const catalog = (await response.json()).data;
  if (!Array.isArray(catalog)) throw new Error("OpenRouter returned an invalid model catalog");
  const sdk = await import("@earendil-works/pi-coding-agent");
  const ai = await import(
    resolve("@earendil-works/pi-ai", import.meta.resolve("@earendil-works/pi-coding-agent"))
  );
  const runtime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  for (const delegate of delegates) {
    requireFreeModel(delegate.config.model, catalog);
    if (!runtime.getModel("openrouter", delegate.config.model))
      throw new Error("The configured model is not in the pinned Pi SDK catalog");
  }
  return [...new Set(delegates.map((delegate) => delegate.config.model))];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const models = await checkLiveAgentEval();
    console.log(`Live dogfood preflight passed: ${models.join(", ")}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Live dogfood preflight failed");
    process.exitCode = 1;
  }
}
