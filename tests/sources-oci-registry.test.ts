import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LIMITS } from "../packages/workspace-core/src/config.ts";
import {
  materializeSources,
  resolveSources,
} from "../packages/workspace-core/src/sources/index.ts";
import { digest } from "../packages/workspace-core/src/sources/process.ts";

const oras = process.env.ALLAGENTS_TEST_ORAS_PATH;
const real = oras ? test : test.skip;
type Registry = {
  repository: string;
  close(): Promise<void>;
  calls: string[];
  manifest: Buffer;
  blob: Buffer;
  manifestDigest: `sha256:${string}`;
};
async function registry(
  options: { title?: string; declaredSize?: number; auth?: string; stream?: Buffer } = {},
): Promise<Registry> {
  const blob = Buffer.from("verified OCI bytes\u0000\uffff");
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        mediaType: "application/vnd.oci.empty.v1+json",
        digest: digest(Buffer.from("{}")),
        size: 2,
      },
      layers: [
        {
          mediaType: "application/octet-stream",
          digest: digest(blob),
          size: options.declaredSize ?? blob.length,
          annotations: { "org.opencontainers.image.title": options.title ?? "nested/data.bin" },
        },
      ],
    }),
  );
  const calls: string[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = request.url ?? "/";
    calls.push(`${request.method} ${path}`);
    if (options.auth && request.headers.authorization !== `Basic ${options.auth}`) {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="disposable registry"' });
      response.end();
      return;
    }
    if (path === "/v2/") {
      response.writeHead(200, { "Docker-Distribution-Api-Version": "registry/2.0" });
      response.end();
      return;
    }
    if (path.startsWith("/v2/fixture/manifests/")) {
      response.writeHead(200, {
        "Content-Type": "application/vnd.oci.image.manifest.v1+json",
        "Content-Length": manifest.length,
        "Docker-Content-Digest": digest(manifest),
      });
      response.end(request.method === "HEAD" ? undefined : manifest);
      return;
    }
    if (path === `/v2/fixture/blobs/${digest(blob)}`) {
      const bytes = options.stream ?? blob;
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": bytes.length,
        "Docker-Content-Digest": digest(blob),
      });
      response.end(request.method === "HEAD" ? undefined : bytes);
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({ errors: [{ code: "NAME_UNKNOWN", message: "missing fixture" }] }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Registry listener failed");
  return {
    repository: `localhost:${address.port}/fixture`,
    manifest,
    manifestDigest: digest(manifest),
    blob,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

real(
  "real ORAS 1.x resolves authenticated disposable registry tag and verifies exact binary files",
  async () => {
    const root = await mkdtemp(join(realpathSync(tmpdir()), "allagents-real-registry-"));
    const auth = Buffer.from("fixture:private-fixture-password").toString("base64");
    const fixture = await registry({ auth });
    try {
      const registryHost = fixture.repository.split("/")[0];
      const authFile = join(root, "auth.json");
      await writeFile(authFile, JSON.stringify({ auths: { [registryHost]: { auth } } }), {
        mode: 0o600,
      });
      const staging = join(root, "stage");
      await mkdir(staging);
      const channels = { ALLAGENTS_ORAS_PATH: oras!, ALLAGENTS_ORAS_AUTH_FILE: authFile };
      const sources = await resolveSources(
        {
          sources: [
            { type: "oci", repository: fixture.repository, tag: "latest", destination: "artifact" },
          ],
        },
        channels,
      );
      expect(sources[0].type === "oci" && sources[0].digest).toBe(fixture.manifestDigest);
      await materializeSources(sources, staging, DEFAULT_LIMITS, channels);
      expect(await readFile(join(staging, "artifact", "nested", "data.bin"))).toEqual(
        Buffer.from(fixture.blob),
      );
      expect(
        fixture.calls.some((call) => call.includes(`/manifests/${fixture.manifestDigest}`)),
      ).toBe(true);
      expect(fixture.calls.some((call) => call.includes("/blobs/"))).toBe(true);
    } finally {
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

real("real ORAS declared overflow preflight sends no blob request", async () => {
  const root = await mkdtemp(join(realpathSync(tmpdir()), "allagents-real-registry-"));
  const fixture = await registry({ declaredSize: 100000 });
  try {
    const stage = join(root, "stage");
    await mkdir(stage);
    await expect(
      materializeSources(
        [
          {
            type: "oci",
            repository: fixture.repository,
            digest: fixture.manifestDigest,
            destination: "data",
          },
        ],
        stage,
        { ...DEFAULT_LIMITS, maxExtractedBytes: 100 },
        { ALLAGENTS_ORAS_PATH: oras! },
      ),
    ).rejects.toThrow("before blob");
    expect(fixture.calls.some((call) => call.includes("/blobs/"))).toBe(false);
    expect(await readdir(stage)).toEqual([]);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

real("real ORAS lying registry stream exceeds declared bytes and leaves no file", async () => {
  const root = await mkdtemp(join(realpathSync(tmpdir()), "allagents-real-registry-"));
  const fixture = await registry({ declaredSize: 2, stream: Buffer.alloc(1024 * 1024, 1) });
  try {
    const stage = join(root, "stage");
    await mkdir(stage);
    await expect(
      materializeSources(
        [
          {
            type: "oci",
            repository: fixture.repository,
            digest: fixture.manifestDigest,
            destination: "data",
          },
        ],
        stage,
        DEFAULT_LIMITS,
        { ALLAGENTS_ORAS_PATH: oras! },
      ),
    ).rejects.toThrow();
    expect(await readdir(join(stage, "data", "nested"))).toEqual([]);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
