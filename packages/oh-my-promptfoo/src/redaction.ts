import type { JsonObject } from "./config.js";

export function secrets(config: JsonObject, env: Record<string, string>): string[] {
  const result = Object.entries(env)
    .filter(([k]) => /KEY|TOKEN|SECRET|PASSWORD|AUTH|HEADERS/i.test(k))
    .map(([, v]) => v);
  for (const [key, value] of Object.entries(env))
    if (/HEADERS/i.test(key)) {
      for (const header of value.split(",")) {
        const idx = header.indexOf("=");
        if (idx > 0) {
          try {
            result.push(decodeURIComponent(header.slice(idx + 1)));
          } catch {
            result.push(header.slice(idx + 1));
          }
        }
      }
    }
  function visit(v: unknown): void {
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if (k === "env" && x && typeof x === "object")
        result.push(
          ...secrets(
            {},
            Object.fromEntries(
              Object.entries(x).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string",
              ),
            ),
          ),
        );
      if (
        /api[_-]?key|token|password|secret|authorization|cookie/i.test(k) &&
        typeof x === "string"
      )
        result.push(x);
      else visit(x);
    }
  }
  visit(config);
  return [...new Set(result.filter(Boolean))].sort((a, b) => b.length - a.length);
}

export function redact(value: string, sensitive: string[]): string {
  let result = value;
  for (const secret of sensitive) {
    result = result.split(secret).join("[REDACTED]");
    result = result.split(JSON.stringify(secret).slice(1, -1)).join("[REDACTED]");
    result = result.split(encodeURIComponent(secret)).join("[REDACTED]");
  }
  // Restrict to the authority, greedily consuming userinfo through its final @.
  return result.replace(/(https?:\/\/)[^\s/?#"<>\\]*@/gi, "$1[REDACTED]@");
}
