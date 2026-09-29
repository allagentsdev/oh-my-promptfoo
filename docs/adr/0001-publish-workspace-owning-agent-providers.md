# ADR 0001: Publish a workspace-owning Promptfoo provider package

- Status: Proposed
- Date: 2026-09-29

## Context

AllAgents needs an open-source Promptfoo provider for the GitHub Copilot SDK. Coding-agent evaluations also need reproducible workspaces assembled from exact Git and OCI inputs, independent per-call write trees that remain inspectable through assertions, bounded file-change reporting, cancellation, and cleanup.

Promptfoo already supplies capable `openai:codex-sdk` and `anthropic:claude-agent-sdk` providers. Reimplementing those integrations would duplicate model invocation, metadata, streaming, tracing, and provider-specific behavior. A separate execution gateway would add a network protocol, queue, durable state, and another evaluation boundary that local and CI jobs do not require.

A lifecycle extension can reset one fixed workspace around serialized rows, but that design has material limits:

- every row shares one path and must run serially;
- a deferred assertion can observe a later row's workspace;
- a path transported through suite state does not identify one private row checkout; and
- source preparation, agent execution, assertion access, and cleanup do not form one owned lifecycle.

AllAgents must implement a custom provider for Copilot regardless. A provider wrapper can therefore give Copilot, Codex, and Claude one workspace contract while continuing to use Promptfoo's original Codex and Claude implementations. Each response exposes its private checkout to assertions, but that design is safe only when the host guarantees provider cleanup after the complete evaluation lifecycle.

Promptfoo 0.122.0 publicly exports `loadApiProvider`, package-provider loading, and JavaScript assertion access to `providerResponse`. Its package loader requires an explicit exported constructor; it does not fall back to a default export when the suffix is omitted. Extensions still require `file://` references.

Promptfoo 0.122.0 cannot support retained response checkouts: its [`evaluate()` API returns without provider cleanup](https://github.com/promptfoo/promptfoo/blob/0.122.0/src/evaluate.ts#L347-L375), while its [CLI returns below the pass-rate threshold before reaching cleanup](https://github.com/promptfoo/promptfoo/blob/0.122.0/src/node/doEval.ts#L1169-L1199); thrown errors and cancellation can bypass the same loop. The first provider release is therefore blocked on an upstream Promptfoo release that invokes every loaded provider's cleanup from an outer `finally` after assertions and uses all-settled semantics so one cleanup failure cannot skip another. The package peer range starts at that first verified release, and runtime construction rejects older hosts.

## Decision

Create the public repository `allagentsdev/promptfoo-integrations` as a Bun workspace that publishes independently versioned npm integrations.

The initial public package is `@allagents/promptfoo-provider`. It exports:

- `Provider` — the recommended workspace-owning provider and default export; and
- `CopilotSdkProvider` — the lower-level Copilot SDK provider for callers that already own a workspace.

The repository may later publish:

- `@allagents/promptfoo-extensions`;
- `@allagents/promptfoo-assertions`.

Shared workspace implementation begins as a private workspace package. Its runtime and declaration output is bundled into `@allagents/promptfoo-provider`; the published manifest has no dependency on the private package. It becomes public only after a second external consumer requires a supported interface.

### Public provider references

The package exports two provider classes and makes `Provider` the default:

```ts
export class Provider {
  // implementation
}

export class CopilotSdkProvider {
  // implementation
}

export default Provider;
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

Explicit named exports are stable across ESM/CommonJS interop. The default is available to ordinary JavaScript consumers but is not the documented Promptfoo convention because Promptfoo package references require the export suffix.

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
      timeoutMs: 900000
```

`delegate` is a discriminated union for the three supported IDs. Each delegate has an internal adapter and an explicit field allowlist; the initial release excludes extra directories, session reuse, settings/plugin discovery, executable overrides, arbitrary native passthroughs, environment inheritance, and function-valued hooks. Prompt-level configuration may override only fields under `delegate.config`. The wrapper validates the merged allowlisted config and injects its validated absolute checkout path as `working_dir` last. The accompanying implementation plan defines the complete TypeScript schema and precedence rules.

### Workspace provider

The public `Provider` owns one complete provider call:

1. validate a workspace specification containing credential-free Git and OCI source requests;
2. resolve each mutable request once per provider instance to an immutable Git commit or OCI manifest digest;
3. obtain an immutable seed from the provider instance's single-flight seed pool;
4. create one private writable checkout for the call;
5. sanitize every provider and prompt-level delegate config, rejecting `working_dir`, `additional_directories`, session persistence, environment inheritance, and other paths outside the checkout;
6. start a process-isolated delegate runner with an allowlisted environment and make the checkout the final-precedence `working_dir`;
7. load and call the selected delegate inside that runner with the sanitized prompt, call context, and cancellation signal;
8. wait for the delegate to settle, invoke its cleanup, and quiesce the runner process group;
9. collect a bounded file-change summary from the stable checkout;
10. preserve the delegate's native response and merge namespaced AllAgents workspace provenance, transient checkout path, and file-change metadata;
11. register the checkout as live until evaluation shutdown; and
12. return the response so JavaScript assertions can inspect that checkout and consumers can use the bounded file-change summary.

Construction, acquisition, and checkout-preparation failures remove their partial paths immediately. Once a checkout is exposed in a response, only the provider's idempotent `cleanup()` hook removes it, after assertions finish. The supported Promptfoo host guarantee above must invoke that hook after successful scores, failed scores, thrown errors, and cancellation. The hook aborts preparation, waits for active calls, removes every checkout, staging directory, and seed owned by that provider instance, and reports cleanup failures instead of changing an already returned response. Provider construction also reaps only versioned, ownership-marked roots whose recorded process is no longer alive; it never substitutes stale-root recovery for normal cleanup and never deletes another live provider's root.

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

Every source request has a contained, non-overlapping destination. Git refs and OCI tags are requests; response metadata records resolved sources with commits and manifest digests as immutable provenance.

The initial Git adapter accepts `https://` and `file://` repositories and rejects SSH URLs. HTTPS acquisition reads `ALLAGENTS_GIT_USERNAME` and `ALLAGENTS_GIT_TOKEN`, creates a private temporary `GIT_ASKPASS` helper, sets `GIT_TERMINAL_PROMPT=0`, and passes those values only to the Git subprocess. The delegate runner never inherits the helper environment or `SSH_AUTH_SOCK`.

OCI acquisition reads the ORAS executable from `ALLAGENTS_ORAS_PATH` and a Docker-compatible auth file path from `ALLAGENTS_ORAS_AUTH_FILE`. It copies the auth file to a private mode-`0600` path for one acquisition and passes only that copy to ORAS. `ALLAGENTS_WORKSPACE_ROOT` optionally selects the owned runtime root. Provider `options.env` takes precedence over `process.env` for these fixed runtime channels. Secret values, helper paths, and auth-file contents are redacted from arguments, bounded stderr, errors, file-change metadata, results, and traces; temporary credential state is removed on success, failure, timeout, and cancellation.

Seed publication is atomic. Each provider instance owns one seed pool keyed by the resolved manifest, single-flights concurrent preparation, verifies seed integrity before each clone, and removes its seeds and failed staging paths from its `cleanup()` hook. A checkout is a full copy or a copy-on-write clone with no writable hardlinks to the seed or another checkout.

"Private checkout" is an ownership and copy-isolation contract, not hostile same-user filesystem confinement. Seed paths are never sent to delegates, but a deliberately malicious shell-capable agent could traverse the host filesystem. Evaluating untrusted agents requires a container or separate OS identity and remains a follow-up decision.

OCI support initially consumes artifacts through an external ORAS 1.x executable supplied by the runtime. The materializer invokes it without a shell, resolves tags before acquisition, uses a digest-qualified reference for the pull, and supports only uncompressed regular-file layers with validated relative titles. It rejects archive and compressed layouts, verifies descriptor byte totals against the configured hard limit before pulling, and validates actual written bytes before publishing a seed. This avoids implementing registry authentication and the OCI Distribution protocol inside the first provider release. A native OCI client may replace the adapter behind the same source contract later.

### File-change metadata contract

The wrapper preserves the delegate response and adds this closed shape under `metadata.allagents`:

```ts
interface AllAgentsProviderMetadata {
  schemaVersion: 1;
  delegate: {
    id: "openai:codex-sdk" | "anthropic:claude-agent-sdk" | "copilot-sdk";
  };
  workspace: {
    path: string;
    manifestDigest: `sha256:${string}`;
    sources: ResolvedSource[];
  };
  fileChanges: FileChanges;
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

type FileChanges =
  | FileChangesComplete
  | FileChangesTruncated
  | FileChangesFailed;

interface FileChangesResult {
  schemaVersion: 1;
  entries: FileChangeEntry[];
  summary: FileChangesSummary;
}

interface FileChangesComplete extends FileChangesResult {
  status: "complete";
  truncated: false;
}

interface FileChangesTruncated extends FileChangesResult {
  status: "truncated";
  truncated: true;
  truncation: { codes: string[] };
}

interface FileChangesFailed {
  schemaVersion: 1;
  status: "failed";
  entries: [];
  summary: {
    added: 0;
    modified: 0;
    deleted: 0;
    renamed: 0;
    indeterminate: 0;
    binary: 0;
    oversized: 0;
    total: 0;
  };
  truncated: false;
  failure: { code: string; message: string };
}

interface FileChangesSummary {
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  indeterminate: number;
  binary: number;
  oversized: number;
  total: number;
}

interface FileChangeBase {
  path: string;
  sourceDestination: string;
}

type FileChangeEntry =
  | (FileChangeBase & {
      status: "added";
      before?: never;
      after: FileState;
    })
  | (FileChangeBase & {
      status: "modified";
      before: FileState;
      after: FileState;
    })
  | (FileChangeBase & {
      status: "deleted";
      before: FileState;
      after?: never;
    })
  | (FileChangeBase & {
      status: "renamed";
      previousPath: string;
      before: FileState;
      after: FileState;
    })
  | (FileChangeBase & {
      status: "indeterminate";
      reason: "oversized_comparison";
      before: FileState;
      after: FileState;
    });

type FileState = RegularFileState | SymlinkState;

interface RegularFileState {
  kind: "file";
  mode: "100644" | "100755";
  size: number;
  binary: boolean | "unknown";
  sha256?: `sha256:${string}`;
  oversized?: true;
}

interface SymlinkState {
  kind: "symlink";
  mode: "120000";
  size: number;
  binary: false;
  sha256: `sha256:${string}`;
  symlinkTarget?: string;
}
```

`workspace.path` is an absolute local path valid only until the provider's evaluation-shutdown `cleanup()` completes. [Promptfoo JavaScript assertion context](https://www.promptfoo.dev/docs/configuration/expected-outputs/javascript/#using-test-context) exposes the complete provider response, so assertions read `context.providerResponse.metadata.allagents.workspace.path` and inspect files directly. Persisted results may retain the path as historical metadata after the directory is gone; consumers must not treat it as a durable artifact reference.

[Vercel's `agent-eval`](https://github.com/vercel-labs/agent-eval/blob/7e9aae4f7779f080af785ec88c17ef3c2ab3cebd/packages/agent-eval/src/lib/agents/shared.ts#L229-L276) establishes a Git baseline and captures generated and deleted files after agent execution. This provider uses the same baseline-and-delta idea but does not copy its `git add .` implementation: staging the real checkout would be unsafe and unbounded for large repositories.

For each Git source, collection creates a package-owned temporary index while the checkout is still clean. It loads the immutable commit with `git read-tree`, refreshes worktree stat information into that private index, verifies the baseline is clean, freezes the baseline ignore view, and retains the index unchanged through delegate execution. Final collection discovers tracked candidates with NUL-delimited `git diff --name-only -z` output and untracked candidates with `git ls-files --others -z`. Every collector Git command disables replacement objects, ambient configuration, external diff, file-system monitor, untracked cache, and optional locks. Baseline ignore rules come from the immutable commit, so an agent cannot hide a new file by changing `.gitignore`; replacement refs, commits, and staging cannot redefine the explicit baseline. The checkout's real index, refs, remotes, and worktree state are never mutated by collection.

The initial private-index refresh may hash clean files once when Git cannot trust their stat information, and final discovery still traverses tracked metadata and untracked directories. The design is bounded and proven through scale tests, not constant-time. After that refresh, application code reads only candidate states. Before states come from the immutable commit; after states use containment checks, no-follow opens, and pre/post metadata checks so a concurrent replacement fails capture rather than mixing bytes. A symlink target is included only when it is a safe contained logical path. Exact bounded delete/add identities become renames; similarity detection is not used. An oversized comparison that cannot be proved becomes an `indeterminate` entry instead of a false modification.

OCI materialization creates a package-private inventory of relative path, kind, mode, size, and digest while verifying and publishing the immutable seed. Checkouts reuse that baseline; final collection walks only the bounded OCI destinations and reads content only where comparison requires it. Paths outside declared destinations can contain additions only and are scanned separately; their `sourceDestination` is `"."`. Summary counts describe returned entries, not unknown changes omitted by a limit. Fixed internal limits bound elapsed time, candidate paths, returned entries, bytes per candidate, total application file reads, subprocess output, and serialized metadata. A limit produces `status: "truncated"`; an operational failure produces `status: "failed"`. Neither outcome replaces an otherwise valid delegate response.

The manifest digest is SHA-256 over UTF-8 RFC 8785 canonical JSON containing schema version, materializer versions, and resolved sources sorted by normalized destination. File-change entries and truncation codes are lexically sorted and paths use normalized `/` separators.

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

Providers, future extensions, and future assertions live in this repository because they share Promptfoo compatibility tests, workspace and file-change contracts, release automation, and examples.

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

Provider configuration, provider metadata, workspace manifests, file-change shapes, and runtime environment variable names are versioned public contracts. Breaking changes require a major version.

## Consequences

### Benefits

- Copilot, Codex, and Claude receive one workspace and file-change contract.
- Codex and Claude continue to track Promptfoo's maintained implementations.
- Every call receives a private checkout, allowing safe Promptfoo row concurrency.
- Assertions can inspect the live private checkout, while bounded file-change metadata remains visible in Promptfoo results.
- Source provenance and agent execution are presented through one deep provider interface.
- The provider package is usable from stock Promptfoo without an authoring compiler.
- Future extensions and assertions can share the same repository and release infrastructure.

### Costs

- The wrapper depends on Promptfoo's public provider-loading behavior and must test each supported Promptfoo minor.
- Publication depends on an upstream Promptfoo release with a verified all-path provider-cleanup guarantee; 0.122.0 is explicitly unsupported.
- Workspace preparation adds filesystem and source-resolution work around every evaluation job.
- OCI users must provide a supported ORAS executable in the initial release.
- The provider must enforce change-collection bounds, delayed cleanup, and credential separation across three delegate adapters.
- Published checkouts remain on disk until evaluation shutdown because the provider has no per-row post-assertion callback. Copy-on-write cloning reduces physical use where supported, but large suites must budget for concurrent retained workspaces.
- A provider wrapper adds one stack layer when diagnosing delegated calls.

### Risks and mitigations

- **Credential exposure:** Git and OCI acquisition credentials enter through fixed runtime channels used only by source subprocesses; the process-isolated delegate runner starts from an allowlisted environment and is tested against leakage.
- **Seed mutation:** seed paths are never sent to delegates, seeds are read-only, integrity is verified before cloning, and writable hardlinks are prohibited. This prevents accidental cross-call mutation; hostile same-user filesystem traversal remains out of scope.
- **Provider drift:** packed-package integration tests run against every supported Promptfoo version.
- **Missing host cleanup:** the peer lower bound and runtime version guard exclude Promptfoo 0.122.0 and any release that does not invoke every provider cleanup on success, failed assertions, thrown errors, and cancellation.
- **Recursive delegation:** the wrapper rejects itself and delegate IDs without registered adapters.
- **Silent cleanup failure:** the supported host uses all-settled provider cleanup and reports an aggregate error; stale-root recovery handles only verified orphaned roots.
- **Unbounded change collection:** fixed time, candidate, entry, file-read, subprocess-output, and serialized-metadata limits produce explicit truncated or failed metadata without failing the delegate result.

## Alternatives considered

### Keep a fixed lifecycle-extension workspace

Rejected as the primary abstraction. It forces serialization, exposes ordering hazards with deferred grading, and cannot bind each response to one private row checkout. Extensions remain useful for unrelated suite lifecycle behavior.

### Implement independent Copilot, Codex, and Claude providers

Rejected. Only Copilot is missing. Reimplementing Codex and Claude would duplicate Promptfoo behavior and increase maintenance.

### Put Git and OCI acquisition directly inside the Copilot provider

Rejected. Source materialization is shared by every delegate. It remains a separate internal module composed by the workspace provider.

### Build a remote execution gateway

Rejected for the initial scope. A network service, durable queue, tenancy, recovery protocol, and remote artifact API are unnecessary for disposable local and CI jobs. They may be reconsidered only for concrete remote-execution or hostile multi-tenant requirements.

### Publish separate workspace and Copilot provider packages

Rejected initially. One package can expose the workspace-owning `Provider` and direct `CopilotSdkProvider`, while keeping `@github/copilot-sdk` optional. This removes a package, release stream, and self-peer dependency without widening the delegate contract.

### Use a separate repository for extensions

Rejected. Providers and extensions share contracts and compatibility infrastructure. A repository split is justified only if ownership, license, or release cadence materially diverges.

## Follow-up decisions

A separate ADR is required before:

- replacing the ORAS adapter with a native OCI client;
- supporting arbitrary nested Promptfoo providers;
- publishing workspace core as a public API;
- introducing remote execution or hostile multi-tenant isolation; or
- changing the workspace or file-change wire contract incompatibly.
