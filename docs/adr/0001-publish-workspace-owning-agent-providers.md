# ADR 0001: Publish a workspace-owning Promptfoo provider package

- Status: Proposed
- Date: 2026-09-29

## Context

AllAgents needs an open-source Promptfoo provider for the GitHub Copilot SDK. Coding-agent evaluations also need reproducible workspaces assembled from exact Git and OCI inputs, independent per-call write trees, bounded evidence, cancellation, and cleanup.

Promptfoo already supplies capable `openai:codex-sdk` and `anthropic:claude-agent-sdk` providers. Reimplementing those integrations would duplicate model invocation, metadata, streaming, tracing, and provider-specific behavior. A separate execution gateway would add a network protocol, queue, durable state, and another evaluation boundary that local and CI jobs do not require.

A lifecycle extension can reset one fixed workspace around serialized rows, but that design has material limits:

- every row shares one path and must run serially;
- a deferred model-graded assertion can observe a later row's workspace;
- cleanup failures are outside the provider response;
- final filesystem evidence must be read before the next reset; and
- source preparation, agent execution, evidence capture, and cleanup do not share one atomic call boundary.

AllAgents must implement a custom provider for Copilot regardless. A provider wrapper can therefore give Copilot, Codex, and Claude one workspace and evidence contract while continuing to use Promptfoo's original Codex and Claude implementations.

Promptfoo 0.122.0 publicly exports `loadApiProvider`, and package providers can be loaded with `package:<package>:<export>`. Its package loader requires an explicit exported constructor; it does not fall back to a default export when the suffix is omitted. JavaScript assertions already support `package:` function references. Extensions still require `file://` references.

## Decision

Create the public repository `allagentsdev/promptfoo-integrations` as a Bun workspace that publishes independently versioned npm integrations.

The initial public package is `@allagents/promptfoo-provider`. It exports:

- `WorkspaceProvider` — the recommended workspace-owning provider;
- `WorkspaceProvider as Provider` — the stable short alias used by Promptfoo package references; and
- `CopilotSdkProvider` — the lower-level Copilot SDK provider for callers that already own a workspace.

The repository may later publish:

- `@allagents/promptfoo-extensions`;
- `@allagents/promptfoo-assertions`.

Shared workspace implementation begins as a private workspace package. Its runtime and declaration output is bundled into `@allagents/promptfoo-provider`; the published manifest has no dependency on the private package. It becomes public only after a second external consumer requires a supported interface.

### Public provider references

The package exports descriptive class names, the workspace provider as `Provider`, and the workspace provider as the default:

```ts
export class WorkspaceProvider {
  // implementation
}

export class CopilotSdkProvider {
  // implementation
}

export { WorkspaceProvider as Provider };
export default WorkspaceProvider;
```

The workspace-owning provider is:

```yaml
providers:
  - id: package:@allagents/promptfoo-provider:Provider
```

Direct Copilot use selects the named export:

```yaml
providers:
  - id: package:@allagents/promptfoo-provider:CopilotSdkProvider
```

Named exports keep TypeScript, stack traces, and generated declarations descriptive. The default is not the documented Promptfoo convention because explicit named exports are stable across ESM/CommonJS interop.

The wrapper configuration is closed. A representative complete configuration is:

```yaml
providers:
  - id: package:@allagents/promptfoo-provider:Provider
    config:
      delegate:
        id: openai:codex-sdk
        config:
          model: gpt-5.3-codex
          sandbox_mode: workspace-write
        env:
          OPENAI_API_KEY: "{{env.OPENAI_API_KEY}}"
      workspace:
        sources:
          - type: git
            repository: https://github.com/example/project.git
            ref: main
            destination: project
      evidence:
        maxFiles: 1000
        maxDepth: 64
        maxTotalBytes: 10485760
        maxFileBytes: 262144
        maxPatchBytes: 1048576
        timeoutMs: 30000
      timeoutMs: 900000
```

`delegate` is a discriminated union for the three supported IDs. Each delegate has an internal adapter and an explicit field allowlist; the initial release excludes extra directories, session reuse, settings/plugin discovery, executable overrides, arbitrary native passthroughs, environment inheritance, and function-valued hooks. Prompt-level configuration may override only fields under `delegate.config`. The wrapper validates the merged allowlisted config and injects its validated absolute checkout path as `working_dir` last. The accompanying implementation plan defines the complete TypeScript schema and precedence rules.

### Workspace provider

The public `WorkspaceProvider` owns one complete provider call:

1. validate a workspace specification containing credential-free Git and OCI source requests;
2. resolve each mutable request once per provider instance to an immutable Git commit or OCI manifest digest;
3. obtain an immutable seed from the provider instance's single-flight seed pool;
4. create one private writable checkout for the call;
5. sanitize every provider and prompt-level delegate config, rejecting `working_dir`, `additional_directories`, session persistence, environment inheritance, and other paths outside the checkout;
6. start a process-isolated delegate runner with an allowlisted environment and make the checkout the final-precedence `working_dir`;
7. load and call the selected delegate inside that runner with the sanitized prompt, call context, and cancellation signal;
8. wait for the delegate to settle, invoke its cleanup, and quiesce the runner process group;
9. capture bounded filesystem facts from the now-stable checkout;
10. remove the checkout;
11. finalize immutable evidence with the observed cleanup outcome;
12. preserve the delegate's native response and merge namespaced AllAgents provenance and evidence metadata.

Idempotent `finally` cleanup is the safety net for partial failure. Evidence or cleanup failure returns a provider error with all successfully collected bounded metadata. The provider's Promptfoo `cleanup()` hook removes every checkout, staging directory, and seed owned by that provider instance. Construction and preparation failures remove their partial paths immediately.

The initial delegate allowlist is deliberately closed:

- `openai:codex-sdk`;
- `anthropic:claude-agent-sdk`;
- `copilot-sdk`.

Inside the isolated runner, the wrapper uses Promptfoo's public `loadApiProvider` API for Codex and Claude. The Copilot adapter calls the package's shared Copilot session runtime directly inside that existing runner; it does not construct `CopilotSdkProvider` or create a second detached process group. Standalone `CopilotSdkProvider` wraps the same session runtime in its own runner. `@github/copilot-sdk` is an optional peer dependency: selecting `copilot-sdk` or directly calling `CopilotSdkProvider` without installing it returns an actionable configuration error, while Codex- and Claude-only consumers do not install the SDK. Arbitrary Promptfoo providers are unsupported. A new delegate requires an adapter that proves the same path, serialization, cancellation, process-tree, and cleanup contract.

The delegate runner protocol is versioned JSON Lines. A v1 request contains a `PromptWire` DTO (`id`, `raw`, `template`, `display`, `label`, `provider`, and `config: {}`) plus only the wire-safe context fields consumed by supported delegates: variables, debug state, JSON-safe test metadata, cache flags, W3C tracing fields, evaluation/test IDs, and row/prompt/repeat indices. The parent folds the allowed prompt-level `delegate.config` override into the validated effective delegate config before serialization, then supplies that config only to the delegate constructor. Prompt functions, live provider objects, `filters`, `getCache`, `logger`, `originalProvider`, and live `AbortSignal` objects never cross the boundary. The parent sends an `abort` control frame; the child owns an `AbortController`, calls native provider cleanup, and emits exactly one bounded `response` or `fatal` frame before exit. Malformed, duplicate-terminal, oversized, and non-serializable frames fail closed.

Promptfoo response caching is disabled for the wrapper. The child receives `traceparent` and `tracestate` and exports spans through the explicitly configured OpenTelemetry exporter; no in-memory cache or tracer object crosses the process boundary. Protocol stderr is bounded, captured separately from stdout, and redacted before logging or returning an error.

`promptfoo` is a peer dependency and remains external to every bundle. The package must not bundle another Promptfoo copy because duplicated registries, tracing state, caches, and runtime types would be incorrect.

### Workspace source contract

A workspace specification contains one discriminated `sources` collection rather than separate `repos` and `ocis` arrays:

```yaml
workspace:
  sources:
    - type: git
      repository: https://github.com/example/project.git
      ref: main
      destination: project

    - type: oci
      repository: registry.example.com/eval-assets/skills
      digest: sha256:0123456789abcdef...
      destination: .agents/skills
```

Every source request has a contained, non-overlapping destination. Git refs and OCI tags are requests; evidence records resolved sources with commits and manifest digests as immutable provenance.

The initial Git adapter accepts `https://` and `file://` repositories and rejects SSH URLs. HTTPS acquisition reads `ALLAGENTS_GIT_USERNAME` and `ALLAGENTS_GIT_TOKEN`, creates a private temporary `GIT_ASKPASS` helper, sets `GIT_TERMINAL_PROMPT=0`, and passes those values only to the Git subprocess. The delegate runner never inherits the helper environment or `SSH_AUTH_SOCK`.

OCI acquisition reads the ORAS executable from `ALLAGENTS_ORAS_PATH` and a Docker-compatible auth file path from `ALLAGENTS_ORAS_AUTH_FILE`. It copies the auth file to a private mode-`0600` path for one acquisition and passes only that copy to ORAS. `ALLAGENTS_WORKSPACE_ROOT` optionally selects the owned runtime root. Provider `options.env` takes precedence over `process.env` for these fixed runtime channels. Secret values, helper paths, and auth-file contents are redacted from arguments, bounded stderr, errors, evidence, results, and traces; temporary credential state is removed on success, failure, timeout, and cancellation.

Seed publication is atomic. Each provider instance owns one seed pool keyed by the resolved manifest, single-flights concurrent preparation, verifies seed integrity before each clone, and removes its seeds and failed staging paths from its `cleanup()` hook. A checkout is a full copy or a copy-on-write clone with no writable hardlinks to the seed or another checkout.

"Private checkout" is an ownership and copy-isolation contract, not hostile same-user filesystem confinement. Seed paths are never sent to delegates, but a deliberately malicious shell-capable agent could traverse the host filesystem. Evaluating untrusted agents requires a container or separate OS identity and remains a follow-up decision.

OCI support initially consumes artifacts through an external ORAS 1.x executable supplied by the runtime. The materializer invokes it without a shell, resolves tags before acquisition, uses a digest-qualified reference for the pull, and supports only uncompressed regular-file layers with validated relative titles. It rejects archive and compressed layouts, verifies descriptor byte totals against the configured hard limit before pulling, and validates actual written bytes before publishing a seed. This avoids implementing registry authentication and the OCI Distribution protocol inside the first provider release. A native OCI client may replace the adapter behind the same source contract later.

### Evidence contract

The wrapper preserves the delegate response and adds this closed shape under `metadata.allagents`:

```ts
interface AllAgentsProviderMetadata {
  schemaVersion: 1;
  delegate: {
    id: "openai:codex-sdk" | "anthropic:claude-agent-sdk" | "copilot-sdk";
  };
  workspace: {
    manifestDigest: `sha256:${string}`;
    sources: ResolvedSource[];
    changes: {
      added: EvidenceEntry[];
      modified: EvidenceEntry[];
      deleted: DeletedEntry[];
      skipped: SkippedEntry[];
      patch?: string;
      totals: {
        added: number;
        modified: number;
        deleted: number;
        bytesInspected: number;
      };
      collectionMs: number;
      truncation: {
        files: boolean;
        bytes: boolean;
        patch: boolean;
        time: boolean;
        reasons: string[];
      };
    };
    cleanup: {
      attempted: true;
      checkoutRemoved: boolean;
      error?: { code: string; message: string };
    };
  };
}

type ResolvedSource =
  | {
      type: "git";
      repository: string;
      requestedRef: string;
      commit: string;
      destination: string;
    }
  | {
      type: "oci";
      repository: string;
      requested: { digest: `sha256:${string}` } | { tag: string };
      digest: `sha256:${string}`;
      destination: string;
      mediaTypes: string[];
    };

interface EvidenceEntry {
  path: string;
  type: "file" | "symlink";
  mode: number;
  size: number;
  sha256?: `sha256:${string}`;
  symlinkTarget?: string;
}

interface DeletedEntry {
  path: string;
  type: "file" | "symlink" | "directory";
}

interface SkippedEntry {
  path: string;
  reason: "binary" | "oversized" | "limit" | "timeout" | "unsupported";
}
```

The manifest digest is SHA-256 over UTF-8 RFC 8785 canonical JSON containing schema version, materializer versions, and resolved sources sorted by normalized destination. Evidence arrays and truncation reasons are lexically sorted; paths use normalized `/` separators; hashes are lowercase; modes contain only portable permission and executable bits; cleanup errors are redacted.

Evidence is bounded by file count, depth, total bytes, per-file bytes, patch bytes, and collection time. Truncation is explicit. Assertions grade this immutable evidence rather than reading a live checkout after `callApi` returns.

The wrapper does not assign scores or replace Promptfoo assertions. Promptfoo remains the evaluation system of record.

### Copilot SDK provider

The lower-level `CopilotSdkProvider` owns:

- Copilot SDK process and protocol handling;
- a minimal child environment;
- model, reasoning, permission, and provider options;
- cancellation and timeout;
- process-tree termination;
- SDK event projection into Promptfoo-compatible metadata and OpenTelemetry spans;
- usage and session metadata; and
- response redaction.

It accepts an existing `working_dir`; it does not resolve Git or OCI sources. The workspace provider composes it with the shared workspace runtime.

The implementation must follow public Copilot SDK contracts and the provider invariants in this decision. Prior implementations may inform edge cases, but they are neither dependencies nor normative specifications.

### Extensions and assertions

Providers, future extensions, and future assertions live in this repository because they share Promptfoo compatibility tests, workspace/evidence contracts, release automation, and examples.

Extensions and assertions use the loading behavior Promptfoo already provides:

- assertion functions use direct `package:@allagents/promptfoo-assertions:<export>` references;
- extension functions are normal named npm exports, with a checked-in `file://` re-export shim until Promptfoo supports package references for extensions.

```js
export { workspace } from "@allagents/promptfoo-extensions";
```

```yaml
extensions:
  - file://./promptfoo/extensions.mjs:workspace
```

Direct `node_modules` file paths are not a supported contract. The project should contribute package-function loading for extensions upstream.

### Repository and release policy

The repository is named `promptfoo-integrations`, not `promptfoo-recipes`, because downstream projects execute its packages as production dependencies. Copyable configurations belong under `examples/`.

The package targets Node.js 22.22.0 or newer on Linux and macOS; the initial release is POSIX-only so detached process groups can be terminated reliably. Bun manages workspaces, tests, builds, and release scripts. The package ships ESM, CommonJS, and declaration entrypoints. It bundles the private workspace core while externalizing `promptfoo` and optional `@github/copilot-sdk`. Releases use GitHub trusted publishing with npm provenance and never require a long-lived npm token.

Provider configuration, provider metadata, workspace manifests, evidence shapes, and runtime environment variable names are versioned public contracts. Breaking changes require a major version.

## Consequences

### Benefits

- Copilot, Codex, and Claude receive one workspace and evidence contract.
- Codex and Claude continue to track Promptfoo's maintained implementations.
- Every call receives a private checkout, allowing safe Promptfoo row concurrency.
- Evidence is captured from a quiescent checkout, finalized after cleanup, and remains stable for deferred grading.
- Source provenance and agent execution are presented through one deep provider interface.
- The provider package is usable from stock Promptfoo without an authoring compiler.
- Future extensions and assertions can share the same repository and release infrastructure.

### Costs

- The wrapper depends on Promptfoo's public provider-loading behavior and must test each supported Promptfoo minor.
- Workspace preparation adds filesystem and source-resolution work around every evaluation job.
- OCI users must provide a supported ORAS executable in the initial release.
- The provider must enforce evidence bounds, cleanup, and credential separation across three delegate adapters.
- A provider wrapper adds one stack layer when diagnosing delegated calls.

### Risks and mitigations

- **Credential exposure:** Git and OCI acquisition credentials enter through fixed runtime channels used only by source subprocesses; the process-isolated delegate runner starts from an allowlisted environment and is tested against leakage.
- **Seed mutation:** seed paths are never sent to delegates, seeds are read-only, integrity is verified before cloning, and writable hardlinks are prohibited. This prevents accidental cross-call mutation; hostile same-user filesystem traversal remains out of scope.
- **Provider drift:** packed-package integration tests run against every supported Promptfoo version.
- **Recursive delegation:** the wrapper rejects itself and delegate IDs without registered adapters.
- **Silent cleanup failure:** cleanup state is included in metadata and cleanup failure returns a provider error.
- **Unbounded artifacts:** evidence collection has explicit limits and truncation markers.

## Alternatives considered

### Keep a fixed lifecycle-extension workspace

Rejected as the primary abstraction. It forces serialization, exposes ordering hazards with deferred grading, and separates evidence capture from provider completion. Extensions remain useful for unrelated suite lifecycle behavior.

### Implement independent Copilot, Codex, and Claude providers

Rejected. Only Copilot is missing. Reimplementing Codex and Claude would duplicate Promptfoo behavior and increase maintenance.

### Put Git and OCI acquisition directly inside the Copilot provider

Rejected. Source materialization is shared by every delegate. It remains a separate internal module composed by the workspace provider.

### Build a remote execution gateway

Rejected for the initial scope. A network service, durable queue, tenancy, recovery protocol, and remote artifact API are unnecessary for disposable local and CI jobs. They may be reconsidered only for concrete remote-execution or hostile multi-tenant requirements.

### Publish separate workspace and Copilot provider packages

Rejected initially. One package can expose the workspace provider as `Provider` and direct Copilot as `CopilotSdkProvider`, while keeping `@github/copilot-sdk` optional. This removes a package, release stream, and self-peer dependency without widening the delegate contract.

### Use a separate repository for extensions

Rejected. Providers and extensions share contracts and compatibility infrastructure. A repository split is justified only if ownership, license, or release cadence materially diverges.

## Follow-up decisions

A separate ADR is required before:

- replacing the ORAS adapter with a native OCI client;
- supporting arbitrary nested Promptfoo providers;
- publishing workspace core as a public API;
- introducing remote execution or hostile multi-tenant isolation; or
- changing the workspace evidence wire contract incompatibly.
