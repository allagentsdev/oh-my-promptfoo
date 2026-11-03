import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { createRequire, syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { resolve as resolveImport } from "import-meta-resolve";

const mode = process.argv[2];
const deadline = setTimeout(() => {
  throw new Error(`Dependency fixture hung: ${mode}`);
}, 20_000);

if (mode === "zod") {
  const sdkRequire = createRequire(import.meta.resolve("@github/copilot-sdk"));
  const { z } = sdkRequire("zod");
  let visited = 0;
  const schema = z
    .array(
      z.preprocess((value) => {
        visited++;
        return value;
      }, z.string()),
    )
    .max(2);
  const result = schema.safeParse(Array(4096).fill(17));
  assert.equal(result.success, false);
  assert.equal(visited, 0, "Oversized input reached element validators before its size guard");
  assert.equal(result.error.issues.length, 1);
  assert.equal(result.error.issues[0].code, "too_big");
  assert.deepEqual(schema.parse(["valid", "items"]), ["valid", "items"]);
  assert.equal(visited, 2);
}

if (mode === "undici") {
  const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const undici = piRequire("undici");
  const body = Buffer.from('{"transport":"real-gzip"}');
  const zipped = gzipSync(body);
  let maliciousSocket;
  let maliciousClose;
  const server = net.createServer((socket) => {
    socket.on("error", () => {}); // A client abort is expected; never mask client stream errors.
    let request = "";
    socket.on("data", (chunk) => {
      request += chunk.toString();
      if (!request.includes("\r\n\r\n")) return;
      socket.removeAllListeners("data");
      if (request.startsWith("GET /bad ")) {
        maliciousSocket = socket;
        maliciousClose = new Promise((resolve) => socket.once("close", resolve));
        socket.write(
          "HTTP/1.1 200 OK\r\nContent-Encoding: gzip, gzip, gzip, gzip, gzip, gzip\r\nContent-Length: 1\r\nConnection: close\r\n\r\n",
        );
      } else if (request.startsWith("GET /gzip ")) {
        socket.end(
          Buffer.concat([
            Buffer.from(
              `HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Type: application/json\r\nContent-Length: ${zipped.length}\r\nConnection: close\r\n\r\n`,
            ),
            zipped,
          ]),
        );
      } else {
        socket.end(
          Buffer.concat([
            Buffer.from(
              `HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
            ),
            body,
          ]),
        );
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const client = new undici.Client(origin);
  const headers = channel("undici:request:headers");
  let acknowledge;
  const receivedHeaders = new Promise((resolve) => {
    acknowledge = resolve;
  });
  const observe = ({ request }) => {
    if (String(request.origin) === origin && request.path === "/bad") acknowledge();
  };
  headers.subscribe(observe);
  try {
    const rejected = undici.fetch(`${origin}/bad`, { dispatcher: client }).then(
      () => {
        throw new Error("Excessive content encodings were accepted");
      },
      (error) => error,
    );
    await receivedHeaders;
    const error = await rejected;
    assert.match(
      String(error.cause?.message ?? error.message),
      /content.encoding|encoding.*(limit|maximum)|maximum.*encoding/i,
    );
    if (!maliciousSocket.destroyed) maliciousSocket.end();
    await maliciousClose;
    assert.deepEqual(await (await undici.fetch(`${origin}/gzip`, { dispatcher: client })).json(), {
      transport: "real-gzip",
    });
    const correct = createHash("sha256").update(body).digest("base64");
    const wrong = createHash("sha256").update("different body").digest("base64");
    for (const algorithm of ["sha256", "SHA256", "Sha256"]) {
      assert.equal(
        await (
          await undici.fetch(`${origin}/sri`, {
            dispatcher: client,
            integrity: `${algorithm}-${correct}`,
          })
        ).text(),
        body.toString(),
      );
      await assert.rejects(
        undici.fetch(`${origin}/sri`, { dispatcher: client, integrity: `${algorithm}-${wrong}` }),
        (failure) => /integrity/i.test(String(failure.cause?.message ?? failure.message)),
      );
    }
  } finally {
    headers.unsubscribe(observe);
    maliciousSocket?.destroy();
    await client.close();
    const closed = once(server, "close");
    server.close();
    await closed;
  }
}

if (mode === "minimatch") {
  const promptfooRequire = createRequire(import.meta.resolve("promptfoo"));
  for (const require of [
    promptfooRequire,
    createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")),
    createRequire(promptfooRequire.resolve("@modelcontextprotocol/server-filesystem/package.json")),
    createRequire(promptfooRequire.resolve("glob")),
  ]) {
    const { Minimatch, minimatch } = require("minimatch");
    const pattern = Array.from({ length: 8 }, (_, index) => `**/../part${index}/leaf`).join("/");
    const matcher = new Minimatch(pattern, { optimizationLevel: 2, braceExpandMax: 16 });
    assert.ok(matcher.set.length <= 16, "Globstar preprocessing exceeded the expansion budget");
    for (const [path, glob, options, expected] of [
      ["openai/model-small", "OPENAI/model-*", { nocase: true }, true],
      ["other/model-small", "openai/model-*", { nocase: true }, false],
      ["skills/review/SKILL.md", "skills/**/SKILL.md", {}, true],
      ["skills/review/notes.txt", "**/*.{md,yaml}", {}, false],
      ["skills/review/SKILL.md", "**/*.{md,yaml}", {}, true],
      ["src/file.ts", "**/!(*.test).ts", {}, true],
      ["src/file.test.ts", "**/!(*.test).ts", {}, false],
      [".private/credentials.json", "**/credentials.json", { dot: true }, true],
    ])
      assert.equal(minimatch(path, glob, options), expected, `${path} against ${glob}`);
  }
}

if (mode === "glob") {
  const promptfooRequire = createRequire(import.meta.resolve("promptfoo"));
  for (const require of [
    promptfooRequire,
    createRequire(promptfooRequire.resolve("@modelcontextprotocol/server-filesystem/package.json")),
  ]) {
    for (const { Glob, glob, globSync, escape: escapeGlob, hasMagic } of [
      require("glob"),
      await import(resolveImport("glob", pathToFileURL(require.resolve("glob/package.json")).href)),
    ]) {
      // Published default entries can embed a matcher that dependency overrides do not replace.
      const pattern = Array.from({ length: 8 }, (_, index) => `**/../part${index}/leaf`).join("/");
      assert.ok(
        new Glob(pattern, { braceExpandMax: 16 }).patterns.length <= 16,
        "Published Glob entry exceeded the pattern expansion budget",
      );
      const directory = await mkdtemp(join(tmpdir(), "promptfoo-glob-security-"));
      try {
        for (const file of [
          "cases/a.yaml",
          "cases/nested/b.csv",
          "cases/notes.txt",
          "skip/c.yaml",
        ]) {
          const path = join(directory, file);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, "fixture");
        }
        assert.deepEqual(
          globSync("**/*.{yaml,csv}", {
            cwd: directory,
            ignore: ["skip/**"],
            nodir: true,
            windowsPathsNoEscape: true,
          }).sort(),
          ["cases/a.yaml", "cases/nested/b.csv"],
        );
        assert.equal(hasMagic("**/*.yaml"), true);
        assert.equal(hasMagic(escapeGlob("literal[1].yaml")), false);

        let reads = 0;
        const controller = new AbortController();
        const reason = new Error("test-only glob cancellation");
        const countedFs = {
          ...fs,
          readdir(...args) {
            if (++reads === 1) controller.abort(reason);
            return fs.readdir(...args);
          },
        };
        await assert.rejects(
          glob("**", { cwd: directory, signal: controller.signal, fs: countedFs }),
          (error) => error === reason,
        );
        const readsAtRejection = reads;
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(readsAtRejection, 1);
        assert.equal(reads, readsAtRejection, "Cancelled glob kept reading directories");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}

if (mode === "azure") {
  // This process exercises real credential/MSAL methods, but no outbound transport may escape.
  const denyNetwork = () => {
    throw new Error("Dependency fixture attempted real outbound network");
  };
  http.request = denyNetwork;
  https.request = denyNetwork;
  net.Socket.prototype.connect = denyNetwork;
  globalThis.fetch = denyNetwork;
  syncBuiltinESMExports();
  const promptfooRequire = createRequire(import.meta.resolve("promptfoo"));
  const { ClientSecretCredential } = promptfooRequire("@azure/identity");
  const identityRequire = createRequire(promptfooRequire.resolve("@azure/identity"));
  const { ConfidentialClientApplication } = identityRequire("@azure/msal-node");
  const { createHttpHeaders } = identityRequire("@azure/core-rest-pipeline");
  const tenant = "00000000-0000-4000-8000-000000000001";
  const clientId = "00000000-0000-4000-8000-000000000002";
  const secret = "test-only-client-secret";
  const origin = "https://login.microsoftonline.com";
  const authority = `${origin}/${tenant}`;
  const tokenUrl = `${authority}/oauth2/v2.0/token`;
  const scope = "https://cognitiveservices.azure.com/.default";
  const metadata = {
    authorization_endpoint: `${authority}/oauth2/v2.0/authorize`,
    token_endpoint: tokenUrl,
    issuer: `${authority}/v2.0`,
    jwks_uri: `${origin}/common/discovery/v2.0/keys`,
  };
  const secretRequests = [];
  const credential = new ClientSecretCredential(tenant, clientId, secret, {
    authorityHost: origin,
    disableInstanceDiscovery: true,
    retryOptions: { maxRetries: 0 },
    httpClient: {
      async sendRequest(request) {
        secretRequests.push({ url: request.url, method: request.method, body: request.body });
        const url = new URL(request.url);
        assert.equal(url.origin, origin);
        let body;
        if (
          request.method === "GET" &&
          url.pathname === `/${tenant}/v2.0/.well-known/openid-configuration`
        )
          body = metadata;
        else {
          assert.equal(url.pathname, `/${tenant}/oauth2/v2.0/token`);
          assert.equal(request.method, "POST");
          body = {
            access_token: "isolated-client-secret-token",
            token_type: "Bearer",
            expires_in: 3600,
            ext_expires_in: 3600,
            scope,
          };
        }
        return {
          request,
          status: 200,
          headers: createHttpHeaders({ "content-type": "application/json" }),
          bodyAsText: JSON.stringify(body),
        };
      },
    },
  });
  const token = await credential.getToken(scope).catch((error) => {
    throw new Error(
      `Client-secret transport failed after ${JSON.stringify(secretRequests.map(({ url, method }) => ({ url, method })))}`,
      { cause: error },
    );
  });
  assert.equal(token.token, "isolated-client-secret-token");
  const secretPosts = secretRequests.filter((request) => request.method === "POST");
  assert.equal(secretPosts.length, 1);
  const secretForm = new URLSearchParams(secretPosts[0].body);
  assert.equal(secretForm.get("grant_type"), "client_credentials");
  assert.equal(secretForm.get("client_id"), clientId);
  assert.equal(secretForm.get("client_secret"), secret);
  assert.equal(secretForm.get("scope"), scope);

  const requests = [];
  const config = {
    auth: {
      clientId,
      clientSecret: secret,
      authority,
      knownAuthorities: ["login.microsoftonline.com"],
      authorityMetadata: JSON.stringify(metadata),
    },
    system: {
      networkClient: {
        async sendGetRequestAsync(url) {
          requests.push({ url, method: "GET" });
          assert.equal(new URL(url).origin, origin);
          return { status: 200, headers: {}, body: metadata };
        },
        async sendPostRequestAsync(url, options) {
          requests.push({ url, method: "POST", body: options.body });
          assert.equal(new URL(url).origin, origin);
          assert.equal(new URL(url).pathname, `/${tenant}/oauth2/v2.0/token`);
          return {
            status: 400,
            headers: {},
            body: { error: "invalid_grant", error_description: "isolated-security-sentinel" },
          };
        },
      },
    },
  };
  const client = new ConfidentialClientApplication(config);
  await assert.rejects(
    client.acquireTokenByCode(
      {
        scopes: [scope],
        redirectUri: "http://localhost/test-callback",
        code: "original-request-code",
        state: "expected-state",
        nonce: "original-request-nonce",
      },
      {
        code: "attacker-payload-code",
        state: "expected-state",
        nonce: "attacker-payload-nonce",
        cloud_instance_host_name: "attacker.invalid",
        cloud_instance_name: "attacker-cloud",
        cloud_graph_host_name: "attacker.invalid",
        msgraph_host: "attacker.invalid",
        client_info: "attacker-metadata",
      },
    ),
    (error) =>
      error.errorCode === "invalid_grant" && error.message.includes("isolated-security-sentinel"),
  );
  const posts = requests.filter((request) => request.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(new URLSearchParams(posts[0].body).get("code"), "original-request-code");
  assert.throws(
    () =>
      new ConfidentialClientApplication({
        ...config,
        auth: { ...config.auth, instanceAware: true },
      }),
    (error) => error.errorCode === "unsupported_cca_instance_aware",
  );
  requests.length = 0;
  for (const value of ["true", "false", ""]) {
    await assert.rejects(
      new ConfidentialClientApplication(config).getAuthCodeUrl({
        scopes: [scope],
        redirectUri: "http://localhost/test-callback",
        extraQueryParameters: { instance_aware: value },
      }),
      (error) => error.errorCode === "unsupported_cca_instance_aware",
    );
  }
  await assert.rejects(
    new ConfidentialClientApplication(config).acquireTokenByCode(
      {
        scopes: [scope],
        redirectUri: "http://localhost/test-callback",
        code: "original-request-code",
        state: "expected-state",
      },
      { code: "other", state: "different-state" },
    ),
    (error) => error.errorCode === "state_mismatch",
  );
  assert.equal(requests.length, 0);
}

assert.ok(["zod", "undici", "azure", "minimatch", "glob"].includes(mode));
clearTimeout(deadline);
console.log(JSON.stringify({ mode, securityInvariant: "passed" }));
