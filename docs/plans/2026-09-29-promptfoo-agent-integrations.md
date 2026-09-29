---
title: "Promptfoo agent integrations implementation plan"
date: 2026-09-29
type: feat
status: proposed
---

# Promptfoo agent integrations implementation plan

## Goal

Publish `@allagents/promptfoo-provider` from `allagentsdev/promptfoo-integrations`. The package exports:

- `Provider`, a workspace-owning provider that delegates to Promptfoo's Codex and Claude providers or the package's Copilot provider;
- `CopilotSdkProvider`, a lower-level provider that executes the public GitHub Copilot SDK in an existing working directory.

The workspace provider must accept exact Git and OCI workspace sources, create one private checkout per Promptfoo call, preserve native delegate results, expose each checkout through assertions, return bounded file-change metadata, and clean up at evaluation shutdown.

ADR 0001 is authoritative for package boundaries and terminology. `CONTEXT.md` defines the domain language used below.

## Non-goals

- A network execution service, queue, database, or remote artifact API.
- Reimplementing Promptfoo's Codex or Claude providers.
- A project-specific Promptfoo authoring compiler.
- Arbitrary delegate providers in the first release.
- Provider-owned scoring or replacement of Promptfoo assertions.
- A public workspace-core package before a second external consumer exists.
- Native npm package references for Promptfoo extensions before Promptfoo supports them.

## Locked contracts

### Provider references

```text
package:@allagents/promptfoo-provider:Provider
package:@allagents/promptfoo-provider:CopilotSdkProvider
```

`Provider` is both a named export and the default export. `CopilotSdkProvider` is a named export.

### Supported delegates

```text
openai:codex-sdk
anthropic:claude-agent-sdk
copilot-sdk
```

The workspace provider rejects itself, unknown delegate IDs, delegates without registered adapters, and any nested delegate `working_dir`.

The external config remains a closed discriminated union. Internally, each supported ID maps to one `DelegateAdapter` that validates its allowed config, binds the owned checkout at final precedence, loads the provider, and declares cleanup behavior. There is no generic fallback to `loadApiProvider`.

### Public provider configuration

`Provider` accepts one closed, versioned configuration:

```ts
interface ProviderConfig {
  delegate: CodexDelegate | ClaudeDelegate | CopilotDelegate;
  workspace: WorkspaceSpec;
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

All public config objects reject unknown keys. Before public validation, each provider constructor extracts Promptfoo's loader-injected `basePath` into an internal envelope; users cannot set or override it through prompt config. The initial release deliberately omits native-provider fields that enable extra directories, session reuse, settings/plugin discovery, executable overrides, arbitrary CLI/MCP passthroughs, process-environment inheritance, or function-valued hooks. Prompt-level config may override only fields under `delegate.config`; workspace, timeout, environment, and delegate identity are constructor-only. The wrapper merges that allowed override into constructor config, rejects reserved fields in either layer, validates the result, and injects the owned checkout path last.

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
      timeoutMs: 900000
```

Source credentials and executable paths are runtime inputs, resolved from provider `options.env` before `process.env`:

- `ALLAGENTS_GIT_USERNAME` and `ALLAGENTS_GIT_TOKEN`;
- `ALLAGENTS_ORAS_PATH`;
- `ALLAGENTS_ORAS_AUTH_FILE`; and
- optional `ALLAGENTS_WORKSPACE_ROOT`.

These names are reserved and rejected in `delegate.env` and every prompt-level delegate field. `ALLAGENTS_ORAS_AUTH_FILE` points to a Docker-compatible registry auth file; the materializer copies it to a private mode-`0600` file for each acquisition. Defaults and hard maxima for every source limit are exported constants and documented in the package README. File-change capture uses fixed internal limits rather than public provider configuration.

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

`workspace.path` is absolute and remains valid through Promptfoo assertions. It becomes invalid when the provider's evaluation-shutdown `cleanup()` completes and is not a durable artifact reference. [Promptfoo JavaScript assertion context](https://www.promptfoo.dev/docs/configuration/expected-outputs/javascript/#using-test-context) exposes `providerResponse`, including this path and `fileChanges`. Entries and truncation codes are lexically sorted and paths use normalized `/` separators. Summary counts describe returned entries, not unknown changes omitted by a limit. A truncated or failed change capture remains explicit but does not replace an otherwise valid delegate response. Delegate output, error, token usage, cached state, raw response, and existing metadata remain intact.

`manifestDigest` is SHA-256 over UTF-8 RFC 8785 canonical JSON containing schema version, Git and OCI materializer versions, and resolved sources sorted by normalized destination. Seed keys use this digest, not mutable requested refs or tags.

### Runtime requirements

- Node.js 22.22.0 or newer.
- Linux and macOS only in the initial release; package metadata rejects Windows because reliable process-tree termination depends on POSIX process groups.
- Bun 1.4 for repository development and publishing workflows.
- Promptfoo 0.122.0 is unsupported because it does not guarantee provider cleanup. The public package's `promptfoo` peer lower bound is the first upstream release that invokes every loaded provider cleanup from an outer `finally` with all-settled semantics; the upper bound is the next unverified minor, and the package never bundles Promptfoo.
- The package declares `@github/copilot-sdk: "1.0.6"` as an optional peer dependency and an exact development dependency. Selecting Copilot without installing the peer returns an actionable error; upgrades require protocol and live-smoke validation.
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
│   │   │   ├── file-changes.ts
│   │   │   ├── sources/git.ts
│   │   │   └── sources/oci.ts
│   │   └── package.json
│   └── provider/
│       ├── src/
│       │   ├── provider.ts
│       │   ├── config.ts
│       │   ├── metadata.ts
│       │   ├── delegate-runner.ts
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

`packages/workspace-core` has `"private": true`. Build output for `provider` bundles its runtime and declarations; it is never a published dependency.

## Phase 0: Promptfoo cleanup prerequisite

### Changes

Upstream a Promptfoo lifecycle fix before publishing this provider:

1. wrap both the Node `evaluate()` API and CLI evaluation path in an outer `finally` that runs after provider calls, transforms, and assertions;
2. invoke `cleanup()` on every loaded provider for successful scores, failed scores, thrown errors, and cancellation;
3. use all-settled cleanup and report one aggregate error only after every provider cleanup has been attempted;
4. ensure a cleanup failure cannot erase the original evaluation error; and
5. release the fix, then set the package peer lower bound and runtime version guard to that exact first verified release.

Process-exit hooks, stale-root reaping, and a happy-path-only cleanup loop do not satisfy this prerequisite. Promptfoo 0.122.0 remains explicitly unsupported.

### Verification

- Upstream tests cover CLI success, a below-threshold failed score, a provider exception, cancellation, and the Node `evaluate()` API.
- A multiple-provider test proves one rejecting cleanup does not skip later cleanups and preserves the original evaluation failure.
- The released npm package, not only an upstream branch, passes the same lifecycle matrix before its version becomes the peer lower bound.

## Phase 1: Repository and package foundation

### Changes

1. Create a Bun workspace root with the private workspace-core and public provider package directories.
2. Configure the public package with the first verified cleanup-safe Promptfoo release as its peer lower bound and `@github/copilot-sdk` as an optional peer dependency plus exact development dependency.
3. Pin Bun in `packageManager` and Node in `engines`.
4. Configure strict TypeScript, Biome, Bun tests, and dual ESM/CommonJS builds. Bundle workspace core into the provider package while externalizing both peers.
5. Add Changesets for package versions and release notes.
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
- `npm pack --dry-run` includes only declarations, runtime files, license, package metadata, and README.
- A clean npm smoke project installs and executes the tarball. Its manifest and emitted imports contain no private workspace package dependency; `promptfoo` and `@github/copilot-sdk` remain external peers.

## Phase 2: Workspace configuration and containment

### Changes

Implement `workspace-core/src/config.ts` with the exact closed schemas above for `WorkspaceSpec`, `GitSource`, `OciSource`, source limits, and runtime inputs.

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

- each `Provider` instance owns one seed pool, one request-resolution map, and all paths created beneath its private runtime root;
- concurrent calls for one canonical request share one resolution promise;
- the first successful commit/digest is pinned for that request until provider cleanup, even if the remote ref or tag moves;
- requests that resolve to one manifest share one seed preparation promise;
- failed resolution or preparation entries are removed so a later call may retry;
- completed seeds remain immutable for that provider instance's lifetime;
- each checkout uses a unique contained directory;
- checkout creation uses a verified reflink/copy-on-write clone when available and a recursive copy otherwise;
- hardlinks are prohibited;
- checkout release and provider cleanup are idempotent;
- successful calls retain their private checkouts until Promptfoo invokes provider `cleanup()` after assertions;
- the provider `cleanup()` hook aborts preparation, waits for in-flight calls, then removes every checkout, staging path, and seed it owns;
- provider construction reaps only versioned, ownership-marked runtime roots whose recorded process is no longer alive; and
- source acquisition abort and per-call abort are separate so cancellation of one row does not corrupt a seed used by another row.

### Verification

- Twenty concurrent checkouts share one seed preparation and receive distinct writable roots.
- Concurrent calls while a ref moves share the first resolution; later calls on that provider stay pinned, while a new provider instance resolves the new target.
- Mutation in one checkout does not change the seed or another checkout.
- Partial copies, cancellation, and process errors before response publication leave no published checkout.
- An ownership marker prevents cleanup or stale-root recovery from deleting paths not created by that provider.
- JavaScript assertions can read each response's distinct checkout path before cleanup; provider cleanup then removes every successful, failed, and cancelled call's owned paths and repeated cleanup is a no-op.

## Phase 6: Workspace file changes

### Changes

Implement `file-changes.ts` as bounded convenience metadata. It reports the final path-level delta and bounded before/after state without returning file contents, generating patches, or mutating the checkout's real Git index.

[Vercel's `agent-eval`](https://github.com/vercel-labs/agent-eval/blob/7e9aae4f7779f080af785ec88c17ef3c2ab3cebd/packages/agent-eval/src/lib/agents/shared.ts#L229-L276) demonstrates the baseline-and-delta idea by committing a clean fixture and capturing generated and deleted files after execution. Do not copy its `git add .` implementation for large repositories.

For every Git source:

1. create a package-owned temporary index while the checkout is still clean;
2. load the immutable source commit with `git read-tree`;
3. run `git update-index --refresh`, verify no baseline delta, freeze the baseline ignore view, and retain the private index unchanged through delegate execution;
4. run every collector Git command with replacement objects, external diff, file-system monitor, untracked cache, optional locks, and ambient Git configuration disabled;
5. after the delegate stops, discover tracked candidates with `git diff --name-only -z --no-ext-diff --no-renames --ignore-submodules=none <commit> --`;
6. discover all untracked candidates with `git ls-files --others -z`;
7. evaluate those candidates against ignore rules captured from the immutable baseline, not an agent-modified `.gitignore`;
8. read bounded before states from the exact commit and after states through contained no-follow file descriptors with stable pre/post metadata;
9. classify added, modified, deleted, and indeterminate states, then pair only exact bounded delete/add identities as renames;
10. record normalized workspace-relative paths, source destinations, statuses, bounded before/after states, exact previous paths, and stable indeterminate reasons; and
11. remove the temporary index and ignore view after capture.

Set `GIT_NO_REPLACE_OBJECTS=1` in the collector-only environment, including for `read-tree`, `diff`, `ls-tree`, and `cat-file`, so an agent-authored replacement ref cannot redirect the immutable commit. The collector never invokes `git add`, writes refs, changes remotes, or updates the checkout's real index. Agent commits and staging cannot redefine the explicit baseline.

The initial private-index refresh may hash clean files once when copied worktree stat information is not trustworthy. Final discovery still traverses tracked metadata and untracked directories, so neither phase is constant-time or proportional only to the number of changes. The 90-second deadline bounds wall time; candidate byte limits bound application reads and memory, not Git's internal baseline I/O.

OCI materialization emits a package-private inventory of relative path, kind, mode, size, and digest while verifying and publishing the immutable seed. Checkouts reuse that baseline; final collection walks only bounded OCI destination trees and reads content only where comparison requires it. A separate bounded pass finds additions outside declared destinations while excluding source trees and provider-owned internals; those entries use `"."` as `sourceDestination`.

Fixed internal defaults are 90 seconds for each baseline and final capture, 10,000 candidate paths, 2,000 returned entries, 256 KiB per candidate file, 16 MiB total application file reads, 4 MiB combined subprocess output, and 2 MiB serialized metadata. Limits are shared across all sources in one call. A limit produces `status: "truncated"` with stable codes. Cancellation or an operational failure produces `status: "failed"` with a stable code and bounded message. File-change failure never changes a valid delegate response.

### Verification

- Tests cover additions, modifications, deletions, exact renames, indeterminate oversized comparisons, mode-only changes, symlinks, ignored files, an agent-modified `.gitignore`, an agent commit, an agent replacement ref, unusual filenames, malformed NUL-delimited output, unstable reads, deterministic ordering, timeout, cancellation, candidate/read/metadata limits, and capture failure.
- Tests prove the real index, refs, remotes, and source checkout remain byte-for-byte unchanged.
- Instrumented filesystem tests prove application code reads only bounded candidates; baseline tests separately measure Git's clean-tree refresh and final metadata traversal.
- Two concurrent captures use separate temporary indexes and return isolated results.
- A synthetic large-repository test exercises baseline refresh and candidate discovery without copying clean contents into application memory.
- An opt-in benchmark against an operator-supplied pinned large monorepo records tracked and visited entries, candidate paths, application bytes read, elapsed baseline/final-capture time, subprocess bytes, and maximum RSS. It is not a required public CI dependency.

## Phase 7: Copilot SDK provider

### Changes

Implement a clean public-SDK-based provider under `provider/src/copilot/`.

### Implementation guidance

Treat this section and the public SDK contracts as the implementation source of truth. Existing implementations may suggest failure cases, but do not preserve behavior solely because it existed elsewhere.

Keep the provider and SDK runner responsibilities separate:

**Provider process**

- validate the closed public config and extract Promptfoo's trusted loader `basePath`;
- resolve and validate the effective working directory before spawning;
- construct a versioned request containing only the SDK inputs the runner needs;
- spawn the runner with piped stdio and a minimal allowlisted environment;
- own timeout, cancellation, graceful termination, forced process-tree termination, protocol parsing, redaction, and OpenTelemetry spans;
- accept one terminal response only, and treat malformed output, premature exit, and missing final output as provider errors; and
- return Promptfoo-native output, error, token usage, and bounded metadata.

**Runner process**

- validate the complete request before dynamically importing `@github/copilot-sdk`;
- create `CopilotClient` with its TCP runtime and the validated working directory;
- create one session with model, reasoning, provider-routing, and permission settings;
- delegate session execution to a shared `runCopilotSession` runtime used by both standalone and composed modes;
- normalize SDK events into bounded protocol event frames;
- extract the final assistant text and usage without exposing raw credentials;
- disconnect the session, then call client `stop`; call `forceStop` if normal cleanup fails; and
- emit exactly one final or error frame after cleanup completes.

**Protocol and security**

- version every request and response frame;
- reserve stdout for protocol frames and capture bounded stderr separately;
- keep API keys in request memory only, redact them before every emitted frame, log, error, metadata object, and span;
- default to native Copilot routing when no custom provider is configured;
- require an explicit complete custom-provider tuple rather than inferring partial routing;
- start from read-only permissions and require an explicit opt-in for unrestricted tools; and
- test public SDK upgrades against the fake runner, packed Promptfoo consumer, and opt-in live smoke before changing the pinned version.

If SDK behavior conflicts with this contract, update the design explicitly; do not add an undocumented compatibility branch.

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

Export `CopilotSdkProvider` as a named package export. `Provider` remains the named and default workspace-owning export. Build only from public SDK contracts and the self-contained invariants above.

### Verification

- Unit tests use a fake SDK runner for success, SDK error, malformed protocol, timeout, cancellation, signal escalation, large output, and redaction.
- A packed-package smoke project installs the exact optional SDK peer and loads `package:@allagents/promptfoo-provider:CopilotSdkProvider` through stock Promptfoo.
- An opt-in credentialed test runs the public Copilot SDK but is not required for forked pull requests.

## Phase 8: Workspace provider and delegate adapters

### Changes

Implement `Provider`, the process-isolated `delegate-runner`, and the three delegate adapters in `provider`.

Constructor responsibilities:

- validate the exact provider and workspace config above;
- extract and realpath Promptfoo's loader-injected `basePath` before validating public config, and keep it only in the internal constructor envelope;
- initialize one owned workspace seed pool;
- resolve only the fixed runtime input channels;
- reject nested self-delegation and delegate IDs without registered adapters; and
- reject reserved path, session, environment-inheritance, and acquisition-credential fields at every authored layer.

For each `callApi`:

1. honor an already-aborted Promptfoo signal;
2. obtain the immutable seed;
3. create a unique checkout, initialize and refresh its package-owned change baselines while the checkout is clean, and retain those baselines through execution;
4. merge only allowed delegate fields from constructor and prompt config, validate again, and inject the validated absolute checkout path as `working_dir` last;
5. start the delegate runner as a process group with the minimal platform environment plus explicit `delegate.env`;
6. send a versioned JSON-lines request containing `PromptWire` (`id`, `raw`, `template`, `display`, `label`, `provider`, and `config: {}`) plus `vars`, `debug`, JSON-safe test metadata, cache flags, tracing fields, evaluation/test IDs, and row/prompt/repeat indices;
7. forward cancellation, enforce the wrapper timeout, await delegate cleanup, and terminate the runner process group before continuing;
8. collect bounded file-change metadata from the stable checkout whether the delegate succeeds or returns an error;
9. reject a delegate response that already owns `metadata.allagents`;
10. preserve the delegate response and add workspace provenance, the transient checkout path, and file-change metadata under that namespace;
11. register the checkout for evaluation-shutdown cleanup; and
12. return the response.

An idempotent `finally` repeats process-group termination. It removes a checkout only when the call fails before publishing a response; a published checkout remains live for assertions. The provider's idempotent `cleanup()` hook stops new work, aborts preparation, waits for in-flight calls, removes every retained checkout and seed, and rejects with an aggregate of any paths it could not remove. The supported Promptfoo host invokes this hook from its own outer `finally`; the provider does not rely on process-exit hooks or stale-root recovery for normal cleanup.

Protocol v1 reserves stdout for newline-delimited frames with `{ version: 1, requestId, type, payload }`. The parent sends one `call` frame and optional idempotent `abort` frame. The child constructs its own `AbortController`, rejects unknown or duplicate frames, and emits exactly one terminal `response` or `fatal` frame only after native cleanup. Exported constants bound frame bytes, stderr bytes, and shutdown grace time. Malformed, oversized, duplicate-terminal, or non-serializable frames fail closed.

The child receives `traceparent` and `tracestate` and exports spans through explicitly allowlisted OpenTelemetry environment/config; no in-memory tracer or cache callback crosses the boundary. Protocol stderr is separate from stdout, bounded, and redacted before logging or response construction. Wrapper response caching remains disabled.

The runner receives trusted `basePath` separately from public config and supplies it to `loadApiProvider` for peer/SDK resolution even when the checkout lives outside the config directory. Before serialization, the parent folds the allowed prompt-level `delegate.config` override into the validated effective constructor config and clears `PromptWire.config`. It strips prompt functions, prompt-level provider objects, and every process-local context field; supported delegates receive only the DTO fields above.

Delegate adapters implement one internal interface that validates authored config, binds the owned checkout, constructs the delegate, and declares cleanup requirements. The initial adapter registry is closed:

- Codex and Claude adapters call Promptfoo's public `loadApiProvider`;
- the Copilot adapter invokes the shared `runCopilotSession` runtime inside the existing delegate runner, never constructs `CopilotSdkProvider`, and never creates a nested detached process group;
- all adapters run with only essential platform variables and explicit `delegate.env`;
- every adapter rejects provider-specific paths, session persistence, and environment inheritance that would weaken the workspace contract; and
- every adapter preserves delegate output, error, usage, raw response, cache metadata, labels, and tracing context, returning only after native cleanup settles.

Export named `Provider` and `CopilotSdkProvider`, with `Provider` also exported as the default.

### Verification

- Contract tests run the same fake coding task through Codex, Claude, and Copilot delegates.
- Prompt-level attempts to set `working_dir`, `additional_directories`, session persistence, environment inheritance, unknown keys, or acquisition credential variables are rejected.
- Every delegate receives the contained checkout path at final precedence and receives no sibling or seed path through provider configuration.
- Timeout and cancellation tests for every delegate assert the runner process group and any descendants are gone before `callApi` returns.
- Protocol tests cover abort before and during execution, malformed and oversized frames, duplicate terminal frames, bounded stderr, redaction, trace-context propagation, child cleanup, and forced process-group escalation.
- Killing the outer delegate runner while a noncooperative Copilot runtime child is active leaves no descendant process.
- Base-path tests run with process cwd, Promptfoo config directory, installed package directory, and workspace root all different; native SDK resolution still uses the trusted config base while every delegate receives the absolute checkout.
- Prompt DTO tests cover function-backed prompts and prompt configs containing a live provider object without serializing either object; a prompt-level model override reaches the delegate through its validated constructor config while `PromptWire.config` remains empty.
- Two concurrent calls prove distinct workspaces and isolated `fileChanges`.
- A delegate-authored `metadata.allagents` namespace returns an explicit collision error rather than being overwritten.
- JavaScript assertions read each response's workspace files before `cleanup()` and separately consume bounded `fileChanges` metadata.
- Delegate failure, file-change capture failure, timeout, and cancellation produce explicit bounded results; evaluation-shutdown cleanup leaves no owned process, checkout, staging path, or seed.
- Host-lifecycle tests cover stock Promptfoo CLI success, below-threshold failed assertions, provider failure, cancellation, the Node `evaluate()` API, and multiple providers where one cleanup rejects; every provider cleanup is attempted exactly once.
- Packed-package smoke tests load `package:@allagents/promptfoo-provider:Provider` through stock Promptfoo.

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

Each workspace example includes a JavaScript assertion module loaded with `file://`. The assertion reads `context.providerResponse.metadata.allagents.workspace.path`, resolves a known path beneath that root, and grades the actual file contents. A second assertion demonstrates using `metadata.allagents.fileChanges` without reading file contents.

Add a compatibility matrix for each supported Promptfoo minor. A clean temporary project installs the packed tarball without the optional Copilot peer, runs `promptfoo validate`, imports `default`, `Provider`, and `CopilotSdkProvider`, verifies the default is `Provider`, and confirms Copilot calls return the actionable missing-peer error. Keep fake delegate adapters internal to contract tests; the packed public interface has no generic test delegate.

### Verification

- No example imports repository source files directly.
- All examples resolve providers through `package:` identifiers.
- The compatibility matrix fails on package loading, export identity, validation, or supported provider-construction drift.
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
2. Publish a release candidate under a `next` dist-tag.
3. In smoke project A, install only the provider package; import `Provider`, default, and `CopilotSdkProvider`, verify the default is `Provider`, and confirm actionable missing-peer behavior.
4. In smoke project B, install the provider package and exact `@github/copilot-sdk` peer; run direct `CopilotSdkProvider` and composed `copilot-sdk` smoke cases.
5. Run packed and registry-installed compatibility suites.
6. Publish stable `1.0.0` with provenance.
7. Announce the exact supported Promptfoo range, Node version, ORAS requirement, optional Copilot peer, config schema, transient workspace lifetime, and file-change bounds.
8. Update downstream consumer documentation to install the public package rather than copy provider implementations.

### Verification

- npm displays provenance for the package.
- `npm view` shows the expected repository, license, exports, engines, peer dependencies, and dist-tags.
- Fresh smoke projects prove both the no-peer and exact-peer installation paths.
- The published tarball contains no fixtures, credentials, source maps with private paths, or private repository references.

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

- packed-package stock-Promptfoo validation and export-identity checks without the optional Copilot peer;
- concurrent workspace isolation E2E;
- assertion-lifecycle E2E proving a response checkout exists during JavaScript assertions and is removed only after provider cleanup;
- stock-Promptfoo cleanup E2E covering CLI pass/fail/error/cancellation and Node `evaluate()`, including all-settled cleanup when one provider rejects;
- bounded file-change E2E proving a large Git checkout does not stage files, mutate its real index, read clean tracked contents into application memory, or exceed published internal bounds;
- Git provenance E2E;
- OCI digest/authentication E2E against a disposable registry;
- Copilot protocol and cancellation E2E with a fake runner, including forced outer-runner death; and
- credentialed live-provider smoke tests when organization secrets are available.

## Completion criteria

- The provider package is public and installable from npm with provenance.
- Stock Promptfoo loads `Provider` and `CopilotSdkProvider` from the package through their documented named exports.
- `Provider` calls Promptfoo's original Codex and Claude providers and the package-local Copilot provider through closed delegate adapters.
- Git and OCI inputs produce immutable provenance and private per-call checkouts.
- Concurrent calls share no writable filesystem objects; mutation through one checkout cannot change its seed or sibling checkouts.
- Each response checkout remains available through assertions, and provider cleanup removes all owned paths afterward.
- The supported Promptfoo peer range begins at a released version that guarantees all-path, all-settled provider cleanup; 0.122.0 is rejected.
- Bounded `fileChanges` metadata survives result serialization; it never promises durable workspace contents.
- Cancellation and failure leave no provider process or provider-owned path behind after evaluation-shutdown cleanup.
- Source credentials are absent from delegate environments, results, logs, and traces.
- No Promptfoo authoring compiler, network gateway, or custom score protocol is introduced.
