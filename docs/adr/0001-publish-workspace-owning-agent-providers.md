# ADR 0001: Publish a workspace-owning Promptfoo integration package

- Status: Proposed
- Date: 2026-09-29

## Context

AllAgents needs an open-source Promptfoo provider for the GitHub Copilot SDK. Coding-agent evaluations also need reproducible workspaces assembled from exact Git and OCI inputs, independent per-call write trees that remain inspectable through assertions, bounded file-change reporting, cancellation, and cleanup.

Promptfoo already supplies capable `openai:codex-sdk` and `anthropic:claude-agent-sdk` providers. Reimplementing those integrations would duplicate model invocation, metadata, streaming, tracing, and provider-specific behavior. A separate execution gateway would add a network protocol, queue, durable state, and another evaluation boundary that local and CI jobs do not require.

A lifecycle extension that resets one fixed path forces serialized rows and cannot bind a response to one private checkout. A lifecycle extension and provider can instead share an opaque row claim: the extension marks row boundaries, while the provider reads its own `config.workspace`, creates a unique checkout, and registers that checkout under the claim. This preserves concurrent row isolation and keeps the workspace recipe with the component that materializes it.

AllAgents must implement a custom provider for Copilot regardless. A provider wrapper can therefore give Copilot, Codex, and Claude one workspace contract while continuing to use Promptfoo's original Codex and Claude implementations. Each response exposes its private checkout to assertions; a package-supplied `afterEach` hook releases that checkout after assertions, and `afterAll` sweeps remaining row and shared resources.

Promptfoo 0.122.0 publicly exports `loadApiProvider`, package-provider loading, JavaScript assertion access to `providerResponse`, and lifecycle extensions. Its package loader requires an explicit exported constructor; it does not fall back to a default export when the suffix is omitted. Extensions still require `file://` references and cannot load an npm package export directly.

Promptfoo 0.122.0 does not consistently invoke provider `cleanup()`, so provider cleanup cannot be the primary workspace boundary. This is a host limitation rather than a release blocker: the required lifecycle extension owns post-assertion release, provider cleanup remains an idempotent fallback, and ownership-marked leases recover abandoned roots after hard process termination. The supported peer range begins at the first Promptfoo version that passes the package's extension-lifecycle compatibility matrix; 0.122.0 is a candidate baseline rather than being rejected solely for provider cleanup.

## Decision

Create the public repository `allagentsdev/promptfoo-integrations` as a Bun workspace that publishes independently versioned npm integrations.

The initial public package is `@allagents/promptfoo-integration`. The name identifies a third-party integration rather than a Promptfoo fork and covers the package's provider, lifecycle, and diagnostics surfaces. `@allagents/promptfoo-plugins` is not used because Promptfoo already uses plugin terminology for red-team plugins, while `@allagents/promptfoo-tools` would obscure that this package is loaded at runtime as a provider.

The package exports:

- `Provider` — the recommended workspace-owning provider and default export;
- `CopilotSdkProvider` — the lower-level Copilot SDK provider for callers that already own a workspace; and
- `@allagents/promptfoo-integration/lifecycle` — a CommonJS/ESM subpath exporting `workspaceLifecycle`.

The same package exposes an `allagents-promptfoo` executable. `allagents-promptfoo doctor` validates workspace lifecycle configuration without modifying files; explicit `doctor --fix` repairs supported YAML configs and stages their config-local lifecycle shims. The CLI remains coupled to the integration package so its fixes and lifecycle protocol cannot version-skew. The repository may later publish `@allagents/promptfoo-assertions`.

Shared workspace implementation begins as a private workspace package. Its runtime and declaration output is bundled into `@allagents/promptfoo-integration`; the published manifest has no dependency on the private package. It becomes public only after a second external consumer requires a supported interface.

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
  - id: package:@allagents/promptfoo-integration:Provider
```

Direct Copilot use selects the named export:

```yaml
providers:
  - id: package:@allagents/promptfoo-integration:CopilotSdkProvider
```

Explicit named exports are stable across ESM/CommonJS interop. The default is available to ordinary JavaScript consumers but is not the documented Promptfoo convention because Promptfoo package references require the export suffix.

The wrapper configuration is closed. The workspace recipe remains under the provider; the lifecycle extension is generic and receives no duplicate workspace manifest:

```yaml
providers:
  - id: package:@allagents/promptfoo-integration:Provider
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

extensions:
  - file://./.allagents/promptfoo-workspace.cjs:workspaceLifecycle
```

`delegate` is a discriminated union for the three supported IDs. Each delegate has an internal adapter and an explicit field allowlist; the initial release excludes extra directories, session reuse, settings/plugin discovery, executable overrides, arbitrary native passthroughs, environment inheritance, and function-valued hooks. Prompt-level configuration may override only fields under `delegate.config`. The wrapper validates the merged allowlisted config and injects its validated absolute checkout path as `working_dir` last. The accompanying implementation plan defines the complete TypeScript schema and precedence rules.

### Workspace provider and lifecycle

The lifecycle extension and public `Provider` jointly own one row:

1. `beforeEach` attaches an opaque random row claim as a non-enumerable property under a stable `Symbol.for(...)` key on Promptfoo's exact test object; the claim value carries the lifecycle protocol version;
2. `Provider.callApi()` requires that claim, validates its credential-free Git and OCI workspace specification, resolves mutable requests to immutable identities, obtains a seed, and creates one private writable checkout;
3. the provider registers the checkout under the claim before delegate execution;
4. the provider sanitizes every provider and prompt-level delegate config, injects the checkout as final-precedence `working_dir`, starts the process-isolated delegate, and forces a response-cache miss;
5. the provider rejects any delegate response marked `cached`, waits for delegate cleanup, quiesces the runner process group, and captures bounded file changes;
6. the provider preserves the native response and adds workspace provenance, the transient checkout path, and file-change metadata;
7. Promptfoo assertions inspect the live checkout;
8. `afterEach` waits for active calls and releases every checkout registered to the row with all-settled semantics; and
9. `afterAll` closes that evaluation to new acquisitions, aborts and awaits every tracked active call and runner process group, then uses all-settled cleanup for only the rows, provider seed pools, and shared resources registered to that evaluation.

Construction, acquisition, and checkout-preparation failures remove their partial paths immediately. A failure before response publication releases its checkout in the provider call. Once a checkout path is published, the lifecycle extension—not Promptfoo's provider cleanup loop—is the normal release owner. `Provider.cleanup()` remains an idempotent host fallback.

The provider and lifecycle entrypoints may load through different CommonJS and ESM module graphs. They rendezvous through the stable process-global registry key `Symbol.for("@allagents/promptfoo-integration/workspace-runtime")`; the stored value carries an explicit protocol version, so a second incompatible package copy finds the same registry and fails instead of creating an isolated slot. A separate stable global symbol identifies the non-enumerable claim on Promptfoo's exact test object, and the claim value carries the same protocol version. The provider binds that claim to Promptfoo's evaluation ID on first use and rejects cross-evaluation reuse. The coordinator maps each claim to its active calls and leases and never accepts a filesystem path from authored config or test data. `afterAll` first closes and drains only its evaluation, so concurrent `evaluate()` calls in one process cannot release each other's resources or race live calls. The claim is never copied into prompt variables or serialized results and is deleted during row cleanup.

Each package-owned runtime root has a validated ownership marker and live lease. Normal `afterEach` cleanup removes row checkouts promptly. Provider cleanup and `afterAll` are fallbacks; a later provider construction reaps only ownership-marked roots whose lease is no longer live. Stale recovery never deletes a live or unmarked path and does not replace normal lifecycle cleanup.

The initial delegate allowlist is deliberately closed:

- `openai:codex-sdk`;
- `anthropic:claude-agent-sdk`;
- `copilot-sdk`.

Inside the isolated runner, the wrapper uses Promptfoo's public `loadApiProvider` API for Codex and Claude. The Copilot adapter calls the package's shared Copilot session runtime directly inside that existing runner; it does not construct `CopilotSdkProvider` or create a second detached process group. Standalone `CopilotSdkProvider` wraps the same session runtime in its own runner. `@github/copilot-sdk` is an optional peer dependency: selecting `copilot-sdk` or directly calling `CopilotSdkProvider` without installing it returns an actionable configuration error, while Codex- and Claude-only consumers do not install the SDK. Arbitrary Promptfoo providers are unsupported. A new delegate requires an adapter that proves the same path, serialization, cancellation, cleanup, and cache-bypass invariants.

The delegate runner protocol is versioned JSON Lines. A v1 request contains a `PromptWire` DTO (`id`, `raw`, `template`, `display`, `label`, `provider`, and `config: {}`) plus only the wire-safe context fields consumed by supported delegates: variables, debug state, JSON-safe test metadata, `bustCache: true`, W3C tracing fields, evaluation/test IDs, and row/prompt/repeat indices. The parent folds the allowed prompt-level `delegate.config` override into the validated effective delegate config before serialization, then supplies that config only to the delegate constructor. Prompt functions, live provider objects, `filters`, `getCache`, `logger`, `originalProvider`, and live `AbortSignal` objects never cross the boundary. The parent sends an `abort` control frame; the child creates its own controller and combines wrapper cancellation with native cleanup.

Workspace-backed calls never consume a cached delegate response. Every adapter must prove a reliable cache-read bypass, the wrapper sets `bustCache: true` at final precedence, and a response with `cached: true` fails closed. Global `evaluateOptions.cache: false` remains an optional way to avoid cache writes across the whole evaluation, not a correctness prerequisite. The child receives `traceparent` and `tracestate` and exports spans through the explicitly configured OpenTelemetry exporter; no in-memory cache or tracer object crosses the process boundary. Protocol stderr is bounded, captured separately from stdout, and redacted before logging or returning an error.

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

`workspace.path` is an absolute local path valid through Promptfoo assertions and removed by the row lifecycle after assertions finish. [Promptfoo JavaScript assertion context](https://www.promptfoo.dev/docs/configuration/expected-outputs/javascript/#using-test-context) exposes the complete provider response, so assertions read `context.providerResponse.metadata.allagents.workspace.path` and inspect files directly. Persisted results may retain the path as historical metadata after the directory is gone; consumers must not treat it as a durable artifact reference.

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

### Lifecycle extension distribution and configuration doctor

The workspace lifecycle is not an independent extension package. It is a required, version-matched subpath of `@allagents/promptfoo-integration` because the extension and provider share one claim and lease protocol:

```js
'use strict';

module.exports = require('@allagents/promptfoo-integration/lifecycle');
```

Promptfoo extensions currently require `file://` references. Consumers therefore keep one explicit lifecycle entry as the final extension in every workspace-owning config:

```yaml
extensions:
  - file://./.allagents/promptfoo-workspace.cjs:workspaceLifecycle
```

The package's `allagents-promptfoo doctor` command is read-only by default. Repeated `--config <path>` arguments validate the same entrypoint configs a consumer evaluates; with no explicit paths, the command discovers `promptfooconfig*.yaml` and `promptfooconfig*.yml` beneath the working directory while respecting `.gitignore` and excluding symlinks, dependency directories, and generated output. It identifies only `package:@allagents/promptfoo-integration:Provider` entries with `config.workspace`.

A YAML file that declares a workspace-enabled AllAgents provider must declare its lifecycle in that same document. Doctor does not infer cross-file Promptfoo merge groups; consumers validate each executable entrypoint independently.

For each resolved standalone config, `doctor` requires the exact final reference `file://./.allagents/promptfoo-workspace.cjs:workspaceLifecycle`, verifies a regular non-symlink shim with canonical package re-export bytes, resolves the integration package's lifecycle subpath without executing it, and reads the resolved package manifest's lifecycle protocol metadata. Read-only doctor never imports configured JavaScript. Several workspace providers in one suite share that one extension. A lifecycle without a workspace provider produces a warning with a zero exit status and is never removed automatically because the consumer may compose that config with another file.

`doctor --fix` is an explicit source repair, not a runtime authoring compiler. It uses a YAML concrete-syntax tree to preserve comments, anchors, key order, scalar style, and unrelated whitespace; inserts a missing `extensions` key or lifecycle entry; deduplicates package-owned lifecycle references; moves the entry to the final position; and stages one `.allagents/promptfoo-workspace.cjs` re-export shim plus ownership/version marker per unique config directory. Before its first write, the fixer preflights every selected YAML edit and shim ownership check. Each file replacement is atomic; if the process dies between files, rerunning the idempotent command completes the same plan without overwriting unowned work. Sibling configs share one shim. The fixer refuses dynamic or ambiguous YAML, symlink targets, unsupported config formats, and unowned or locally modified shim targets instead of rewriting them.

Consumers review and commit the resulting YAML and shim. Required CI passes the same explicit config paths to read-only `allagents-promptfoo doctor` and stock `promptfoo validate` or `promptfoo eval`; no runtime command rewrites or compiles the config. No-argument discovery is only a convenience for repositories whose entrypoints all use the documented filename patterns. `Provider.callApi()` still requires an active compatible row claim and fails before workspace acquisition when CI validation was omitted or bypassed.

```yaml
- name: Validate AllAgents Promptfoo configuration
  run: npx allagents-promptfoo doctor --config promptfooconfig.yaml
- name: Run Promptfoo validation
  run: npx promptfoo validate --config promptfooconfig.yaml
```

During `beforeAll`, `workspaceLifecycle` independently inspects `context.suite.extensions` and rejects any missing, duplicate, or non-final `:workspaceLifecycle` entry before workspace acquisition. It therefore attaches each claim after authored `beforeEach` hooks and releases the checkout after authored `afterEach` hooks.

Consumers may hand-author the same two-line shim and YAML entry. They must not copy lifecycle implementation code. Direct `node_modules` file paths are unsupported because physical layouts differ across npm, pnpm, Yarn Plug'n'Play, hoisting, and nested configs. The project should contribute package-function loading for extensions upstream; when Promptfoo supports it, the file shim can become a direct package reference.

[Issue #2](https://github.com/allagentsdev/promptfoo-integrations/issues/2) tracks a native Promptfoo post-assertion provider callback. Once a released Promptfoo version invokes that callback exactly once per published response across pass, assertion failure, exception, cancellation, timeout, and concurrent rows, the package can move row release into the provider and retire the required lifecycle entry, config-local shim, and corresponding doctor rule for that supported peer range. Provider cleanup and stale recovery remain final fallbacks; the package must never run both row-release mechanisms for one call.

Future assertion functions may use direct `package:@allagents/promptfoo-assertions:<export>` references.

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
- The integration package is usable from stock Promptfoo without an authoring compiler or Promptfoo fork.
- `doctor --fix` makes explicit, reviewable config changes while one read-only command enforces the same contract in consumer CI.

### Costs

- The wrapper depends on Promptfoo's public provider and extension behavior and must test each supported Promptfoo minor.
- Every workspace config must reference the lifecycle shim, and consumers must run `doctor --fix` or author the entry and shim themselves.
- Consumer CI must invoke read-only `doctor` to catch configuration drift before Promptfoo starts.
- OCI users must provide a supported ORAS executable in the initial release.
- The provider must enforce change-collection bounds, cache bypass, row claims, cleanup, and credential separation across three delegate adapters.
- A provider wrapper adds one stack layer when diagnosing delegated calls.

### Risks and mitigations

- **Credential exposure:** Git and OCI acquisition credentials enter through fixed runtime channels used only by source subprocesses; the process-isolated delegate runner starts from an allowlisted environment and is tested against leakage.
- **Seed mutation:** seed paths are never sent to delegates, seeds are read-only, integrity is verified before cloning, and writable hardlinks are prohibited. This prevents accidental cross-call mutation; hostile same-user filesystem traversal remains out of scope.
- **Provider or extension drift:** packed-package integration tests run against every supported Promptfoo version, and the process-global runtime rejects incompatible protocol versions.
- **Missing lifecycle extension:** `Provider.callApi()` requires an active row claim and fails before workspace acquisition when the hook is absent.
- **Configuration drift:** read-only `doctor` checks lifecycle presence, order, identity, protocol compatibility, and shim resolution in consumer CI; `doctor --fix` provides an idempotent repair, while the provider still fails closed at runtime.
- **Cached agent response:** the wrapper forces `bustCache: true` at final precedence and rejects a delegate response marked `cached`; global Promptfoo caching may remain enabled.
- **Interrupted cleanup:** `afterEach` owns normal row release, `afterAll` and provider cleanup sweep remaining leases, and lease-backed stale recovery removes only verified abandoned roots.
- **Recursive delegation:** the wrapper rejects itself and delegate IDs without registered adapters.
- **Silent cleanup failure:** row and suite cleanup attempt every lease and preserve an aggregate failure for the suite boundary even when Promptfoo logs an individual `afterEach` error.
- **Unbounded change collection:** fixed time, candidate, entry, file-read, subprocess-output, and serialized-metadata limits produce explicit truncated or failed metadata without failing the delegate result.

## Alternatives considered

### Use a fixed lifecycle-extension workspace

Rejected. One fixed path forces serialization and cannot bind each response to one private row checkout. The selected design retains a lifecycle extension but limits it to row claims and cleanup; the provider still creates a unique checkout from its own workspace configuration.

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

### Compile or mutate Promptfoo configs at evaluation time

Rejected. Automatic lifecycle injection would require AllAgents to own Promptfoo config loading, merging, relative-path resolution, and generated-file cleanup. The explicit extension plus an opt-in, reviewable doctor repair keeps stock Promptfoo as the runtime entrypoint.

### Publish the doctor as a separate CLI package

Rejected initially. The doctor repairs configuration for one version-matched provider/lifecycle protocol. Shipping its `allagents-promptfoo` binary from `@allagents/promptfoo-integration` avoids another install and incompatible CLI/package combinations. A separate umbrella package is justified only when the CLI manages multiple independently useful integrations.

## Follow-up decisions

A separate ADR is required before:

- replacing the ORAS adapter with a native OCI client;
- supporting arbitrary nested Promptfoo providers;
- publishing workspace core as a public API;
- introducing remote execution or hostile multi-tenant isolation; or
- changing the workspace or file-change wire contract incompatibly.
