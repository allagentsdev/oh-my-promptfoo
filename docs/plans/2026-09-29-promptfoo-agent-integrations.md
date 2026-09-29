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

The workspace provider must accept exact Git and OCI inputs, reuse one persistent immutable seed per resolved manifest across providers and evaluations, create a private writable workspace per call with each source either a private writable view or an explicitly requested protected shared read-only checkout, preserve the complete JSON-safe native delegate response, expose the private workspace at `metadata.workspace.path`, optionally capture durable changed-file contents at `metadata.fileChanges`, and rely on Promptfoo's best-effort provider cleanup without hiding that limitation.

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
  provider?: {
    type?: "openai" | "azure" | "anthropic";
    wireApi?: "completions" | "responses";
    baseUrl: string;
    apiKey?: string;
    wireModel?: string;
    azure?: { apiVersion?: string };
  };
  permissions?: {
    filesystem?: "read" | "write";
    shell?: "deny" | "allow";
    network?: "deny" | "allow";
  };
  env?: Record<string, string>;
}
```

All public objects reject unknown keys. Before public validation, constructors extract Promptfoo's loader-provided `basePath` into an internal envelope; users cannot set it through config.

Copilot's pinned [SDK `ProviderConfig`](https://github.com/github/copilot-sdk/blob/v1.0.6/nodejs/src/types.ts#L2377-L2490) requires an endpoint object for a custom provider, not a provider-name string. This is a closed JSON-safe subset: the runner passes these fields to the SDK session, rejects URL-embedded credentials and unknown keys, and redacts `apiKey` from protocol errors, traces, and results. The SDK's function-valued token provider, arbitrary headers, and experimental named providers remain outside this configuration.

Prompt-level config may override only fields under `delegate.config`. Workspace, file-change capture, timeout, environment, and delegate identity are constructor-only. The wrapper rejects reserved fields at every authored layer, validates the merged allowlist, and injects the absolute workspace path plus `bustCache: true` last. For Codex, it also forces `skip_git_repo_check: true`: the workspace root is not a Git repository even when it contains Git source destinations. This field is not author-configurable.

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
  permissions?: "all" | "read-only";
  ref: string;
  destination: string;
}

type OciSource = {
  type: "oci";
  repository: string;
  destination: string;
  permissions?: "all" | "read-only";
} & (
  | { digest: `sha256:${string}`; tag?: never }
  | { tag: string; digest?: never }
);
```

Destinations are relative, normalized, non-empty, non-overlapping, and cannot traverse or resolve outside the seed root. Package-created links to protected read-only checkouts are the only controlled source-destination exception in the private workspace; configured source symlinks remain containment-validated. Configuration contains no credentials or arbitrary acquisition commands. Git initially accepts `https://` and `file://`, rejecting SSH, Git, and credential-bearing URLs.

### Explicit read-only source selection

Each `workspace.sources[]` entry defaults to `permissions: all`: a private writable source view. `read-only` opts that source into a protected prepared checkout shared by matching rows, while **every row still receives a private writable workspace root**. There is no workspace-wide permission mode. The field is fixed in a provider configuration and cannot be overridden by prompt variables or test-level provider config. In stock Promptfoo, labeled provider instances plus [`defaultTest.providers` and `tests[].providers`](https://www.promptfoo.dev/docs/configuration/test-cases/#filtering-tests-by-provider) choose the source policy for each test:

```yaml
providers:
  - id: package:@allagents/promptfoo-integration:Provider
    label: project-readonly
    config:
      delegate:
        id: openai:codex-sdk
        config:
          sandbox_mode: workspace-write
      workspace:
        sources:
          - type: git
            repository: https://github.com/example/project.git
            ref: 0123456789abcdef0123456789abcdef01234567
            destination: project
            permissions: read-only
  - id: package:@allagents/promptfoo-integration:Provider
    label: project-writable
    config:
      delegate:
        id: openai:codex-sdk
        config:
          sandbox_mode: workspace-write
      workspace:
        sources:
          - type: git
            repository: https://github.com/example/project.git
            ref: 0123456789abcdef0123456789abcdef01234567
            destination: project
            permissions: all
defaultTest:
  providers: [project-readonly]
tests:
  - vars:
      task: Inspect the project and write notes outside its repository.
  - providers: [project-writable]
    vars:
      task: Fix the data transformation bug in the project.
```

Without `defaultTest.providers` or a test's own filter, Promptfoo runs the test against **both** provider configurations. The default filter selects a read-only **repository**, and the writable test overrides it. Both delegates can write to their own workspace outside `project`; ordinary writes through the protected source link fail. The row can remove that link because its workspace root is writable; doing so leaves the destination absent, without copying or modifying the shared checkout. Codex's native `sandbox_mode` applies to the whole working directory and cannot enforce a per-source restriction; it remains `workspace-write` here. Same-UID file modes are cooperative, not a hostile-agent security boundary. The consumer may resolve the Git pin to a release-backed source before provider execution; acquisition does not choose permissions.

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

`workspace.path` is absolute, private, and writable for every row; it remains available to transforms and assertions. A read-only source destination may link to a shared protected checkout whose real path and Git top-level are outside the workspace; no rows share `workspace.path`. Assertions inspect only expected configured destinations and files, not agent-supplied arbitrary paths, and do not reject package-created source links merely because their real path is outside the root. Promptfoo may skip provider cleanup; persisted results may therefore contain either a still-present transient path or a stale path removed by cleanup, later recovery, or host teardown. No consumer may treat it as a durable artifact reference.

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
2. detach every private writable source view, including required overlay unmounts, then remove row-owned references to protected read-only checkouts and the private workspace;
3. only after detachment succeeds, release its seed and protected-checkout leases; and
4. mark the recovery record released.

Teardown is all-settled across independent workspace chains, not across dependent steps inside one chain. A failed detach keeps that workspace's recovery record and leases for later recovery. Independent staging paths are removed; a protected source checkout still leased by another row is retained, and the provider root is removed only when no unreleased record remains. `cleanup()` returns an aggregate error after attempting every chain.

Promptfoo does not currently guarantee this hook on every path. A Node evaluation or some CLI failures may leave ownership-marked roots and leases until process exit. Later provider construction reaps only valid package-owned roots whose recorded process identity is no longer alive. It refuses live, unmarked, malformed, escaping, or unknown-mount paths. Same-process abandoned roots remain live until the process exits.

This is an explicit tradeoff, not a hidden guarantee. A thousand mostly unchanged copy-on-write workspaces are acceptable because they share seed blocks. Changed blocks, installed dependencies, recursive-copy fallback, and overlay mounts still consume resources, so stale-root recovery remains required on long-lived machines.

GitHub-hosted Actions runner disposal is the final cleanup backstop and prevents cross-job stale state. A workflow can reuse seeds only by saving and restoring the published immutable seed subtree with its verification metadata, not the entire cache root. The new runner validates those seeds, admits them under the cache-wide size ceiling before use, and creates fresh mutable state. Local and self-hosted runners keep their live cache and leases together; they must recover stale runtime roots before releasing leases and never restore a hosted snapshot over a live cache.

### Persistent seed-cache contract

The content-addressed seed cache is package-owned and outside every provider runtime root. It defaults to the platform cache directory; `ALLAGENTS_CACHE_ROOT` may select another contained root. Published immutable seeds and verification metadata occupy a separate subtree from package-owned mutable leases, protected checkouts, locks, staging, and trash. Entries are keyed by the resolved manifest digest. Workspace cleanup never deletes an entry merely because its current views finished.

For a source with `permissions: read-only`, a package-owned, protected prepared checkout is separate from the immutable seed and may be shared by matching rows without setup that changes that source. Its allocated bytes count toward the same cache ceiling; live row leases block pruning, and a seed lease stays held whenever the prepared checkout still depends on seed blocks. Each row owns a private writable workspace with package-created links to protected checkouts at their declared destinations. Unexpected mutation invalidates a shared checkout rather than resetting it in place; no subsequent row receives it. Optional file-change capture traverses the private workspace without treating package-created destination links as new source content, excludes package-owned control paths, and separately detects shared-checkout mutation. Cooperative file modes do not protect against a deliberate same-UID process changing permissions or replacing its own link.

Cross-process per-digest mutation locks serialize preparation, lease publication, lease release, and entry mutation. Creating a view records a lease containing provider-root identity and a process identity resistant to PID reuse. A dead owner does not make a seed evictable: later provider construction must recover and unmount the dependent workspace before releasing its lease. Eviction validates the ownership marker and containment, rechecks that no lease record remains, and atomically renames the entry to package-owned trash before deletion.

The 50 GiB allocated-size ceiling covers all package-owned cache data: published seeds, protected checkouts, staging, and trash awaiting deletion. The cache-wide admission lock is taken before starting either seed acquisition or protected-checkout preparation and held through publication or removal of incomplete output. The materializer reserves a bound on its full physical staging footprint before launching an external writer such as Git, or reserves room before each controlled write increment. It must enforce that bound on disk; measurement after an unconstrained subprocess exits is not sufficient. If the bound cannot be enforced or will not fit after evicting unleased LRU entries, acquisition fails before that write begins. Incomplete output is removed; failed removal remains charged. A completed candidate is measured and atomically published while admission is still held.

This serializes cache acquisition across digests, including network I/O, rather than allowing independent staging to exhaust disk before admission. Per-digest locks still protect lease and entry mutation. When both are needed, take admission first and then per-digest locks in sorted order; never acquire admission while holding a digest lock. Lease-only operations take their digest lock without admission. Both lock types are stale-safe, acquisition has a bounded timeout, and interrupted preparation is recovered before another admission. Automatic collection also removes entries unused for 30 days. Provider construction and `Provider.cleanup()` collect opportunistically; a failure is a bounded warning and does not replace an evaluation result.

`allagents-promptfoo cache prune` applies the default policy and returns nonzero on failure. `cache prune --all` removes every unleased entry. Both report entries and allocated bytes removed and retained. Neither follows cache symlinks, removes a leased entry, inspects Promptfoo output, or touches provider runtime roots.

### Checkout adapter interface

Writable source checkout mechanics remain behind one small internal interface; the private writable workspace and any protected source destinations are assembled around its views:

```ts
interface CheckoutAdapter {
  probe(seedSource: string, runtimeRoot: string): Promise<ProbeResult>;
  create(seedSource: string, destination: string): Promise<SourceViewLease>;
  release(lease: SourceViewLease): Promise<void>;
  recover(record: RecoveryRecord): Promise<void>;
}
```

There are three real adapters:

1. reflink/clone (copy-on-write) using verified filesystem primitives, with ordinary file permissions but requiring a supporting filesystem;
2. overlay (copy-on-write) using an immutable lower layer and private upper/work directories, with mount privileges or a narrowly privileged mount/unmount helper where unprivileged mounting is unavailable; and
3. recursive full copy (not copy-on-write) as a disk-admitted correctness fallback requiring ordinary file read/write access.

Select for each writable source in that order. Startup probes create throwaway views, mutate them, and prove seed and sibling bytes remain unchanged. An overlay probe must run in the provider/delegate's mount namespace; an isolated privileged namespace is insufficient. Only probes whose state is fully cleaned may fall through; an unknown mount or failed detach blocks fallback. Copy admission must account for a conservative full-copy estimate per retained writable source view, current free space, headroom, and concurrent admissions; reject before a copy that cannot fit. It may be used for smaller workloads, but never silently replace CoW for a large private repository.

A plain symlink, writable bind mount, or writable hardlink never satisfies this interface. Those mechanisms expose shared inodes and violate row isolation.

Reflink and overlay allocation should approach one seed plus changed blocks and any protected read-only source checkouts even with a thousand mostly unchanged writable views. Recursive copy may allocate a full multi-gigabyte source per row. The selected adapter stays implementation metadata and does not alter provider configuration.

The target private runner requires privileged OverlayFS mounting. A mount in an isolated namespace is invisible to the provider; the mount must be visible in the provider/delegate's namespace. A narrowly privileged mount/unmount lifecycle requires validated paths, recovery records, and tests of the actual provider and delegate. Filesystem probes alone do not clear the private rollout gate. Runner-specific evidence is retained in the private `allagents-research` repository.

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

Canonical acquisition request JSON (excluding source permissions) single-flights mutable ref/tag resolution. SHA-256 over RFC 8785 canonical resolved-source acquisition identities and destinations becomes the seed key; per-source `permissions` is excluded so read-only and writable provider configurations reuse the same immutable seed.

### Verification

- Table tests cover POSIX/Windows forms, Unicode normalization, overlap order, URL user-info, malformed digests, unknown fields, and canonicalization.
- `workspace.sources[].permissions` rejects unknown values, defaults each source to `all`, remains fixed for each labeled provider instance, and cannot be changed by prompt/test overrides; `workspace.permissions` is rejected.
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

Git writes into capacity-controlled staging. Reserve and enforce its physical footprint before launching Git, in addition to the configured download and extracted-content limits. If this cannot be enforced on the current filesystem, fail before acquisition rather than letting an unconstrained child fill the cache or host disk.

The **consumer**, not the generic provider, owns source resolution. A consumer adapter can read pinned repository descriptors and produce the provider's existing Git-source descriptors without adding consumer-specific YAML or release-specific fields to the provider interface. A template containing only a remote Git URL and commit does **not** remove the need for acquisition: without a release/image resolver it uses the provider's ordinary authenticated Git source.

To use release artifacts rather than remote Git, keep `repo + commit` → snapshot chunk / OCI image lookup in the consumer. The consumer may stage a verified release asset as a local Git repository and pass a `file://` URL plus immutable commit, or pass an OCI image by digest if it has an image resolver. The provider prepares and validates its own immutable seed; shared checkout symlinks cannot serve as private writable views. Do not implement a second release resolver inside the provider. Private release mappings and source identifiers are retained in `allagents-research`.

### Verification

- Mutable refs resolve once and record commits.
- Invalid refs, submodules, symlink escapes, cancellation, and failure publish no seed.
- Credentials reach only Git and are absent from metadata, errors, logs, traces, and delegates.
- Source repositories cannot be mutated through the seed.
- An external Git writer cannot exceed its reserved staging footprint; an unavailable physical write bound fails before launch, and cancellation or an over-limit write publishes no seed.

## Phase 3: OCI materialization

### Changes

Implement an `OciMaterializer` adapter invoking ORAS 1.x without a shell. Resolve tags once to a digest. Fetch the manifest by digest with bounded stdout, check its digest and supported media type, and validate every file descriptor's digest, declared size, uncompressed regular-file media type, unique contained title, and aggregate declared bytes against `maxDownloadBytes` and `maxExtractedBytes` **before fetching any blob**. Reject archives, compression, special files, escaping links, and duplicate titles.

For each accepted descriptor, run [`oras blob fetch --output -`](https://oras.land/docs/commands/oras_blob_fetch/) against its digest and stream stdout into contained staging files. Count actual bytes across the manifest and all blobs while reading, stop and terminate the process if a descriptor or aggregate limit is exceeded, and verify exact descriptor size and SHA-256 digest before accepting each file. Do not use unbounded `oras pull`: its manifest knowledge alone does not limit in-flight bytes from a malformed registry. Materialization also obeys the cache's physical staging reservation.

Copy registry auth to a private mode-`0600` file for each acquisition and delete it in `finally`.

### Verification

- Disposable registry fixture serves a valid pinned artifact.
- Digest mismatch, malicious titles, unsupported layouts, overflow, timeout, cancellation, and authentication failure publish no seed.
- Announced descriptor overflow rejects before any blob download; a lying registry that streams more than declared is stopped during download, publishes no seed, and leaves no reusable partial entry.
- Registry credentials reach neither delegate nor result.

## Phase 4: Persistent seed cache

### Changes

Implement the shared immutable cache and lease-aware garbage collection.

- Resolve the default platform cache path and validate optional `ALLAGENTS_CACHE_ROOT`.
- Key entries by resolved manifest digest and verify package ownership, schema, content integrity, and containment.
- Keep the published immutable seed subtree separate from all mutable cache state. A fresh hosted runner may restore only that subtree, validate ownership, schema, content and allocated size before use, evict unleased excess, and initialize new leases and checkouts. A live shared cache must retain its original leases and cannot be overwritten by a restored snapshot.
- Serialize preparation and lease changes through stale-safe per-digest locks.
- Take the cache-wide admission lock before staging either a seed or a protected checkout; hold it through capacity-controlled acquisition, final measurement, atomic publication, or removal of incomplete output.
- Count published seeds, protected checkouts, incomplete staging, and trash against the same 50 GiB allocated-size ceiling. Enforce a full reserved physical-footprint bound before each Git subprocess or other external writer starts, and reserve capacity ahead of each controlled write increment. Reject an unbounded writer or a bound that cannot fit after eviction; count failed cleanup until it succeeds.
- Enforce canonical lock ordering: admission first, then per-digest locks sorted by digest. Preparation is bounded and serializes distinct digests while holding admission; lease-only changes take their digest lock without admission.
- Single-flight equivalent preparation across processes and atomically publish complete seeds or protected checkouts.
- Evict failed preparation state for retry.
- Keep immutable seed content read-only and never expose the seed itself to delegates.
- Create a live seed lease only after a pending workspace recovery record exists.
- Prepare a protected read-only checkout per matching source identity from the immutable seed under the same capacity-controlled admission lock; hold row leases through assertions and preserve any seed lease needed by its backing blocks.
- Enforce 50 GiB allocated size and 30 days unused age; evict unleased LRU entries only.
- Implement `cache prune` and `cache prune --all` with bounded reporting and explicit nonzero failure.
- Make lease release and trash deletion idempotent and containment-checked.

### Verification

- Matching read-only source requests reuse protected source checkouts while retaining distinct writable workspace paths, row-owned destination links, and leases; they block cache prune while any lease is live. Read-only and writable configurations of identical sources reuse the same seed; the seed is never the delegate's working directory.
- A workspace with both access modes shares only its read-only source contents; mutable sources and generated files outside those destinations remain row-private.
- Every lease record blocks age, size, default-prune, and `--all` eviction.
- Dead-owner lease records continue to block pruning until workspace recovery releases them; concurrent acquire-versus-prune cannot delete an acquired seed.
- LRU size eviction, 30-day age eviction, capacity exhaustion, corrupt ownership, symlink attacks, interrupted trash deletion, and retry are deterministic.
- Concurrent seed and protected-checkout preparations, including different digests, cannot jointly exceed the ceiling through uncounted staging, trash, or publication; Git subprocess writes are demonstrably constrained to their reserved physical footprint rather than merely measured after exit.
- Admission-versus-prune and cross-digest lease changes obey canonical lock order without deadlock; bounded acquisitions and interrupted staging recover safely.
- Workspace cleanup releases leases without deleting the seed.
- A later evaluation uses the cached seed without reacquisition.
- `cache prune` never starts Promptfoo or touches provider runtime roots.
- On a fresh hosted runner, restore only published seeds and verification metadata after a job that skipped cleanup; a new provider accepts intact in-budget seeds, evicts excess, recreates local lease state, and can prune them after its own rows finish. Reject or reacquire a corrupt or incomplete seed. Restoring stale leases is prohibited; a live self-hosted cache still blocks prune until dependent roots are detached.

## Phase 5: Checkout adapters and runtime roots

### Changes

Implement the three checkout adapters and ownership-marked provider roots.

- Give every writable view a unique ID and private state.
- Require reflink and overlay adapters to pass write-isolation probes before selection.
- Keep recursive copy as a correctness fallback when the projected full per-row allocation fits available disk, including already retained views and concurrent copy admissions; fail explicitly before an unaffordable copy rather than exhausting the runner.
- Implement and verify a narrowly privileged OverlayFS mount/unmount lifecycle on the target private runner, with mounts visible to the provider and delegate, path containment, teardown records, and crash recovery. If it or reflink is unavailable, try bounded copy for affordable writable workloads. Large-repository **writable** rollout still requires a working CoW adapter on that runner; a recursive-copy result or an isolated mount-namespace probe does not clear the gate.
- Implement `permissions: read-only` per source: attach a separate package-owned protected checkout inside each private writable workspace via a row-owned destination link, and allow ordinary writes elsewhere in the workspace. Setup that changes the source must be prepared in the immutable source or use a private `all` source view. Detect unexpected shared-content mutation, invalidate the prepared checkout, and fail rather than reset it in place; same-UID bypass remains outside the security guarantee.
- Reject symlink and hardlink sharing of writable content, and writable bind sharing of a seed. Package-created links to protected read-only source checkouts never expose the seed.
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
- Matching read-only source rows share only protected source contents, not `metadata.workspace.path`, writable root files, scratch, or leases; ordinary source-file/Git writes fail while workspace-root writes succeed. Unlinking a row's source destination leaves it absent without copying or changing the shared checkout; a replacement is row-owned and visible to assertions as such. A changed shared checkout is invalidated and never reused; same-UID `chmod` is documented as outside the guardrail.
- A 2 GiB sparse/fixture seed scale test records allocated blocks for the seed plus one thousand views and enforces adapter-specific ceilings.
- On the target private evaluation runner, materialize the exact representative private commit specified in `allagents-research` from permitted release packages. Prove that two concurrent writable views select a working copy-on-write adapter and share unchanged blocks while writes remain private. The sparse 2 GiB fixture does not replace this real-tree proof.
- Report the selected adapter, seed acquisition time, per-view preparation time, allocated disk space, optional file-change baseline time, and cleanup time separately on that runner.
- A failed capability probe selects the next safe adapter only after complete cleanup; a failed unmount or unknown mount blocks fallback.
- Live, unmarked, escaping, symlinked, incompatible, and unknown-mount roots are never reaped.
- Dead-owner recovery handles PID reuse, unmounts overlay views before lease release, and never exposes a lower-layer deletion race.
- Process death at every boundary from pending-record publication through active-view transition leaves a recoverable record and no unknown mount.
- A failed detach retains both recovery record and seed lease; other workspace teardown chains still complete.

Private runner probes and provider integration runs are recorded in `allagents-research`. Those records distinguish namespace visibility checks from the production helper lifecycle and retain the exact private commit gate.

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
- A custom provider endpoint with `baseUrl` and `apiKey` reaches the pinned SDK as an object; an old string, missing endpoint, unknown fields, and leaked credentials fail the appropriate contract checks.

## Phase 8: Delegate protocol and compatibility

### Changes

Implement the closed Codex, Claude, and Copilot adapters and versioned JSON-lines runner protocol.

The parent sends one call and optional abort. The child rejects unknown/duplicate frames and emits one terminal response after native cleanup. Bound frames, complete response, stderr, and shutdown grace.

Resolve native providers from trusted `basePath`; send only JSON-safe prompt/context fields; use minimal environment; bind workspace, cache bypass, and Codex's required Git-root bypass at final precedence; and preserve every JSON-safe response field and native metadata key.

### Verification

- Same fake task through all adapters.
- Reserved paths, sessions, environment inheritance, cache controls, acquisition channels, and unknown keys rejected.
- Codex runs from a non-Git workspace root containing nested Git and OCI sources; its internal `skip_git_repo_check: true` cannot be overridden.
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
4. acquire the seed lease, create a private writable workspace, then attach each source as a private writable view or a reference to a protected shared read-only checkout, persisting teardown state before each irreversible step;
5. transition the recovery record to active and optionally establish a change baseline;
6. run and quiesce the delegate;
7. validate the complete response and reject reserved metadata collisions;
8. optionally capture file changes;
9. add `metadata.workspace` and optional `metadata.fileChanges` while preserving native metadata; and
10. return without releasing the row's workspace lease.

On pre-publication failure, run the recorded teardown chain immediately; release the seed lease only after adapter detachment or read-only scratch release succeeds, otherwise retain the pending record and lease for later recovery. On success, `Provider.cleanup()` owns normal release. No delayed timer or later provider call guesses when assertions have finished. If Promptfoo skips cleanup, later process recovery owns the abandoned root and its leases.

### Verification

- JavaScript assertions read and modify known files through every returned private writable workspace path, including rows whose source repository is protected.
- Codex examples run against a private workspace root without `.git`; nested source repositories remain accessible.
- Parallel rows always receive isolated workspace paths and writable root files; matching read-only sources may share protected contents but not writable source views, row links, or leases.
- Workspace exists for passing and failing assertions, asynchronous and model-graded assertions, and trajectory assertions.
- A valid delegate response with a top-level `error` fails the row without running assertions; the native error and diagnostic workspace metadata survive. Protocol failures before a valid response tear down recorded resources.
- Every returned valid delegate response reports `cleanup: "best-effort-evaluation"`; errors before a valid response are not published with a workspace path.
- Provider cleanup removes every successfully detached private workspace and releases its source leases, retaining any failed record with its lease.
- Cleanup never deletes the reusable seed or a protected source checkout still leased by another row.
- A Node evaluation that skips cleanup leaves a marked root; a later process releases it and its leases without reaping a live reader.
- Live same-process roots are never reaped.
- Failure before or during view creation is recovered from the pending record; no lease or mount can exist without teardown intent.
- A failed overlay unmount keeps its seed lease while independent views still clean up.
- Sequential provider instances reuse the same resolved seed.
- Native skill metadata stays top-level; reserved collisions fail before publication.
- Optional file changes are absent when disabled and durable when enabled.
- Source-read-only provider labels and `defaultTest.providers` / `tests[].providers` run only the selected source policy; a missing filter demonstrably runs both, and prompt variables cannot elevate a source's `read-only` to `all`.
- Assertions inspect configured source paths whose real path may be in the cache and can write elsewhere in their private workspace; ordinary source-file writes fail, package control paths are excluded from optional file changes, and unexpected shared-content mutation invalidates reuse rather than triggering an in-place restore.

## Phase 10: Examples and Promptfoo compatibility

### Changes

Add executable examples for:

- direct Copilot with an existing directory;
- Codex with a Git workspace and JavaScript filesystem assertion;
- Claude with optional file-change assertion;
- Copilot with Git and OCI sources;
- mixed source-read-only and source-writable tests selecting labeled provider configurations, including a writable workspace with both source types;
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
- Stock Promptfoo runs a default source-read-only test only against its protected-source provider label and an overriding source-writable test only against its writable-source label; both tests receive unique writable workspace paths.
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
6. Announce supported Promptfoo range, Node/Bun versions, ORAS requirement, per-source read-only permissions and cooperative limits, checkout adapters, recursive-copy cost, optional file-change bounds, best-effort workspace cleanup, persistent seed-cache policy, and `cache prune`.

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
- per-source read-only provider selection, private writable workspace paths with protected shared sources, mutation invalidation, cache accounting, and cleanup without deleting a live reader;
- On the target private runner, the exact representative large-repository proof selects a provider-visible working copy-on-write adapter through the real mount lifecycle, demonstrates private writes and shared unchanged blocks, and reports phase timings and allocated disk use; a recursive-copy result does not clear the large-repo rollout gate.
- age/size/default/all cache pruning under concurrent leases;
- optional file-change exactness and bounds;
- Git provenance and OCI authentication against disposable fixtures;
- Copilot protocol/cancellation with fake runner; and
- credentialed provider smokes when organization secrets are available.

## Completion criteria

- Stock Promptfoo loads both provider exports from the published package.
- Git and OCI inputs produce immutable provenance and one persistent cached seed per resolved manifest.
- One thousand private reflink/overlay views share immutable blocks without sharing writable state; recursive copy remains a correct, disk-admitted fallback for affordable workloads and fails explicitly when admission cannot fit.
- Large-repository **writable source** rollout on the target runner requires proven provider-visible copy-on-write; without it, that rollout is blocked even if a smaller job can use recursive copy. Explicit source `permissions: read-only` permits matching evaluations to share a protected repository checkout inside private writable workspaces without claiming writable source isolation.
- Workspace paths remain available through Promptfoo assertions.
- Best-effort provider cleanup and safe later stale-root recovery are explicit and verified.
- Workspace cleanup removes private writable roots and source views and releases leases without deleting reusable seeds or live protected source checkouts.
- Automatic and explicit cache pruning remove only unleased entries under the locked age/size policy.
- GitHub-hosted runners require no cross-job cleanup unless the cache directory is explicitly persisted.
- Optional generated/deleted files and unified diff survive serialization when enabled and are absent when disabled.
- Complete native response, skill metadata, and agent trajectories survive wrapping.
- Credentials remain isolated and absent from results, logs, errors, and traces.
