---
title: "Promptfoo agent integrations implementation plan"
date: 2026-09-29
type: feat
status: proposed
---

# Promptfoo agent integrations implementation plan

## Goal

Publish `@allagents/promptfoo-integration` from `allagentsdev/promptfoo-integrations`. The package provides:

- `Provider`, a workspace-owning provider that delegates to Promptfoo's Codex and Claude providers or the package's Copilot provider, retains each row's workspace lease through assertions, and optionally returns bounded file changes;
- `CopilotSdkProvider`, a lower-level provider that executes the public GitHub Copilot SDK in an existing working directory; and
- `allagents-promptfoo cache prune`, a cache-maintenance command that removes unused immutable workspace seeds.

The workspace provider must accept exact Git and OCI inputs, reuse one persistent immutable seed per resolved manifest across providers and evaluations, create either a private writable view or an explicitly requested protected shared read-only checkout per call, preserve the complete JSON-safe native delegate response, expose the live workspace at `metadata.workspace.path`, optionally capture durable changed-file contents at `metadata.fileChanges`, and rely on Promptfoo's best-effort provider cleanup without hiding that limitation.

ADR 0001 is authoritative for package boundaries and terminology. `CONTEXT.md` defines the domain language used below.

## Non-goals

- A network execution service, queue, database, or remote artifact interface.
- Reimplementing Promptfoo's Codex or Claude providers.
- Guaranteed workspace deletion after every evaluation path.
- Per-row cleanup before assertions finish.
- Writable workspace sharing through symlinks or hardlinks.
- Unbounded file capture or a durable artifact store.
- Arbitrary delegate providers in the first release.
- Making optional file changes replace direct workspace inspection.
- Hostile same-user isolation without a container, VM, or separate OS identity.
- A public workspace-core package before a second external consumer exists.

## Locked contracts

### Provider and CLI references

```text
package:@allagents/promptfoo-integration:Provider
package:@allagents/promptfoo-integration:CopilotSdkProvider
allagents-promptfoo cache prune [--all]
```

`Provider` is both a named export and default export. `CopilotSdkProvider` is named. The package root is the only module export. The package manifest exposes one `allagents-promptfoo` executable with only cache-maintenance commands. Evaluation continues to use stock `promptfoo eval`.

### Supported delegates

```text
openai:codex-sdk
anthropic:claude-agent-sdk
copilot-sdk
```

The wrapper rejects itself, unknown IDs, adapters not in the closed registry, and any authored delegate `working_dir`.

### Public provider configuration

```ts
interface ProviderConfig {
  delegate: CodexDelegate | ClaudeDelegate | CopilotDelegate;
  workspace: WorkspaceSpec;
  fileChanges?: boolean;
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

All public objects reject unknown keys. Before public validation, constructors extract Promptfoo's loader-provided `basePath` into an internal envelope; users cannot set it through config.

Prompt-level config may override only fields under `delegate.config`. Workspace, file-change capture, timeout, environment, and delegate identity are constructor-only. The wrapper rejects reserved fields at every authored layer, validates the merged allowlist, and injects the absolute workspace path plus `bustCache: true` last.

`fileChanges` defaults to `false`. `true` enables the fixed bounded capture contract; it does not change workspace lifetime or cleanup.

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
      fileChanges: true
      timeoutMs: 900000
```

### Runtime channels

Source and storage inputs are resolved from provider `options.env` before `process.env`:

- `ALLAGENTS_GIT_USERNAME` and `ALLAGENTS_GIT_TOKEN`;
- `ALLAGENTS_ORAS_PATH`;
- `ALLAGENTS_ORAS_AUTH_FILE`;
- optional `ALLAGENTS_WORKSPACE_ROOT`; and
- optional `ALLAGENTS_CACHE_ROOT`.

These names are reserved and rejected in delegate configuration. Workspace and cache roots must be distinct, package-owned, and containment-validated. Users cannot make cleanup or cache pruning operate on an arbitrary unmarked directory.

### Workspace sources

```ts
interface WorkspaceSpec {
  sources: WorkspaceSource[];
  permissions?: "all" | "read-only";
  limits?: Partial<SourceLimits>;
}

type WorkspaceSource = GitSource | OciSource;

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

Destinations are relative, normalized, non-empty, non-overlapping, and cannot traverse or resolve outside the seed root. Configuration contains no credentials or arbitrary acquisition commands. Git initially accepts `https://` and `file://`, rejecting SSH, Git, and credential-bearing URLs.

### Explicit read-only selection

`workspace.permissions` defaults to `all`: a private writable view for each call. `read-only` is opt-in on a provider configuration. It is separate from the delegate's native sandbox/permission settings and cannot be overridden by prompt variables or test-level provider config. In stock Promptfoo, use labeled provider instances plus [`defaultTest.providers` and `tests[].providers`](https://www.promptfoo.dev/docs/configuration/test-cases/#filtering-tests-by-provider) to choose the mode for each test:

```yaml
providers:
  - id: package:@allagents/promptfoo-integration:Provider
    label: cargowise-readonly
    config:
      delegate:
        id: openai:codex-sdk
        config:
          sandbox_mode: read-only
      workspace:
        permissions: read-only
        sources:
          - type: git
            repository: https://github.com/WiseTechGlobal/CargoWise.git
            ref: 953adb94d49ae392c08082dc68717eefac0526cc
            destination: CargoWise
  - id: package:@allagents/promptfoo-integration:Provider
    label: cargowise-writable
    config:
      delegate:
        id: openai:codex-sdk
        config:
          sandbox_mode: workspace-write
      workspace:
        permissions: all
        sources:
          - type: git
            repository: https://github.com/WiseTechGlobal/CargoWise.git
            ref: 953adb94d49ae392c08082dc68717eefac0526cc
            destination: CargoWise
defaultTest:
  providers: [cargowise-readonly]
tests:
  - vars:
      task: Find the data transformation implementation.
  - providers: [cargowise-writable]
    vars:
      task: Fix the data transformation bug.
```

Without `defaultTest.providers` or a test's own filter, Promptfoo runs that test against **both** providers. The default filter above selects the read-only instance; a writable test overrides it. This selects provider configuration, not a mutable per-row workspace override. The consumer may resolve the Git pin to a release-backed source before the provider runs; that does not set permissions.

### Native response and workspace metadata

The delegate child returns the complete JSON-safe Promptfoo `ProviderResponse`. The wrapper validates serialized bytes and JSON safety, then round-trips every field and native metadata key. Functions, symbols, circular values, unsupported binary values, and oversized responses fail explicitly rather than disappearing.

The parent adds generic metadata keys without nesting native metadata:

```ts
interface WorkspaceMetadata {
  schemaVersion: 1;
  path: string;
  manifestDigest: `sha256:${string}`;
  sources: ResolvedSource[];
  cleanup: "best-effort-evaluation";
}

interface IntegratedMetadata extends Record<string, unknown> {
  // Native keys, including skillCalls, remain at this level.
  workspace: WorkspaceMetadata;
  fileChanges?: FileChanges;
}
```

A delegate response already owning `metadata.workspace` or `metadata.fileChanges` fails before capture or response publication. `metadata.skillCalls` remains top-level for Promptfoo's `skill-used` assertions.

`workspace.path` is absolute and remains available to transforms and assertions. Matching read-only rows may report the same protected checkout path; writable rows receive separate paths. Promptfoo may skip provider cleanup; persisted results may therefore contain either a still-present transient path or a stale path removed by cleanup, later recovery, or host teardown. No consumer may treat it as a durable artifact reference.

### Optional file-change result

```ts
type FileChanges =
  | (FileChangesResult & {
      status: "complete";
      truncated: false;
    })
  | (FileChangesResult & {
      status: "truncated";
      truncated: true;
      truncation: {
        codes: string[];
        omittedPaths: string[];
      };
    })
  | {
      schemaVersion: 1;
      status: "failed";
      generatedFiles: Record<string, never>;
      deletedFiles: [];
      truncated: false;
      failure: {
        code: string;
        message: string;
      };
    };

interface FileChangesResult {
  schemaVersion: 1;
  generatedFiles: Record<string, CapturedFile>;
  deletedFiles: string[];
  diff?: {
    format: "unified";
    content: string;
    truncated: boolean;
  };
}

interface CapturedFile {
  change: "added" | "modified";
  kind: "file" | "symlink";
  mode: "100644" | "100755" | "120000";
  size: number;
  sha256: `sha256:${string}`;
  encoding: "base64";
  content: string;
}
```

Changed after-bytes are base64 and binary-safe. Symlink entries encode target bytes without dereferencing. Deleted paths are explicit. Renames are delete plus generate. The optional unified diff is bounded convenience data for text changes.

Fixed internal defaults are 90 seconds, 10,000 candidates, 2,000 returned files, 256 KiB per file, 4 MiB total captured bytes, 1 MiB unified diff text, 4 MiB subprocess output, 1,000 omitted paths, and 8 MiB serialized metadata. Limits are safety bounds, not completeness promises.

### Best-effort workspace cleanup

`Provider.cleanup()` closes the provider to new calls, aborts and awaits active call process groups, then runs one dependency-ordered teardown chain per workspace:

1. read and validate that workspace's recovery record;
2. detach a private adapter view, including a required overlay unmount, or release a read-only row's private scratch;
3. only after detachment succeeds, remove row-owned paths and release its seed and shared-checkout leases; and
4. mark the recovery record released.

Teardown is all-settled across independent workspace chains, not across dependent steps inside one chain. A failed detach keeps that workspace's recovery record and lease for later recovery. Independent staging paths are removed; a protected checkout still leased by other read-only rows is retained, and the provider root is removed only when no unreleased record remains. `cleanup()` returns an aggregate error after attempting every chain.

Promptfoo does not currently guarantee this hook on every path. A Node evaluation or some CLI failures may leave ownership-marked roots and leases until process exit. Later provider construction reaps only valid package-owned roots whose recorded process identity is no longer alive. It refuses live, unmarked, malformed, escaping, or unknown-mount paths. Same-process abandoned roots remain live until the process exits.

This is an explicit tradeoff, not a hidden guarantee. A thousand mostly unchanged copy-on-write workspaces are acceptable because they share seed blocks. Changed blocks, installed dependencies, recursive-copy fallback, and overlay mounts still consume resources, so stale-root recovery remains required on long-lived machines.

GitHub-hosted Actions runner disposal is the final cleanup backstop and prevents cross-job stale state. A seed survives into another hosted job only when the workflow explicitly restores the cache directory. Workspace recovery and cache pruning matter primarily on local and self-hosted runners and before saving a hosted-runner cache.

### Persistent seed-cache contract

The content-addressed seed cache is package-owned and outside every provider runtime root. It defaults to the platform cache directory; `ALLAGENTS_CACHE_ROOT` may select another contained root. Entries are keyed by the resolved manifest digest and contain immutable content plus mutable package-owned state. Workspace cleanup never deletes an entry merely because its current views finished.

For `permissions: read-only`, a package-owned, protected prepared checkout is separate from the immutable seed and may be shared by matching setup-free rows. Its allocated bytes count toward the same cache ceiling; live row leases block pruning, and a seed lease stays held whenever the prepared checkout still depends on seed blocks. Each row owns contained private scratch and a recoverable lease through assertions. Unexpected mutation invalidates the prepared checkout rather than resetting it in place; no subsequent row receives it. File-change capture excludes package-owned scratch. Cooperative file modes do not protect against a deliberate same-UID process changing permissions.

Cross-process per-digest mutation locks serialize preparation, lease publication, lease release, and entry mutation. Creating a view records a lease containing provider-root identity and a process identity resistant to PID reuse. A dead owner does not make a seed evictable: later provider construction must recover and unmount the dependent workspace before releasing its lease. Eviction validates the ownership marker and containment, rechecks that no lease record remains, and atomically renames the entry to package-owned trash before deletion.

The 50 GiB allocated-size ceiling is cache-wide. A separate cache-wide admission lock serializes the usage snapshot, LRU selection, candidate eviction, capacity decision, and atomic publication of every newly staged seed. Operations needing both lock scopes always acquire the admission lock first and then per-digest locks in sorted digest order. Preparation may hold one per-digest lock while staging, but releases it before entering admission and rechecks the entry after reacquiring locks in canonical order. This prevents both cross-digest over-admission and lock cycles.

Initial automatic policy also includes a 30-day unused-age limit. Before publishing a new seed, admission evicts unleased least-recently-used entries until the measured staged entry fits or returns a bounded capacity error. Provider construction and `Provider.cleanup()` run opportunistic collection; failure is a bounded warning and does not replace an evaluation result.

`allagents-promptfoo cache prune` applies the default policy and returns nonzero on failure. `cache prune --all` removes every unleased entry. Both report entries and allocated bytes removed and retained. Neither follows cache symlinks, removes a leased entry, inspects Promptfoo output, or touches provider runtime roots.

### Checkout adapter interface

Checkout mechanics remain behind one small internal interface:

```ts
interface CheckoutAdapter {
  probe(seed: string, runtimeRoot: string): Promise<ProbeResult>;
  create(seed: string, checkout: string): Promise<WorkspaceLease>;
  release(lease: WorkspaceLease): Promise<void>;
  recover(record: RecoveryRecord): Promise<void>;
}
```

There are three real adapters:

1. reflink/clone (copy-on-write) using verified filesystem primitives, with ordinary file permissions but requiring a supporting filesystem;
2. overlay (copy-on-write) using an immutable lower layer and private upper/work directories, with mount privileges or a narrowly privileged mount/unmount helper where unprivileged mounting is unavailable; and
3. recursive full copy (not copy-on-write) as a disk-admitted correctness fallback requiring ordinary file read/write access.

Select in that order. Startup probes create throwaway views, mutate them, and prove seed and sibling bytes remain unchanged. An overlay probe must run in the provider/delegate's mount namespace; an isolated privileged namespace is insufficient. Only probes whose state is fully cleaned may fall through; an unknown mount or failed detach blocks fallback. Copy admission must account for a conservative full-copy estimate per retained view, current free space, headroom, and concurrent admissions; reject before a copy that cannot fit. It may be used for smaller workloads, but never silently replace CoW for CargoWise-scale writable evaluation.

A plain symlink, writable bind mount, or writable hardlink never satisfies this interface. Those mechanisms expose shared inodes and violate row isolation.

Reflink and overlay allocation should approach one seed plus changed blocks even with a thousand mostly unchanged views. Recursive copy may allocate the full multi-gigabyte seed per row. The selected adapter stays implementation metadata and does not alter provider configuration.

On the actual WTG.AI.Prompts `wtg-use-linux-x64` runner, neither reflinks nor unprivileged OverlayFS mounts work. An initial `sudo` benchmark used a private mount namespace whose views were invisible to the parent provider process. A follow-up direct `sudo mount` in the job's namespace was visible and writable to an ordinary Node process, so a provider running as that user can use the mounted view **after privileged setup**. This still requires a separately designed, narrowly privileged mount/unmount lifecycle with validated paths, recovery records, and tests of the actual provider and delegate; do not silently invoke unrestricted `sudo` from the provider or count the filesystem probes as a completed rollout gate.

### Tracing and assertion compatibility

The delegate child receives incoming `traceparent` and `tracestate` and exports normalized agent spans through explicit OpenTelemetry configuration. The wrapper preserves trace identity and tool attributes required by:

- `trajectory:tool-used`;
- `trajectory:tool-args-match`;
- `trajectory:tool-sequence`; and
- `trajectory:step-count`.

Normal output assertions consume unchanged delegate output. JavaScript assertions can inspect `context.providerResponse.metadata.workspace.path`; file-change-aware assertions use `metadata.fileChanges` when enabled. There is no second assertion engine.

### Runtime requirements

- Node.js 22.22.0 or newer.
- Linux and macOS; each checkout adapter is enabled only by a successful capability probe.
- Bun 1.4 for repository development and publishing.
- `promptfoo` peer lower bound is the first version passing package, response, assertion, tracing, cache, and cleanup compatibility tests.
- `@github/copilot-sdk: "1.0.6"` is an optional peer and exact development dependency.
- OCI materialization uses a runtime-supplied ORAS 1.x executable.
- Workspace delegates receive `bustCache: true`; `cached: true` fails closed.

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
│   │   │   ├── seed-cache.ts
│   │   │   ├── cache-gc.ts
│   │   │   ├── cache-lock.ts
│   │   │   ├── checkout.ts
│   │   │   ├── file-changes.ts
│   │   │   ├── adapters/
│   │   │   │   ├── reflink.ts
│   │   │   │   ├── overlay.ts
│   │   │   │   └── copy.ts
│   │   │   ├── sources/git.ts
│   │   │   └── sources/oci.ts
│   │   └── package.json
│   └── promptfoo-integration/
│       ├── src/
│       │   ├── provider.ts
│       │   ├── config.ts
│       │   ├── metadata.ts
│       │   ├── delegate-runner.ts
│       │   ├── cli.ts
│       │   ├── delegates/
│       │   │   ├── adapter.ts
│       │   │   ├── codex.ts
│       │   │   ├── claude.ts
│       │   │   └── copilot.ts
│       │   └── copilot/
│       │       ├── provider.ts
│       │       ├── runner.ts
│       │       ├── protocol.ts
│       │       ├── tracing.ts
│       │       └── redaction.ts
│       └── package.json
├── examples/
│   ├── codex/
│   ├── claude/
│   ├── copilot/
│   └── git-and-oci-workspace/
├── scripts/
│   ├── build.ts
│   ├── smoke-packed-package.ts
│   └── publish.ts
├── package.json
├── tsconfig.json
├── biome.json
└── bun.lock
```

`packages/workspace-core` is private. Its runtime and declarations are bundled into the public package.

## Phase 0: Repository and package foundation

### Changes

1. Create private workspace-core and public promptfoo-integration packages.
2. Configure Promptfoo as a peer and Copilot SDK as optional peer plus exact development dependency.
3. Pin Bun and Node; configure strict TypeScript, Biome, Bun tests, dual ESM/CommonJS builds, and the cache-maintenance bin.
4. Bundle workspace core while externalizing both peers.
5. Add Changesets, build/typecheck/lint/test/pack commands, validation CI, packed-package smoke tests, trusted publishing, and dependency update automation.
6. Confirm maintainers control the `@allagents` npm scope.

### Verification

- Clean install and all root commands pass.
- Packed tarball contains runtime, declarations, license, package metadata, README, and one executable only.
- Temporary npm, pnpm, and Bun consumers load both provider exports and invoke `allagents-promptfoo --help`.
- No private workspace package appears in emitted imports or the public manifest.

## Phase 1: Configuration and containment

### Changes

Implement the exact closed schemas and runtime-channel validation.

Reject absolute, empty, dot-segment, drive-letter, UNC, duplicate, overlapping, or escaping destinations; unsupported repository schemes; credential-bearing URLs; malformed OCI digests; unknown keys; excessive sources; excessive limits; overlapping workspace/cache roots; and reserved runtime variables in delegate config.

Canonical request JSON single-flights mutable ref/tag resolution. SHA-256 over RFC 8785 canonical resolved-source JSON becomes the seed key.

### Verification

- Table tests cover POSIX/Windows forms, Unicode normalization, overlap order, URL user-info, malformed digests, unknown fields, and canonicalization.
- `workspace.permissions` rejects unknown values, defaults to `all`, remains fixed for each labeled provider instance, and cannot be changed by prompt/test overrides.
- Prompt overrides cannot replace workspace, fileChanges, timeout, environment, delegate identity, working directory, or cache behavior.
- Unmarked, symlinked, nested, or overlapping configured roots fail before acquisition.

## Phase 2: Git materialization

### Changes

Implement Git acquisition without a shell:

1. private staging and subprocess-only askpass helper;
2. noninteractive clone/fetch;
3. resolve requested ref to an immutable commit;
4. detached checkout at destination;
5. remove helper, remotes, temporary refs, and acquisition state;
6. reject submodules;
7. validate realpath containment; and
8. atomically publish only the complete workspace seed.

The **consumer**, not the generic provider, owns source resolution. WTG.AI.Prompts evals already reference workspace YAML (for example, `workspace: ../.templates/eval-workspace-2026.yaml`); the template names `repos[].repo`, `repos[].commit`, and an environment-expanded `path`. A consumer adapter can read those pins and produce the provider's existing Git-source descriptors without adding AgentV YAML, its `hooks`, or release-specific fields to the provider interface. A template containing only a remote Git URL and commit does **not** remove the need for acquisition: without a release/image resolver it uses the provider's ordinary authenticated Git source.

To use release artifacts rather than remote Git, keep `repo + commit` → snapshot chunk / OCI image lookup in the consumer, following [ai-evals' repository resolver](https://github.com/WiseTechGlobal/ai-evals/blob/d42496bc03c57bc640cd768cfc7ea90b46ed2158/apps/aievals/src/environment/repository-resolver.ts). WTG.AI.Prompts already maps pinned commits through `CargoWise.manifest.txt` to yearly `.git` release assets; the consumer may stage one as a local Git repository and pass a verified `file://` URL plus immutable commit, or pass an OCI image by digest if it has an image resolver. The provider prepares and validates its own immutable seed; the existing shared checkout symlinks remain read-only and cannot serve as private writable views. Do not implement a second release resolver inside the provider.

### Verification

- Mutable refs resolve once and record commits.
- Invalid refs, submodules, symlink escapes, cancellation, and failure publish no seed.
- Credentials reach only Git and are absent from metadata, errors, logs, traces, and delegates.
- Source repositories cannot be mutated through the seed.

## Phase 3: OCI materialization

### Changes

Implement an `OciMaterializer` adapter invoking ORAS 1.x without a shell. Resolve tags to digests, pull digest-qualified references, accept bounded uncompressed regular-file layers with validated relative titles, and reject archives, compression, special files, escaping links, duplicate titles, and size overflow.

Copy registry auth to a private mode-`0600` file for each acquisition and delete it in `finally`.

### Verification

- Disposable registry fixture serves a valid pinned artifact.
- Digest mismatch, malicious titles, unsupported layouts, overflow, timeout, cancellation, and authentication failure publish no seed.
- Overflow rejects before payload download.
- Registry credentials reach neither delegate nor result.

## Phase 4: Persistent seed cache

### Changes

Implement the shared immutable cache and lease-aware garbage collection.

- Resolve the default platform cache path and validate optional `ALLAGENTS_CACHE_ROOT`.
- Key entries by resolved manifest digest and verify package ownership, schema, content integrity, and containment.
- Serialize preparation and lease changes through stale-safe per-digest locks.
- Stage complete seeds before cache admission and measure allocated bytes.
- Serialize the cache-wide size snapshot, LRU selection, eviction, capacity decision, and atomic publication through one admission lock.
- Enforce canonical lock ordering: admission lock first, then per-digest locks sorted by digest; release a preparation lock before admission and recheck after reacquisition.
- Single-flight equivalent preparation across processes and atomically publish complete seeds.
- Evict failed preparation state for retry.
- Keep immutable seed content read-only and never expose the seed itself to delegates.
- Create a live seed lease only after a pending workspace recovery record exists.
- Prepare one separate protected read-only checkout for identical setup-free manifests; charge its allocated bytes to the cache ceiling, hold row leases through assertions, and preserve any seed lease needed by its backing blocks.
- Enforce 50 GiB allocated size and 30 days unused age; evict unleased LRU entries only.
- Implement `cache prune` and `cache prune --all` with bounded reporting and explicit nonzero failure.
- Make lease release and trash deletion idempotent and containment-checked.

### Verification

- The same resolved manifest reuses one seed across concurrent processes, provider instances, and sequential evaluations.
- Matching read-only rows reuse the protected checkout, retain distinct private scratch and leases, and block cache prune while any lease is live; the immutable seed is never the delegate's working directory.
- Every lease record blocks age, size, default-prune, and `--all` eviction.
- Dead-owner lease records continue to block pruning until workspace recovery releases them; concurrent acquire-versus-prune cannot delete an acquired seed.
- LRU size eviction, 30-day age eviction, capacity exhaustion, corrupt ownership, symlink attacks, interrupted trash deletion, and retry are deterministic.
- Concurrent publication of different digests cannot jointly exceed the cache-wide ceiling.
- Admission-versus-prune and cross-digest eviction obey canonical lock order without deadlock.
- Workspace cleanup releases leases without deleting the seed.
- A later evaluation uses the cached seed without reacquisition.
- `cache prune` never starts Promptfoo or touches provider runtime roots.
- GitHub-hosted tests make no cross-job persistence assumption unless the cache root is explicitly restored.

## Phase 5: Checkout adapters and runtime roots

### Changes

Implement the three checkout adapters and ownership-marked provider roots.

- Give every writable view a unique ID and private state.
- Require reflink and overlay adapters to pass write-isolation probes before selection.
- Keep recursive copy as a correctness fallback when the projected full per-row allocation fits available disk, including already retained views and concurrent copy admissions; fail explicitly before an unaffordable copy rather than exhausting the runner.
- Implement and verify a narrowly privileged OverlayFS mount/unmount lifecycle on `wtg-use-linux-x64`, with mounts visible to the provider and delegate, path containment, teardown records, and crash recovery. If it or reflink is unavailable, try bounded copy for affordable writable workloads. CargoWise-scale **writable** rollout still requires a working CoW adapter on that runner; a recursive-copy result or an isolated mount-namespace probe does not clear the gate.
- Implement `permissions: read-only` as an explicit alternative for setup-free rows: use a separate package-owned protected checkout, row-private scratch and leases, and cooperative file-mode protection as in [ai-evals' read-only contract](https://github.com/WiseTechGlobal/ai-evals/blob/d42496bc03c57bc640cd768cfc7ea90b46ed2158/docs/adr/0006-use-test-scoped-workspaces-for-coding-agent-evaluations.md#read-only-workspaces). A workspace-changing setup must be prepared in the immutable source or use a private `all` view; do not silently switch a writable evaluation to read-only. Detect unexpected changes, invalidate the prepared checkout, and fail rather than reset it in place; same-UID bypass remains outside the security guarantee.
- Reject symlink and hardlink sharing of writable content, and writable bind sharing of a seed. The protected read-only checkout is never the seed.
- Reserve the workspace ID and contained adapter paths, then atomically publish a pending recovery record before creating a lease, inode tree, or mount.
- Require each adapter to persist enough teardown state before every irreversible resource-creation step and transition the record to active only after the view is complete.
- Make view release, unmount, root removal, and stale recovery idempotent and containment-checked.
- Reap only roots whose package marker is valid and whose process identity is no longer alive.
- Recover and detach an abandoned view before releasing its seed lease.

### Verification

- One thousand concurrent mostly unchanged **writable** views share one seed and expose distinct paths.
- Mutating any file, metadata bit, symlink, or Git state in one writable view changes neither seed nor sibling.
- Reflink tests compare physical allocation and inode independence.
- Overlay tests prove provider/delegate-visible mounts, ordinary-user reads and private writes, private upper/work directories, controlled privileged setup, correct unmount ordering, and no sibling visibility; forced termination and failed unmount retain the recovery record and seed lease.
- Recursive-copy tests document full allocation cost, select it when CoW probes fail and space permits, and reject under concurrent disk pressure before copying when the per-view reserve cannot fit.
- Matching read-only rows share one protected checkout without per-row full copies or OverlayFS, receive private scratch and leases, and reject ordinary file/Git writes; setup-changing rows are not shared. A changed checkout is invalidated and never reused; same-UID `chmod` is documented as outside the guardrail.
- A 2 GiB sparse/fixture seed scale test records allocated blocks for the seed plus one thousand views and enforces adapter-specific ceilings.
- On WTG.AI.Prompts' actual `wtg-use-linux-x64` evaluation runner, materialize CargoWise commit `769187bbb4d2f2add3fe11131ce3aedc696145f0` from [ai-evals' representative proof](https://github.com/WiseTechGlobal/ai-evals/blob/d42496bc03c57bc640cd768cfc7ea90b46ed2158/docs/solutions/architecture-patterns/measuring-representative-workspace-costs.md): 245,828 files and 1,814,049,455 logical bytes. Prove that two concurrent writable views select a working copy-on-write adapter and share unchanged blocks while writes remain private. The existing sparse 2 GiB fixture does not replace this real-tree proof.
- Report the selected adapter, seed acquisition time, per-view preparation time, allocated disk space, optional file-change baseline time, and cleanup time separately on that runner. The ai-evals timings were measured on an ext4 VPS, not GitHub Actions, and did not exercise overlay; they are not CI performance guarantees.
- A failed capability probe selects the next safe adapter only after complete cleanup; a failed unmount or unknown mount blocks fallback.
- Live, unmarked, escaping, symlinked, incompatible, and unknown-mount roots are never reaped.
- Dead-owner recovery handles PID reuse, unmounts overlay views before lease release, and never exposes a lower-layer deletion race.
- Process death at every boundary from pending-record publication through active-view transition leaves a recoverable record and no unknown mount.
- A failed detach retains both recovery record and seed lease; other workspace teardown chains still complete.

**Runner evidence (2026-09-29):** [WTG.AI.Prompts Actions run 36551124238](https://github.com/WiseTechGlobal/WTG.AI.Prompts/actions/runs/36551124238) used `wtg-use-linux-x64` (Ubuntu 24.04, ext-family filesystem, ~17.95 GB free), fetched and checked out the fixed 245,828-file / 1,814,049,455-logical-byte commit, and tested two concurrent views. Reflink returned `EOPNOTSUPP`; unprivileged OverlayFS mount returned “must be superuser”; privileged OverlayFS mounted inside an isolated namespace. Git fetch took 5,424 ms and checkout 206,687 ms. Two privileged OverlayFS views mounted in 6 ms and allocated 40,960 observed bytes; changing one file and running `git add` took 588 ms and allocated another 47,050,752 observed bytes. Seed and sibling file contents and Git status stayed unchanged; view unmount/removal took 1,359 ms. Free-space deltas are whole-filesystem observations, not exclusive accounting. The experiment ran all view operations inside the privileged namespace and did not exercise the future provider, so the writable rollout gate remains blocked. The current `snapshot/v1.1.0` CargoWise manifest does not include this older benchmark commit; release-backed acquisition should be tested separately with a mapped commit and cannot substitute for view isolation.

**Provider-process visibility (2026-09-29):** [WTG.AI.Prompts Actions run 36553859211](https://github.com/WiseTechGlobal/WTG.AI.Prompts/actions/runs/36553859211) directly mounted a small OverlayFS view with `sudo` in the job's mount namespace. A separate unprivileged Node child (UID 1001, same namespace) saw the mount, read the lower-layer file, changed it, created a new file, and staged both with Git. The seed's file contents and Git status remained unchanged. `sudo umount` and deletion of the probe-owned directories completed. This proves visibility and ordinary-process write access on the target runner, not the safety or crash recovery of a production privilege helper.

## Phase 6: Optional file changes

### Changes

When enabled, establish immutable baselines while the view is clean and capture after delegate cleanup.

Git sources use package-owned private indexes and explicit commits with replacement objects, ambient config, external diff, filesystem monitors, untracked caches, and optional locks disabled. Never write the checkout's real index, refs, or remotes. Freeze baseline ignore rules before execution. OCI sources reuse verified inventories. A bounded contained walk finds additions outside source destinations.

Open candidates without following symlinks; require stable pre/post metadata; encode exact bytes; generate one bounded unified diff; normalize and sort paths; and emit complete, truncated, or failed status.

### Verification

- Add, modify, delete, rename, binary, executable, symlink, ignored, committed, staged, replacement-ref, and outside-source cases.
- Exact binary round-trip through base64.
- Unified diff includes bounded text adds/modifications/deletions.
- Every time/path/file/byte/diff/subprocess/omitted/metadata limit produces deterministic status.
- Disabled capture performs no baseline work and omits `metadata.fileChanges`.
- Collector changes neither the real checkout Git state nor any seed/sibling.

## Phase 7: Copilot SDK provider

### Changes

Implement the public-SDK-based provider with separate parent and runner responsibilities.

The parent validates config and working directory, spawns a minimal-environment process group, owns timeout/cancellation/termination/protocol/redaction/tracing, and returns Promptfoo-native response fields.

The runner validates before dynamic import, creates one client/session, normalizes SDK events, extracts final text and usage, disconnects, stops or force-stops the client, and emits one terminal frame after cleanup.

### Verification

- Fake runner covers success, SDK error, malformed protocol, timeout, cancellation, escalation, large output, and redaction.
- Packed project loads direct Copilot with the exact optional peer.
- Missing peer is actionable.
- Skill support remains disabled until public SDK events provide reliable normalized identity.

## Phase 8: Delegate protocol and compatibility

### Changes

Implement the closed Codex, Claude, and Copilot adapters and versioned JSON-lines runner protocol.

The parent sends one call and optional abort. The child rejects unknown/duplicate frames and emits one terminal response after native cleanup. Bound frames, complete response, stderr, and shutdown grace.

Resolve native providers from trusted `basePath`; send only JSON-safe prompt/context fields; use minimal environment; bind workspace and cache bypass at final precedence; and preserve every JSON-safe response field and native metadata key.

### Verification

- Same fake task through all adapters.
- Reserved paths, sessions, environment inheritance, cache controls, acquisition channels, and unknown keys rejected.
- Function-backed prompts and live provider objects do not cross serialization.
- Timeout/cancellation leave no runner descendants.
- Direct-versus-wrapped fixtures compare output, errors, usage/cost, raw/public fields, metadata, `skillCalls`, and tracing identity.

## Phase 9: Workspace provider integration and cleanup

### Changes

Constructor responsibilities:

- validate exact config and trusted base path;
- resolve fixed runtime channels;
- create one ownership-marked provider runtime root;
- connect to the shared seed cache and initialize checkout adapter selection;
- reject recursive/unsupported delegates and reserved fields;
- reap safely abandoned provider roots; and
- run opportunistic cache garbage collection without turning cleanup warnings into evaluation failures.

For each `callApi`:

1. honor pre-abort;
2. resolve and validate the immutable seed entry without creating a view;
3. reserve an opaque workspace ID and contained adapter paths, then atomically publish a pending recovery record;
4. acquire the seed lease and either create a private writable view or acquire a protected shared read-only checkout with row-private scratch, persisting teardown state before each irreversible step;
5. transition the recovery record to active and optionally establish a change baseline;
6. run and quiesce the delegate;
7. validate the complete response and reject reserved metadata collisions;
8. optionally capture file changes;
9. add `metadata.workspace` and optional `metadata.fileChanges` while preserving native metadata; and
10. return without releasing the row's workspace lease.

On pre-publication failure, run the recorded teardown chain immediately; release the seed lease only after adapter detachment or read-only scratch release succeeds, otherwise retain the pending record and lease for later recovery. On success, `Provider.cleanup()` owns normal release. No delayed timer or later provider call guesses when assertions have finished. If Promptfoo skips cleanup, later process recovery owns the abandoned root and its leases.

### Verification

- JavaScript assertions read and modify known files through each returned **writable** workspace path.
- Parallel writable rows receive isolated paths and mutations; matching read-only rows may share one protected path but not row scratch or leases.
- Workspace exists for passing, failing, asynchronous, model-graded, and trajectory assertions.
- Every response reports `cleanup: "best-effort-evaluation"`.
- Provider cleanup removes every successfully detached private view or released read-only row scratch and retains any failed record with its lease.
- Cleanup never deletes the reusable seed or a protected checkout still leased by another read-only row.
- A Node evaluation that skips cleanup leaves a marked root; a later process releases it and its leases without reaping a live reader.
- Live same-process roots are never reaped.
- Failure before or during view creation is recovered from the pending record; no lease or mount can exist without teardown intent.
- A failed overlay unmount keeps its seed lease while independent views still clean up.
- Sequential provider instances reuse the same resolved seed.
- Native skill metadata stays top-level; reserved collisions fail before publication.
- Optional file changes are absent when disabled and durable when enabled.
- Read-only provider labels and `defaultTest.providers` / `tests[].providers` run only the selected mode; a missing filter demonstrably runs both, and prompt variables cannot elevate `read-only` to `all`.
- Read-only assertions can inspect the protected checkout; ordinary writes fail, package scratch is excluded from optional file changes, and unexpected baseline mutation invalidates reuse rather than triggering an in-place restore.

## Phase 10: Examples and Promptfoo compatibility

### Changes

Add executable examples for:

- direct Copilot with an existing directory;
- Codex with a Git workspace and JavaScript filesystem assertion;
- Claude with optional file-change assertion;
- Copilot with Git and OCI sources;
- mixed read-only and writable tests selecting labeled provider configurations;
- one thousand parallel rows using copy-on-write views; and
- cache pruning on a long-lived self-hosted runner.

Every workspace example runs stock Promptfoo:

```bash
promptfoo eval --config promptfooconfig.yaml
```

Build a matrix for every supported Promptfoo minor covering package exports, workspace assertions, optional file changes, skills, trajectory assertions, provider cleanup, and skipped-cleanup recovery.

### Verification

- Examples import only packed/public package interfaces and contain no credentials.
- npm, pnpm, and Bun temporary projects resolve the consumer's Promptfoo peer correctly.
- Ordinary `contains`, `regex`, `is-json`, JavaScript, `llm-rubric`, `skill-used`, and `trajectory:*` assertions retain direct-provider behavior.
- Stock Promptfoo runs a default read-only test only against its read-only provider label and an overriding writable test only against its writable label.
- Multi-gigabyte scale example shows the selected adapter, allocated disk for one thousand views, best-effort view cleanup, and retained seed-cache size.
- GitHub-hosted example relies on runner disposal unless it explicitly saves the cache directory.
- Self-hosted example runs `allagents-promptfoo cache prune` before cache reporting or backup.

## Phase 11: Release

### Changes

1. Confirm npm scope and trusted publisher.
2. Publish release candidate under `next`.
3. Test packed and registry-installed projects with and without Copilot peer.
4. Exercise normal and skipped provider-cleanup paths.
5. Publish stable `1.0.0` with provenance.
6. Announce supported Promptfoo range, Node/Bun versions, ORAS requirement, explicit read-only permissions and cooperative limits, checkout adapters, recursive-copy cost, optional file-change bounds, best-effort workspace cleanup, persistent seed-cache policy, and `cache prune`.

### Verification

- npm provenance and manifest metadata are correct.
- Tarball contains the public runtime, declarations, and cache executable, without fixtures, credentials, or private paths.
- Fresh consumers prove both provider exports and cache CLI.

## Required quality gates

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test
bun run build
bun run pack:check
```

Release-candidate gates additionally cover:

- stock-Promptfoo package and assertion compatibility;
- normal and skipped provider-cleanup behavior;
- stale-root and seed-lease recovery after forced process death;
- thousand-view copy-on-write isolation, 2 GiB allocated-space ceilings, and cross-evaluation seed reuse;
- explicit read-only provider selection, protected setup-free checkout reuse with private scratch, mutation invalidation, cache accounting, and cleanup without deleting a live reader;
- On WTG.AI.Prompts' target `wtg-use-linux-x64` runner, the representative CargoWise-scale proof selects a provider-visible working copy-on-write adapter through the real mount lifecycle, demonstrates private writes and shared unchanged blocks, and reports phase timings and allocated disk use; a recursive-copy result does not clear the large-repo rollout gate.
- age/size/default/all cache pruning under concurrent leases;
- optional file-change exactness and bounds;
- Git provenance and OCI authentication against disposable fixtures;
- Copilot protocol/cancellation with fake runner; and
- credentialed provider smokes when organization secrets are available.

## Completion criteria

- Stock Promptfoo loads both provider exports from the published package.
- Git and OCI inputs produce immutable provenance and one persistent cached seed per resolved manifest.
- One thousand private reflink/overlay views share immutable blocks without sharing writable state; recursive copy remains a correct, disk-admitted fallback for affordable workloads and fails explicitly when admission cannot fit.
- CargoWise-scale **writable** rollout on the target runner requires proven provider-visible copy-on-write; without it, that rollout is blocked even if a smaller job can use recursive copy. Explicit `permissions: read-only` permits setup-free read-only evaluations to share a protected prepared checkout without claiming writable isolation.
- Workspace paths remain available through Promptfoo assertions.
- Best-effort provider cleanup and safe later stale-root recovery are explicit and verified.
- Workspace cleanup removes private writable views or read-only row scratch and releases leases without deleting reusable seeds or live shared checkouts.
- Automatic and explicit cache pruning remove only unleased entries under the locked age/size policy.
- GitHub-hosted runners require no cross-job cleanup unless the cache directory is explicitly persisted.
- Optional generated/deleted files and unified diff survive serialization when enabled and are absent when disabled.
- Complete native response, skill metadata, and agent trajectories survive wrapping.
- Credentials remain isolated and absent from results, logs, errors, and traces.
