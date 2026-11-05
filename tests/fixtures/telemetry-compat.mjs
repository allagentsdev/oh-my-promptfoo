import assert from "node:assert/strict";
import { createRequire } from "node:module";

// A fresh process lets the real Promptfoo API 1.9 initialize the host registry,
// before this package's bundled API readers are loaded.
const promptfooRequire = createRequire(import.meta.resolve("promptfoo"));
const api = promptfooRequire("@opentelemetry/api");
const { NodeTracerProvider } = promptfooRequire("@opentelemetry/sdk-trace-node");
const { W3CTraceContextPropagator } = promptfooRequire("@opentelemetry/core");
const { AsyncLocalStorageContextManager } = promptfooRequire("@opentelemetry/context-async-hooks");
const provider = new NodeTracerProvider();
provider.register({
  propagator: new W3CTraceContextPropagator(),
  contextManager: new AsyncLocalStorageContextManager(),
});
try {
  const { wireContext } = await import("../../packages/oh-my-promptfoo/src/protocol.ts");
  await api.trace.getTracer("consumer-fixture").startActiveSpan("promptfoo-row", async (span) => {
    try {
      const parent = span.spanContext();
      assert.equal(
        wireContext({}).traceparent,
        `00-${parent.traceId}-${parent.spanId}-${parent.traceFlags.toString(16).padStart(2, "0")}`,
      );
    } finally {
      span.end();
    }
  });
} finally {
  await provider.shutdown();
  api.trace.disable();
  api.context.disable();
  api.propagation.disable();
}
console.log("Older Promptfoo host trace propagated");
