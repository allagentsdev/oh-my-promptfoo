---
title: "Promptfoo agent integrations implementation plan"
date: 2026-09-29
type: feat
status: proposed
---

# Promptfoo agent integrations implementation plan

## Goal

Publish two public npm packages from `allagentsdev/promptfoo-integrations`:

- `@allagents/promptfoo-provider-agent`, a workspace-owning provider that delegates to Promptfoo's Codex and Claude providers or the AllAgents Copilot provider;
- `@allagents/promptfoo-provider-copilot-sdk`, a lower-level provider that executes the public GitHub Copilot SDK in an existing working directory.

The agent provider must accept exact Git and OCI workspace sources, create one private checkout per Promptfoo call, preserve native delegate results, capture bounded immutable evidence, and clean up on success, failure, timeout, and cancellation.

ADR 0001 is authoritative for package boundaries and terminology. `CONTEXT.md` defines the domain language used below.

## Non-goals

- A network execution service, queue, database, or remote artifact API.
- Reimplementing Promptfoo's Codex or Claude providers.
- An AI Evals or AllAgents Promptfoo authoring compiler.
- Arbitrary delegate providers in the first release.
- Provider-owned scoring or replacement of Promptfoo assertions.
- A public workspace-core package before a second external consumer exists.
- Native npm package references for Promptfoo extensions before Promptfoo supports them.

## Locked contracts

### Provider references

```yaml
package:@allagents/promptfoo-provider-agent:Provider
package:@allagents/promptfoo-provider-copilot-sdk:Provider
```

Implementation classes retain descriptive names and are additionally exported as `Provider` and `default`.

### Supported delegates

```text
openai:codex-sdk
anthropic:claude-agent-sdk
copilot-sdk
```

The agent provider rejects itself, unknown delegates, and any nested delegate `working_dir`.

### Public provider configuration

`AgentWorkspaceProvider` accepts one closed, versioned configuration:

```ts
interface AgentWorkspaceProviderConfig {
  agent: CodexDelegate | ClaudeDelegate | CopilotDelegate;
  workspace: WorkspaceSpec;
  evidence?: Partial<EvidenceLimits>;
  timeoutMs?: number;
}

interface DelegateBase {
  env?: Record<string, string>;
}

interface CodexDelegate extends DelegateBase {
  id: "openai:codex-sdk";
  config?: {
    apiKey?: string;
    base_url?: string;
    maxRetries?: number;
    model?: string;
    model_provider?: string;
    sandbox_mode?: "read-only" | "workspace-write" | "danger-full-access";
    model_reasoning_effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
    network_access_enabled?: boolean;
    web_search_enabled?: boolean;
    web_search_mode?: "disabled" | "cached" | "live";
    collaboration_mode?: "coding" | "plan";
    approval_policy?: "never" | "on-request" | "on-failure" | "untrusted";
    skip_git_repo_check?: boolean;
    output_schema?: Record<string, unknown>;
    enable_streaming?: boolean;
    deep_tracing?: boolean;
  };
}

interface ClaudeDelegate extends DelegateBase {
  id: "anthropic:claude-agent-sdk";
  config?: {
    apiKey?: string;
    apiKeyRequired?: boolean;
    model?: string;
    fallback_model?: string;
    max_turns?: number;
    max_thinking_tokens?: number;
    max_budget_usd?: number;
    permission_mode?: "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk" | "auto";
    allow_dangerously_skip_permissions?: boolean;
    custom_system_prompt?: string;
    append_system_prompt?: string;
    tools?: string[] | { type: "preset"; preset: "claude_code" };
    custom_allowed_tools?: string[];
    append_allowed_tools?: string[];
    allow_all_tools?: boolean;
    disallowed_tools?: string[];
    output_format?: Record<string, unknown>;
    include_partial_messages?: boolean;
    include_hook_events?: boolean;
    forward_subagent_text?: boolean;
  };
}

interface CopilotDelegate extends DelegateBase {
  id: "copilot-sdk";
  config?: Omit<CopilotSdkProviderConfig, "working_dir" | "env">;
}

interface CopilotSdkProviderConfig {
  working_dir: string;
  model?: string;
  reasoning_effort?: "low" | "medium" | "high";
  timeoutMs?: number;
  provider?: string;
  permissions?: {
    filesystem?: "read" | "write";
    shell?: "deny" | "allow";
    network?: "deny" | "allow";
  };
  env?: Record<string, string>;
}
```

All public config objects reject unknown keys. Before public validation, each provider constructor extracts Promptfoo's loader-injected `basePath` into an internal envelope; users cannot set or override it through prompt config. The initial release deliberately omits native-provider fields that enable extra directories, session reuse, settings/plugin discovery, executable overrides, arbitrary CLI/MCP passthroughs, process-environment inheritance, or function-valued hooks. Prompt-level config may override only fields under `agent.config`; workspace, evidence, timeout, environment, and agent identity are constructor-only. The wrapper merges that allowed override into constructor config, rejects reserved fields in either layer, validates the result, and injects the validated absolute checkout path as `working_dir` last.

```yaml
providers:
  - id: package:@allagents/promptfoo-provider-agent:Provider
    config:
      agent:
        id: openai:codex-sdk
        config:
          model: gpt-5.3-codex
          sandbox_mode: workspace-write
        env:
          OPENAI_API_KEY: "{{env.OPENAI_API_KEY}}"
      workspace:
        limits:
          maxSources: 8
          maxDownloadBytes: 268435456
          maxExtractedBytes: 536870912
          timeoutMs: 120000
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

Source credentials and executable paths are runtime inputs, resolved from provider `options.env` before `process.env`:

- `ALLAGENTS_GIT_USERNAME` and `ALLAGENTS_GIT_TOKEN`;
- `ALLAGENTS_ORAS_PATH`;
- `ALLAGENTS_ORAS_AUTH_FILE`; and
- optional `ALLAGENTS_WORKSPACE_ROOT`.

These names are reserved and rejected in `agent.env` and every prompt-level delegate field. `ALLAGENTS_ORAS_AUTH_FILE` points to a Docker-compatible registry auth file; the materializer copies it to a private mode-`0600` file for each acquisition. Defaults and hard maxima for every evidence and source limit are exported constants, documented in the package README, and included in the schema version.

### Workspace sources

```ts
interface WorkspaceSpec {
  sources: WorkspaceSource[];
  limits?: Partial<SourceLimits>;
}

type WorkspaceSource = GitSource | OciSource;

interface EvidenceLimits {
  maxFiles: number;
  maxDepth: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  maxPatchBytes: number;
  timeoutMs: number;
}

interface SourceLimits {
  maxSources: number;
  maxDownloadBytes: number;
  maxExtractedBytes: number;
  timeoutMs: number;
}

interface GitSource {
  type: "git";
  repository: string;
  ref: string;
  destination: string;
}

type OciSource = {
  type: "oci";
  repository: string;
  destination: string;
} & (
  | { digest: `sha256:${string}`; tag?: never }
  | { tag: string; digest?: never }
);
```

Destinations are relative, normalized, non-empty, non-overlapping, and cannot traverse or resolve outside the seed root. Configuration contains no credentials or arbitrary commands.

The initial Git adapter accepts `https://` and `file://` repositories. It rejects SSH, Git, and credential-bearing URLs; SSH authentication and submodules require a later contract.

### Result metadata

All added metadata is namespaced beneath `response.metadata.allagents` and uses this closed wire shape:

```ts
interface AllAgentsProviderMetadata {
  schemaVersion: 1;
  delegate: {
    id: "openai:codex-sdk" | "anthropic:claude-agent-sdk" | "copilot-sdk";
  };
  workspace: {
    manifestDigest: `sha256:${string}`;
    sources: ResolvedSource[];
    changes: WorkspaceChanges;
    cleanup: WorkspaceCleanup;
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

interface WorkspaceChanges {
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
}

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

interface WorkspaceCleanup {
  attempted: true;
  checkoutRemoved: boolean;
  error?: {
    code: string;
    message: string;
  };
}
```

Arrays and `truncation.reasons` are lexically sorted, paths use normalized `/` separators, hashes are lowercase, modes contain only portable permission and executable bits, and cleanup errors are redacted. Delegate output, error, token usage, cached state, raw response, and existing metadata remain intact.

`manifestDigest` is SHA-256 over UTF-8 RFC 8785 canonical JSON containing schema version, Git and OCI materializer versions, and resolved sources sorted by normalized destination. Seed keys use this digest, not mutable requested refs or tags.

### Runtime requirements

- Node.js 22.22.0 or newer.
- Linux and macOS only in the initial release; package metadata rejects Windows because reliable process-tree termination depends on POSIX process groups.
- Bun 1.4 for repository development and publishing workflows.
- Initial public packages declare `promptfoo: ">=0.122.0 <0.123.0"` as a peer dependency and never bundle it.
- The agent package declares the Copilot package as an optional peer dependency and loads it only for the `copilot-sdk` delegate.
- The Copilot package pins `@github/copilot-sdk` to `1.0.6`; upgrades require protocol and live-smoke validation.
- OCI materialization uses a runtime-supplied ORAS 1.x executable in the first release.
- Promptfoo response caching is disabled for workspace-owning provider evaluations.

## Target repository layout

```text
.
├── CONTEXT.md
├── docs/
│   ├── adr/
│   │   └── 0001-publish-workspace-owning-agent-providers.md
│   └── plans/
│       └── 2026-09-29-promptfoo-agent-integrations.md
├── packages/
│   ├── workspace-core/
│   │   ├── src/
│   │   │   ├── config.ts
│   │   │   ├── seed-pool.ts
│   │   │   ├── checkout.ts
│   │   │   ├── evidence.ts
│   │   │   ├── sources/git.ts
│   │   │   └── sources/oci.ts
│   │   └── package.json
│   ├── provider-copilot-sdk/
│   │   ├── src/
│   │   │   ├── provider.ts
│   │   │   ├── runner.ts
│   │   │   ├── protocol.ts
│   │   │   ├── tracing.ts
│   │   │   └── redaction.ts
│   │   └── package.json
│   └── provider-agent/
│       ├── src/
│       │   ├── provider.ts
│       │   ├── delegate-factory.ts
│       │   ├── config.ts
│       │   ├── delegate-runner.ts
│       │   └── metadata.ts
│       └── package.json
├── examples/
│   ├── codex/
│   ├── claude/
│   ├── copilot/
│   └── git-and-oci-workspace/
├── scripts/
│   ├── build.ts
│   ├── smoke-packed-packages.ts
│   └── publish.ts
├── package.json
├── tsconfig.json
├── biome.json
└── bun.lock
```

`packages/workspace-core` has `"private": true`. Build output for `provider-agent` bundles its runtime and declarations; it is never a published dependency.

## Phase 1: Repository and package foundation

### Changes

1. Create a Bun workspace root with the three package directories.
2. Configure both public packages with `promptfoo` as a peer dependency. Configure the agent package with `@allagents/promptfoo-provider-copilot-sdk` as an optional peer dependency and development dependency.
3. Pin Bun in `packageManager` and Node in `engines`.
4. Configure strict TypeScript, Biome, Bun tests, and dual ESM/CommonJS builds. Bundle workspace core into the agent package while externalizing `promptfoo` and the optional Copilot peer.
5. Add Changesets for independent package versions and release notes.
6. Add root commands:
   - `bun run build`;
   - `bun run typecheck`;
   - `bun run lint`;
   - `bun test`;
   - `bun run pack:check`.
7. Add GitHub Actions for validation, packed-package smoke tests, and trusted npm publishing with provenance.
8. Add Renovate or Dependabot for Promptfoo, Copilot SDK, TypeScript, and build dependencies.
9. Confirm the maintainers control the `@allagents` npm scope before enabling publication. Fail the publish workflow before building if scope access is absent.

### Verification

- A clean checkout installs with `bun install --frozen-lockfile`.
- All root commands pass with empty package implementations.
- `npm pack --dry-run` for both public packages includes only declarations, runtime files, license, package metadata, and README.
- A clean npm smoke project installs and executes each tarball. The agent tarball's manifest and emitted imports contain no private workspace package dependency; `promptfoo` and the Copilot package remain external peers.

## Phase 2: Workspace configuration and containment

### Changes

Implement `workspace-core/src/config.ts` with the exact closed schemas above for `WorkspaceSpec`, `GitSource`, `OciSource`, evidence limits, and runtime inputs.

Validation must reject:

- empty or absolute destinations;
- `.` or `..` path segments;
- Windows drive or UNC paths;
- duplicate or ancestor/descendant destination overlap;
- repository schemes other than the initial Git `https://` and `file://` contract;
- malformed OCI digests;
- unknown fields;
- credentials embedded in repository URLs; and
- source counts or configured limits above hard package maxima.

Use two-stage keys. First, canonical request JSON single-flights resolution of each Git ref or OCI tag. The first successful resolution is pinned for that provider instance. Second, SHA-256 over UTF-8 RFC 8785 canonical JSON containing schema version, materializer versions, and resolved sources sorted by normalized destination becomes the seed key.

Runtime input resolution must record only whether a channel was present, never its value. It rejects an unwritable workspace root, a non-executable ORAS path, credential values embedded in config, and source limits above exported hard maxima.

### Verification

Table-driven tests cover POSIX and Windows path forms, Unicode normalization, overlap in both declaration orders, URL user-info, malformed digests, unknown fields, and stable canonicalization.

## Phase 3: Git source materialization

### Changes

Implement `sources/git.ts` using direct process spawning without a shell.

For each Git source:

1. create a private staging directory;
2. create a subprocess-only credential helper from the fixed runtime credential channels;
3. clone or fetch with interactive prompts disabled and the helper environment scoped to that process;
4. resolve the requested ref to a commit object;
5. check out the detached commit into the declared destination;
6. remove the helper, its environment, remotes, temporary refs, and acquisition-only state;
7. reject submodules in the first release rather than acquiring undeclared sources;
8. verify the real path and every parent remain within staging;
9. record requested repository/ref and resolved commit; and
10. atomically publish only after the complete workspace passes validation.

Do not put credentials in command arguments, repository URLs, manifests, logs, errors, or metadata.

### Verification

- A mutable branch resolves once and records its commit.
- Two sources with different destinations compose into one seed.
- Invalid refs, submodules, symlink escapes, cancellation, and acquisition failure publish no seed.
- Success, failure, and cancellation tests prove the credential environment reaches only Git, temporary helper/config files are deleted, and errors and metadata are redacted.
- A delegate launched after preparation receives none of the supplied source credential names or values.
- A fixture repository cannot mutate the source repository through the seed.

## Phase 4: OCI source materialization

### Changes

Implement `sources/oci.ts` behind an `OciMaterializer` interface. The initial adapter invokes the runtime-supplied ORAS 1.x executable with literal arguments and no shell.

For each OCI source:

1. require `repository@sha256:<digest>` as the effective fetch identity;
2. fetch and verify the manifest descriptor and selected manifest digest;
3. accept only uncompressed regular-file layers with a valid relative `org.opencontainers.image.title`;
4. reject archives, compressed layers, duplicate or overlapping titles, and unsupported media types;
5. sum descriptor sizes and reject the artifact before pull when it exceeds the configured download or extracted-byte limit;
6. pull into a private empty directory with timeout and cancellation;
7. verify actual files and bytes written do not exceed descriptors or configured limits;
8. reject device files, FIFOs, sockets, escaping symlinks, hardlinks outside the tree, and absolute paths;
9. copy the validated payload to its declared destination;
10. remove registry configuration and acquisition state; and
11. record repository, digest, media types, descriptor sizes, and materializer version.

Registry credentials come from `ALLAGENTS_ORAS_AUTH_FILE`. The materializer copies that file with mode `0600`, passes the copy only to the acquisition subprocess, and deletes it in `finally`. Its path and contents are redacted.

### Verification

- A local disposable OCI registry fixture serves a pinned uncompressed file artifact.
- A valid artifact materializes the expected tree and manifest digest.
- Digest mismatch, compressed/archive layouts, malicious titles, size overflow, timeout, cancellation, and authentication failure publish no seed.
- Overflow tests prove rejection occurs before payload download and that staging never exceeds the configured maximum.
- Tests prove the registry config copy is deleted and neither credential names nor values reach provider metadata or the delegate environment.

## Phase 5: Seed pool and private checkouts

### Changes

Implement `seed-pool.ts` and `checkout.ts`:

- each `AgentWorkspaceProvider` instance owns one seed pool, one request-resolution map, and all paths created beneath its private runtime root;
- concurrent calls for one canonical request share one resolution promise;
- the first successful commit/digest is pinned for that request until provider cleanup, even if the remote ref or tag moves;
- requests that resolve to one manifest share one seed preparation promise;
- failed resolution or preparation entries are removed so a later call may retry;
- completed seeds remain immutable for that provider instance's lifetime;
- each checkout uses a unique contained directory;
- checkout creation uses a verified reflink/copy-on-write clone when available and a recursive copy otherwise;
- hardlinks are prohibited;
- checkout disposal and provider cleanup are idempotent;
- the provider `cleanup()` hook aborts preparation, waits for in-flight calls, then removes every checkout, staging path, and seed it owns; and
- source acquisition abort and per-call abort are separate so cancellation of one row does not corrupt a seed used by another row.

### Verification

- Twenty concurrent checkouts share one seed preparation and receive distinct writable roots.
- Concurrent calls while a ref moves share the first resolution; later calls on that provider stay pinned, while a new provider instance resolves the new target.
- Mutation in one checkout does not change the seed or another checkout.
- Partial copies, cancellation, process errors, and repeated disposal leave no published checkout.
- An ownership marker prevents deletion of paths not created by workspace-core.
- Provider cleanup during successful, failed, and cancelled preparation leaves no owned checkout, staging directory, or seed; repeated cleanup is a no-op.

## Phase 6: Workspace evidence

### Changes

Implement `evidence.ts` in two stages. First, after the delegate process tree is quiescent, collect immutable filesystem facts by comparing the checkout with its seed. Second, after checkout disposal, finalize the evidence record with the observed cleanup outcome.

Evidence includes:

- schema version;
- manifest digest;
- requested and resolved source identities;
- added, modified, and deleted paths;
- bounded per-file sizes;
- an optional bounded unified patch for textual files;
- skipped binary and oversized files;
- total counts and bytes;
- collection duration;
- explicit truncation reasons; and
- cleanup status.

Walks must reject symlink escape and remain bounded by count, bytes, depth, and time. Hash files while streaming. Do not read full oversized files into memory. Sort every emitted collection deterministically. Finalized evidence is frozen and never mutated.

### Verification

Tests cover additions, modifications, deletions, binary files, mode changes, symlinks, large files, truncation, deterministic ordering, timeout, successful cleanup, and cleanup failure. Evidence remains JSON-serializable and within configured byte limits. Cleanup status is absent from pre-disposal facts and present exactly once in the finalized record.

## Phase 7: Copilot SDK provider

### Changes

Implement a clean public-SDK-based provider in `provider-copilot-sdk`.

The provider must:

- implement Promptfoo's `ApiProvider` contract;
- accept exactly `CopilotSdkProviderConfig`;
- accept absolute working directories for direct callers that already own their workspace; resolve relative values from the trusted loader `basePath`, then validate existence and directory type;
- spawn a detached runner process in the resolved working directory;
- communicate through a versioned JSON-lines protocol;
- start with a minimal child environment;
- forward Promptfoo cancellation and enforce timeout;
- terminate the complete process group, escalating after a bounded grace period;
- project SDK events into bounded trajectory and usage metadata;
- emit OpenTelemetry spans without recording credentials or unbounded payloads;
- redact configured secrets from output, errors, metadata, stderr, and spans; and
- return structured cleanup state on success and failure.

Export `CopilotSdkProvider`, `CopilotSdkProvider as Provider`, and the default implementation. Do not copy private AI Evals source without explicit publication rights; use it only as behavioral reference where legally permitted.

### Verification

- Unit tests use a fake SDK runner for success, SDK error, malformed protocol, timeout, cancellation, signal escalation, large output, and redaction.
- A packed-package smoke project loads `package:@allagents/promptfoo-provider-copilot-sdk:Provider` through stock Promptfoo.
- An opt-in credentialed test runs the public Copilot SDK but is not required for forked pull requests.

## Phase 8: Agent workspace provider

### Changes

Implement `AgentWorkspaceProvider` and its process-isolated `delegate-runner` in `provider-agent`.

Constructor responsibilities:

- validate the exact provider and workspace config above;
- extract and realpath Promptfoo's loader-injected `basePath` before validating public config, and keep it only in the internal constructor envelope;
- initialize one owned workspace seed pool;
- resolve only the fixed runtime input channels;
- reject nested self-delegation and unknown agent IDs; and
- reject reserved path, session, environment-inheritance, and acquisition-credential fields at every authored layer.

For each `callApi`:

1. honor an already-aborted Promptfoo signal;
2. obtain the immutable seed;
3. create a unique checkout;
4. merge only allowed delegate fields from constructor and prompt config, validate again, and inject the validated absolute checkout path as `working_dir` last;
5. start the delegate runner as a process group with the minimal platform environment plus explicit `agent.env`;
6. send a versioned JSON-lines request containing `PromptWire` (`id`, `raw`, `template`, `display`, `label`, `provider`, and `config: {}`) plus `vars`, `debug`, JSON-safe test metadata, cache flags, tracing fields, evaluation/test IDs, and row/prompt/repeat indices;
7. forward cancellation, enforce the wrapper timeout, await delegate cleanup, and terminate the runner process group before continuing;
8. collect filesystem facts whether the delegate succeeds or returns an error;
9. dispose the checkout and record the actual cleanup result;
10. reject a delegate response that already owns `metadata.allagents`, then finalize immutable evidence and add that namespace without replacing any other delegate metadata; and
11. return the preserved delegate response, or a provider error with bounded collected metadata when evidence or cleanup cannot satisfy the contract.

An idempotent `finally` repeats process-group termination and checkout disposal as a safety net for exceptions before normal finalization.

Protocol v1 reserves stdout for newline-delimited frames with `{ version: 1, requestId, type, payload }`. The parent sends one `call` frame and optional idempotent `abort` frame. The child constructs its own `AbortController`, rejects unknown or duplicate frames, and emits exactly one terminal `response` or `fatal` frame only after native cleanup. Exported constants bound frame bytes, stderr bytes, and shutdown grace time. Malformed, oversized, duplicate-terminal, or non-serializable frames fail closed.

The child receives `traceparent` and `tracestate` and exports spans through explicitly allowlisted OpenTelemetry environment/config; no in-memory tracer or cache callback crosses the boundary. Protocol stderr is separate from stdout, bounded, and redacted before logging or response construction. Wrapper response caching remains disabled.

The runner receives trusted `basePath` separately from public config and supplies it to `loadApiProvider` for peer/SDK resolution even when the checkout lives outside the config directory. Before serialization, the parent folds the allowed prompt-level `agent.config` override into the validated effective constructor config and clears `PromptWire.config`. It strips prompt functions, prompt-level provider objects, and every process-local context field; supported delegates receive only the DTO fields above.

Delegate runner behavior:

- call Promptfoo's public `loadApiProvider` for Codex and Claude;
- dynamically import the optional packaged Copilot provider for `copilot-sdk`, returning an actionable configuration error when it is not installed;
- run with only essential platform variables and explicit `agent.env`, so Claude's inheritance of its own `process.env` remains contained;
- omit process-local context fields (`filters`, `getCache`, `logger`, and `originalProvider`) only after compatibility tests prove the supported delegates do not consume them, and reject non-serializable values inside the wire-safe subset;
- preserve delegate output, error, usage, raw response, cache metadata, labels, and tracing context; and
- return a final response only after native provider cleanup settles.

Export `AgentWorkspaceProvider`, `AgentWorkspaceProvider as Provider`, and the default implementation.

### Verification

- Contract tests run the same fake coding task through Codex, Claude, and Copilot delegates.
- Prompt-level attempts to set `working_dir`, `additional_directories`, session persistence, environment inheritance, unknown keys, or acquisition credential variables are rejected.
- Every delegate receives the contained checkout path at final precedence and receives no sibling or seed path through provider configuration.
- Timeout and cancellation tests for every delegate assert the runner process group and any descendants are gone before `callApi` returns.
- Protocol tests cover abort before and during execution, malformed and oversized frames, duplicate terminal frames, bounded stderr, redaction, trace-context propagation, child cleanup, and forced process-group escalation.
- Base-path tests run with process cwd, Promptfoo config directory, installed package directory, and workspace root all different; native SDK resolution still uses the trusted config base while every delegate receives the absolute checkout.
- Prompt DTO tests cover function-backed prompts and prompt configs containing a live provider object without serializing either object; a prompt-level model override reaches the delegate through its validated constructor config while `PromptWire.config` remains empty.
- Two concurrent calls prove distinct workspaces and evidence.
- A delegate-authored `metadata.allagents` namespace returns an explicit collision error rather than being overwritten.
- A delayed model-grade simulation consumes finalized evidence after both checkouts are gone.
- Delegate failure, evidence failure, timeout, cancellation, and cleanup failure produce explicit results and no leaked process, checkout, staging path, or seed.
- Packed-package smoke tests load `package:@allagents/promptfoo-provider-agent:Provider` through stock Promptfoo.

## Phase 9: Examples and Promptfoo compatibility

### Changes

Add executable examples for:

- direct Copilot with an existing directory;
- Codex with a Git workspace;
- Claude with a Git workspace;
- Copilot with composed Git and OCI sources; and
- parallel rows proving isolated checkouts.

Every workspace-owning example sets:

```yaml
evaluateOptions:
  cache: false
```

Add a compatibility matrix for each supported Promptfoo minor. Tests install packed package tarballs into a clean temporary project with that Promptfoo version and run `promptfoo validate` plus a deterministic fake-delegate evaluation.

### Verification

- No example imports repository source files directly.
- All examples resolve providers through `package:` identifiers.
- The compatibility matrix fails on public loader or provider-contract drift.
- Examples contain no live credentials and use local fixtures by default.

## Phase 10: Extension and assertion preparation

### Changes

Reserve package names and establish shared build conventions only when the first real extension or assertion is implemented.

Promptfoo already loads JavaScript assertion functions through `package:`. The first assertion package documents direct references such as `package:@allagents/promptfoo-assertions:<export>`.

Until Promptfoo supports package-function references for extensions:

- publish normal named extension exports;
- document a checked-in `file://` re-export shim;
- reject direct `node_modules` paths as unsupported; and
- open an upstream Promptfoo proposal for extension package loading.

Do not ship empty placeholder packages.

### Verification

The first assertion PR includes a stock-Promptfoo example using `package:` directly. The first extension PR proves its `file://` shim and includes a migration note for future native package references.

## Phase 11: Release

### Changes

1. Confirm npm scope ownership and trusted-publisher configuration.
2. Publish release candidates under a `next` dist-tag.
3. Install both packages from the public registry into a clean smoke project.
4. Run packed and registry-installed compatibility suites.
5. Publish stable `1.0.0` releases with provenance.
6. Announce the exact supported Promptfoo range, Node version, ORAS requirement, config schema, and evidence limits.
7. Update AllAgents and AI Evals documentation to consume the public packages rather than copy implementations.

### Verification

- npm displays provenance for both packages.
- `npm view` shows the expected repository, license, exports, engines, peer dependencies, and dist-tags.
- A fresh project can run both documented `package:...:Provider` references.
- Published tarballs contain no fixtures, credentials, source maps with private paths, or private repository references.

## Required quality gates

Every implementation pull request must run the narrow package tests it changes. Before the first public release, run once from a clean checkout:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test
bun run build
bun run pack:check
```

The release candidate additionally runs:

- packed-package stock-Promptfoo validation;
- concurrent workspace isolation E2E;
- Git provenance E2E;
- OCI digest/authentication E2E against a disposable registry;
- Copilot protocol and cancellation E2E with a fake runner; and
- credentialed live-provider smoke tests when organization secrets are available.

## Completion criteria

- Both provider packages are public and installable from npm with provenance.
- Stock Promptfoo loads each package through its documented `:Provider` export.
- Agent workspace provider calls original Promptfoo Codex and Claude providers and the AllAgents Copilot provider.
- Git and OCI inputs produce immutable provenance and private per-call checkouts.
- Concurrent calls share no writable filesystem objects; mutation through one checkout cannot change its seed or sibling checkouts.
- Evidence remains available after cleanup and is safe for deferred grading.
- Cancellation and failure leave no provider process or checkout behind.
- Source credentials are absent from delegate environments, results, logs, and traces.
- No Promptfoo authoring compiler, network gateway, or custom score protocol is introduced.
