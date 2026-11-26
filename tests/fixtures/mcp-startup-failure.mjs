// Exit before answering initialize. Put sensitive-looking data in stderr to verify
// that the SDK's diagnostic is not copied verbatim into a durable row error.
console.error("raw-stderr-fixture", import.meta.url, process.cwd(), process.env.MOCK_MODE);
console.error("Authorization: Bearer private-unknown-credential");
await import("./missing-mcp-fixture-dependency.mjs");
