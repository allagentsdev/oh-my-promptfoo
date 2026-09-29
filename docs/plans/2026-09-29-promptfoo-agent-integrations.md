---
title: "Promptfoo agent integrations implementation plan"
date: 2026-09-29
type: feat
status: proposed
---

# Promptfoo agent integrations implementation plan

## Goal

Publish `@allagents/promptfoo-integration` from `allagentsdev/promptfoo-integrations`. The package exports:

- `Provider`, a workspace-owning provider that delegates to Promptfoo's Codex and Claude providers or the package's Copilot provider;
- `CopilotSdkProvider`, a lower-level provider that executes the public GitHub Copilot SDK in an existing working directory.

The workspace provider must accept exact Git and OCI workspace sources, create one private checkout per Promptfoo call, preserve native delegate results, expose each checkout through assertions, return bounded file-change metadata, and release each checkout through a package-supplied lifecycle extension after that row's assertions.

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
package:@allagents/promptfoo-integration:Provider
package:@allagents/promptfoo-integration:CopilotSdkProvider
```

`Provider` is both a named export and the default export. `CopilotSdkProvider` is a named export.

The same package exports `@allagents/promptfoo-integration/lifecycle` with one `workspaceLifecycle` function and the `allagents-promptfoo` executable. Promptfoo configs load the lifecycle through a config-local `file://` re-export shim until Promptfoo supports package references for extensions.

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
      timeoutMs: 900000

extensions:
  - file://./.allagents/promptfoo-workspace.cjs:workspaceLifecycle
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

`workspace.path` is absolute and remains valid through Promptfoo assertions. It becomes invalid when `workspaceLifecycle` releases the row after assertions and is not a durable artifact reference. [Promptfoo JavaScript assertion context](https://www.promptfoo.dev/docs/configuration/expected-outputs/javascript/#using-test-context) exposes `providerResponse`, including this path and `fileChanges`. Entries and truncation codes are lexically sorted and paths use normalized `/` separators. Summary counts describe returned entries, not unknown changes omitted by a limit. A truncated or failed change capture remains explicit but does not replace an otherwise valid delegate response. Delegate output, error, token usage, raw response, and existing metadata remain native; a delegate response marked `cached` is rejected.

`manifestDigest` is SHA-256 over UTF-8 RFC 8785 canonical JSON containing schema version, Git and OCI materializer versions, and resolved sources sorted by normalized destination. Seed keys use this digest, not mutable requested refs or tags.

### Runtime requirements

- Node.js 22.22.0 or newer.
- Linux and macOS only in the initial release; package metadata rejects Windows because reliable process-tree termination depends on POSIX process groups.
- Bun 1.4 for repository development and publishing workflows.
- The `promptfoo` peer range begins at the first version that passes the package's provider-and-extension compatibility matrix. Promptfoo 0.122.0 is a candidate baseline; its provider cleanup limitation is not a blocker because the package lifecycle extension owns post-assertion release.
- The package declares `@github/copilot-sdk: "1.0.6"` as an optional peer dependency and an exact development dependency. Selecting Copilot without installing the peer returns an actionable error; upgrades require protocol and live-smoke validation.
- OCI materialization uses a runtime-supplied ORAS 1.x executable in the first release.
- Workspace-backed delegates always receive `bustCache: true`, and a delegate response marked `cached` fails closed. Global Promptfoo caching may remain enabled; `evaluateOptions.cache: false` is optional cache-write hygiene.

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
│   └── promptfoo-integration/
│       ├── src/
│       │   ├── provider.ts
│       │   ├── config.ts
│       │   ├── metadata.ts
│       │   ├── lifecycle.ts
│       │   ├── runtime.ts
│       │   ├── doctor.ts
│       │   ├── cli.ts
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

`packages/workspace-core` has `"private": true`. Build output for `promptfoo-integration` bundles its runtime and declarations; it is never a published dependency.

## Phase 0: Repository and package foundation

### Changes

1. Create a Bun workspace root with the private workspace-core and public promptfoo-integration package directories.
2. Configure the public integration package with the first Promptfoo release that passes the provider-and-extension compatibility matrix as its peer lower bound and `@github/copilot-sdk` as an optional peer dependency plus exact development dependency.
3. Pin Bun in `packageManager` and Node in `engines`.
4. Configure strict TypeScript, Biome, Bun tests, dual ESM/CommonJS builds, and the `allagents-promptfoo` bin. Publish the lifecycle protocol in package metadata under a versioned `allagents.workspaceLifecycleProtocol` field that doctor can read without executing package code. Bundle workspace core into the integration package while externalizing both peers.
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

## Phase 1: Workspace lifecycle contract and configuration doctor

### Changes

Implement and prove the lifecycle seam before source materialization or delegate work:

1. export `workspaceLifecycle` from the package subpath `@allagents/promptfoo-integration/lifecycle` in both CommonJS and ESM;
2. expose `WorkspaceRuntime` under the stable process-global key `Symbol.for("@allagents/promptfoo-integration/workspace-runtime")`, store an explicit protocol version in the registry value, and reject an incompatible package copy that finds the same key;
3. make `beforeEach` attach an opaque random claim as a non-enumerable property under a separate stable global symbol on Promptfoo's exact test object, with the protocol version in the claim value and no provider config or filesystem path;
4. make `beforeAll` inspect the resolved `context.suite.extensions` list and reject unless exactly one `:workspaceLifecycle` entry occupies the final index, so authored `beforeEach` hooks run before claim attachment and authored `afterEach` hooks finish before workspace release;
5. make `Provider.callApi()` require the claim from `context.test` before acquisition, register active calls and leases under it, and fail closed when the lifecycle extension is absent or a later hook replaced the test object;
6. make `afterEach` wait for active calls, release every row lease with all-settled semantics, aggregate failures for suite cleanup, and delete the non-enumerable claim;
7. bind each claim and provider seed pool to Promptfoo's evaluation ID on first provider use and reject cross-evaluation reuse;
8. make `afterAll` close its evaluation to new acquisitions, abort and await every tracked active call and runner process group, then use all-settled cleanup only for resources owned by that evaluation;
9. retain idempotent `Provider.cleanup()` as a host fallback;
10. give every package-owned runtime root a validated ownership marker and live lease, and reap only unlocked ownership-marked roots after abnormal process termination; and
11. keep registry-key stability and protocol-value compatibility as permanent cross-version invariants.

The workspace recipe remains exclusively under `Provider.config.workspace`. The extension carries only a non-enumerable claim on Promptfoo's exact test object, so it neither adds report columns nor duplicates configuration. Multiple providers and concurrent rows may each materialize distinct workspaces without a top-level environment field or authoring compiler.

Expose an `allagents-promptfoo` binary from the integration package rather than publishing a separate CLI package. Its `doctor` command is read-only by default. Repeated `--config <path>` arguments validate explicit standalone entrypoints; without them, doctor discovers `promptfooconfig*.yaml` and `promptfooconfig*.yml` below the working directory while respecting `.gitignore` and excluding symlinks, dependency directories, and generated output. It identifies only `package:@allagents/promptfoo-integration:Provider` entries with `config.workspace` and requires the exact final lifecycle URI. It verifies the canonical shim path, regular-file type, and bytes; resolves `@allagents/promptfoo-integration/lifecycle` from the config directory without importing it; locates the owning package manifest; and compares its package version and lifecycle protocol metadata with the running CLI. Read-only doctor never executes configured JavaScript.

A YAML document containing a workspace-enabled AllAgents provider must also contain its lifecycle entry. Doctor validates standalone entrypoint files and does not infer arbitrary multi-config merge groups.

`doctor --fix` uses a YAML concrete-syntax tree, never parse/stringify, to preserve comments, anchors, key order, scalar style, and unrelated whitespace. It inserts the explicit lifecycle entry when absent, deduplicates package-owned entries, moves the entry last, and stages `.allagents/promptfoo-workspace.cjs` plus an ownership/version marker once per unique config directory. Before writing, fix mode preflights every selected YAML edit and shim ownership check. Each file replacement is atomic, and rerunning after interruption completes the idempotent plan without overwriting unowned work. Sibling configs share one shim; selected nested directories get their own. The fixer refuses dynamic or ambiguous YAML, unsupported config formats, symlink targets, and unowned or locally modified shim targets. A lifecycle without a workspace provider is a zero-exit warning and is never automatically removed. Consumers review and commit fixes, while required CI passes the same explicit config paths to read-only doctor and stock Promptfoo; no runtime path compiles or rewrites configuration.

### Verification

- Stock Promptfoo runs pass, failed-assertion, provider-error, cancellation, and Node `evaluate()` cases with the package lifecycle extension.
- Concurrent rows, multiple AllAgents providers, and two concurrent `evaluate()` calls in one process use distinct claims; `afterAll` closes and drains only its evaluation before release.
- One rejecting lease release does not skip later row or suite cleanup, and the suite boundary preserves the aggregate cleanup failure.
- Missing hooks, duplicate or non-final lifecycle entries, forged or unknown claims, a replaced test object, duplicate release, incompatible runtime versions, and separate CommonJS/ESM imports fail safely before workspace acquisition or cleanup.
- A timeout that reaches `afterAll` while a delegate is still unwinding aborts and awaits that active call and process group before removing its checkout or seed.
- A killed process leaves an ownership-marked root that a later invocation reaps; a live lease and every unmarked or malformed path are preserved.
- Read-only doctor discovers the documented YAML filename patterns, respects `.gitignore`, accepts repeated explicit config paths, changes no bytes, and exits nonzero with file/field-specific repairs for every invalid workspace config.
- Doctor distinguishes no-workspace configs, an unpaired-lifecycle warning, one or several workspace providers requiring one final lifecycle, missing lifecycle entries, duplicate or non-final entries, noncanonical references or shim bytes, unresolved package subpaths, malformed package protocol metadata, and incompatible versions.
- `doctor --fix` stages one shim for several sibling configs, separate shims only for selected nested config directories, and no shim in unrelated monorepo directories.
- Fix mode preflights all selected edits, uses atomic per-file replacements, is idempotent, preserves YAML comments and formatting, recovers by rerun after simulated interruption, rejects symlink/non-file/config collisions and modified generated files, and works from a packed npm installation.
- A hand-authored two-line shim and doctor-managed shim validate and behave identically.
- Running doctor without `--fix` in consumer CI detects manual configuration drift, while runtime claim enforcement still fails before workspace acquisition if CI is skipped.

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

- each `Provider` instance owns one seed pool and request-resolution map, registers that pool to an evaluation through the shared lifecycle runtime, and creates all paths beneath a package-owned leased runtime root;
- concurrent calls for one canonical request share one resolution promise;
- the first successful commit/digest is pinned for that request until suite or provider cleanup, even if the remote ref or tag moves;
- requests that resolve to one manifest share one seed preparation promise;
- failed resolution or preparation entries are removed so a later call may retry;
- completed seeds remain immutable for that provider instance's lifetime;
- each checkout uses a unique contained directory registered to its row claim;
- checkout creation uses a verified reflink/copy-on-write clone when available and a recursive copy otherwise;
- hardlinks are prohibited;
- checkout, row, suite, and provider release are idempotent;
- successful calls retain their private checkouts only through their row's assertions;
- `afterEach` waits for active calls and removes every checkout registered to that row;
- `afterAll` closes its evaluation to new acquisitions, aborts and awaits every active call and runner process group, then removes only that evaluation's retained checkouts, staging paths, and seed pools with all-settled semantics;
- provider cleanup is an all-settled host fallback;
- provider construction reaps only versioned, ownership-marked runtime roots whose lease is no longer live; and
- source acquisition abort and per-call abort are separate so cancellation of one row does not corrupt a seed used by another row.

### Verification

- Twenty concurrent checkouts share one seed preparation and receive distinct writable roots.
- Concurrent calls while a ref moves share the first resolution; later calls on that provider stay pinned, while a new provider instance resolves the new target.
- Mutation in one checkout does not change the seed or another checkout.
- Partial copies, cancellation, and process errors before response publication leave no published checkout.
- An ownership marker and live lease prevent lifecycle cleanup or stale recovery from deleting paths not created by the package or still owned by another process.
- JavaScript assertions can read each response's distinct checkout path; `afterEach` removes that row, and repeated row, suite, and provider cleanup are no-ops.

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

Implement a clean public-SDK-based provider under `packages/promptfoo-integration/src/copilot/`.

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
- A packed-package smoke project installs the exact optional SDK peer and loads `package:@allagents/promptfoo-integration:CopilotSdkProvider` through stock Promptfoo.
- An opt-in credentialed test runs the public Copilot SDK but is not required for forked pull requests.

## Phase 8: Workspace provider, lifecycle, and delegate adapters

### Changes

Implement `Provider`, `workspaceLifecycle`, the shared runtime, the process-isolated `delegate-runner`, and the three delegate adapters in `packages/promptfoo-integration`.

Constructor responsibilities:

- validate the exact provider and workspace config above;
- extract and realpath Promptfoo's loader-injected `basePath` before validating public config, and keep it only in the internal constructor envelope;
- initialize one owned workspace seed pool and register it with the shared runtime;
- resolve only the fixed runtime input channels;
- reject nested self-delegation and delegate IDs without registered adapters; and
- reject reserved path, session, environment-inheritance, acquisition-credential, lifecycle-claim, and cache-control fields at every authored layer.

For each `callApi`:

1. honor an already-aborted Promptfoo signal;
2. require the opaque active claim from `context.test` before creating a path;
3. obtain the immutable seed;
4. create and register a unique checkout, initialize and refresh its package-owned change baselines while clean, and retain those baselines through execution;
5. merge only allowed delegate fields from constructor and prompt config, validate again, and inject the absolute checkout path plus `bustCache: true` at final precedence;
6. start the delegate runner as a process group with the minimal platform environment plus explicit `delegate.env`;
7. send a versioned JSON-lines request containing `PromptWire` (`id`, `raw`, `template`, `display`, `label`, `provider`, and `config: {}`) plus `vars`, `debug`, JSON-safe test metadata, forced cache-bypass state, tracing fields, evaluation/test IDs, and row/prompt/repeat indices;
8. forward cancellation, enforce the wrapper timeout, await delegate cleanup, and terminate the runner process group before continuing;
9. reject a delegate response marked `cached`;
10. collect bounded file-change metadata from the stable checkout whether the delegate succeeds or returns an error;
11. reject a delegate response that already owns `metadata.allagents`;
12. preserve the delegate response and add workspace provenance, the transient checkout path, and file-change metadata under that namespace; and
13. return the response while leaving the registered checkout live for assertions.

An idempotent `finally` repeats process-group termination. It removes a checkout when the call fails before publishing a response. Once published, `afterEach` owns normal row release; `afterAll` and `Provider.cleanup()` are fallbacks. Every path removes active-call reservations in `finally`, and cleanup attempts every lease before returning an aggregate failure.

Protocol v1 reserves stdout for newline-delimited frames with `{ version: 1, requestId, type, payload }`. The parent sends one `call` frame and optional idempotent `abort` frame. The child constructs its own `AbortController`, rejects unknown or duplicate frames, and emits exactly one terminal `response` or `fatal` frame only after native cleanup. Exported constants bound frame bytes, stderr bytes, and shutdown grace time. Malformed, oversized, duplicate-terminal, or non-serializable frames fail closed.

The child receives `traceparent` and `tracestate` and exports spans through explicitly allowlisted OpenTelemetry environment/config; no in-memory tracer or cache callback crosses the boundary. Protocol stderr is separate from stdout, bounded, and redacted before logging or response construction. The parent always sends `bustCache: true`; a cached delegate response is a contract error. Global Promptfoo caching is independent and may remain enabled.

The runner receives trusted `basePath` separately from public config and supplies it to `loadApiProvider` for peer/SDK resolution even when the checkout lives outside the config directory. Before serialization, the parent folds the allowed prompt-level `delegate.config` override into the validated effective constructor config and clears `PromptWire.config`. It strips prompt functions, prompt-level provider objects, and every process-local context field; supported delegates receive only the DTO fields above.

Delegate adapters implement one internal interface that validates authored config, binds the owned checkout, constructs the delegate, guarantees response-cache bypass, and declares cleanup requirements. The initial adapter registry is closed:

- Codex and Claude adapters call Promptfoo's public `loadApiProvider`;
- the Copilot adapter invokes the shared `runCopilotSession` runtime inside the existing delegate runner, never constructs `CopilotSdkProvider`, and never creates a nested detached process group;
- all adapters run with only essential platform variables and explicit `delegate.env`;
- every adapter rejects provider-specific paths, session persistence, authored cache overrides, and environment inheritance that would weaken the workspace contract; and
- every adapter preserves delegate output, error, usage, raw response, labels, and tracing context, returning only after native cleanup settles.

Export named `Provider` and `CopilotSdkProvider`, with `Provider` also exported as the default. Export `workspaceLifecycle` only through the documented lifecycle subpath.

### Verification

- Contract tests run the same fake coding task through Codex, Claude, and Copilot delegates.
- Prompt-level attempts to set `working_dir`, `additional_directories`, session persistence, environment inheritance, cache controls, unknown keys, acquisition credential variables, or lifecycle claims are rejected.
- Every delegate receives the contained checkout path and `bustCache: true` at final precedence and receives no sibling or seed path through provider configuration.
- Two concurrent Node `evaluate()` calls prove one evaluation's `afterAll` cannot release the other's checkout or seed pool, and a timeout proves cleanup waits for a still-unwinding call before filesystem removal.
- With Promptfoo caching enabled, two identical rows execute the delegate twice, mutate separate workspaces, return independent `fileChanges`, and never return `cached: true`.
- A fake or supported delegate response marked `cached` fails closed and releases unpublished state.
- Timeout and cancellation tests for every delegate assert the runner process group and any descendants are gone before `callApi` returns.
- Protocol tests cover abort before and during execution, malformed and oversized frames, duplicate terminal frames, bounded stderr, redaction, trace-context propagation, child cleanup, and forced process-group escalation.
- Killing the outer delegate runner while a noncooperative Copilot runtime child is active leaves no descendant process.
- Base-path tests run with process cwd, Promptfoo config directory, installed package directory, and workspace root all different; native SDK resolution still uses the trusted config base while every delegate receives the absolute checkout.
- Prompt DTO tests cover function-backed prompts and prompt configs containing a live provider object without serializing either object; a prompt-level model override reaches the delegate through its validated constructor config while `PromptWire.config` remains empty.
- Two concurrent calls prove distinct workspaces and isolated `fileChanges`.
- A delegate-authored `metadata.allagents` namespace returns an explicit collision error rather than being overwritten.
- JavaScript assertions read each response's workspace files before `afterEach` and separately consume bounded `fileChanges` metadata.
- Delegate failure, file-change capture failure, timeout, and cancellation produce explicit bounded results; row and suite cleanup leave no owned process, checkout, staging path, or seed.
- Packed-package smoke tests load `Provider` and the lifecycle subpath through stock Promptfoo.

## Phase 9: Examples and Promptfoo compatibility

### Changes

Add executable examples for:

- direct Copilot with an existing directory;
- Codex with a Git workspace;
- Claude with a Git workspace;
- Copilot with composed Git and OCI sources;
- parallel rows proving isolated checkouts; and
- sibling and nested monorepo Promptfoo configs maintained by doctor.

Every workspace-owning example references:

```yaml
extensions:
  # Keep the AllAgents lifecycle last.
  - file://./.allagents/promptfoo-workspace.cjs:workspaceLifecycle
```

Examples run `allagents-promptfoo doctor --fix --config <path>` once to create reviewable config changes, then use read-only `allagents-promptfoo doctor --config <path>` before Promptfoo validation or evaluation. One example hand-authors the equivalent two-line shim and final extension entry to prove doctor is convenience rather than a proprietary config compiler. Examples may set `evaluateOptions.cache: false` to avoid cache writes, but correctness tests also run with Promptfoo's default cache enabled.

Each workspace example includes a JavaScript assertion module loaded with `file://`. The assertion reads `context.providerResponse.metadata.allagents.workspace.path`, resolves a known path beneath that root, and grades the actual file contents. A second assertion demonstrates using `metadata.allagents.fileChanges` without reading file contents.

Add a compatibility matrix for each supported Promptfoo minor. A clean temporary project installs the packed tarball without the optional Copilot peer, applies `doctor --fix`, runs read-only doctor and `promptfoo validate`, imports `default`, `Provider`, `CopilotSdkProvider`, and the lifecycle subpath, verifies the default is `Provider`, and confirms Copilot calls return the actionable missing-peer error. Keep fake delegate adapters internal to contract tests; the packed public interface has no generic test delegate.

### Verification

- No example imports repository source files directly.
- All examples resolve providers through `package:` identifiers and extensions through doctor-managed or hand-authored config-local shims.
- Several configs in one monorepo directory share one `.allagents` shim; nested configs resolve only their own sibling shim.
- The compatibility matrix fails on package loading, export identity, doctor validation, extension loading, lifecycle behavior, or supported provider-construction drift.
- Examples contain no live credentials and use local fixtures by default.

## Phase 10: Distribution audit and upstream migration

### Changes

Audit and document the lifecycle and doctor artifacts implemented in Phase 1 and exercised by the Phase 9 compatibility matrix. No new runtime dependency may first appear in this phase.

Confirm the published boundary:

- `@allagents/promptfoo-integration` owns `Provider`, `CopilotSdkProvider`, the `./lifecycle` export, lifecycle protocol package metadata, and the `allagents-promptfoo` executable;
- no separate extension or CLI package exists for the coupled protocol;
- every workspace-owning config keeps one explicit final `file://./.allagents/promptfoo-workspace.cjs:workspaceLifecycle` entry;
- read-only `doctor` is the consumer CI check and opt-in `doctor --fix` is the idempotent source repair;
- config-local shims contain only the canonical CommonJS re-export, while direct `node_modules` paths, copied lifecycle implementations, runtime config mutation, and generated evaluation configs remain unsupported; and
- repeated explicit config paths and repository discovery retain one shim per unique selected config directory.

Promptfoo already loads JavaScript assertion functions through `package:`. A future assertion package may document direct references such as `package:@allagents/promptfoo-assertions:<export>`. Do not publish an empty placeholder assertion package.

Propose native package-function loading for extensions upstream and track the native post-assertion per-provider callback in [issue #2](https://github.com/allagentsdev/promptfoo-integrations/issues/2). When a released Promptfoo version provides the verified per-row callback, add a peer-version capability boundary: newer hosts use the native callback and do not load `workspaceLifecycle`; older supported hosts continue using the extension. Doctor removes the extension requirement only for that verified peer range, and the provider rejects a configuration that activates both release paths for one call.

### Verification

- Package manifests, packed tarballs, examples, and public documentation agree on one package, one lifecycle subpath, one executable, and the canonical shim bytes.
- No separate CLI or lifecycle package is required by npm, pnpm, or Bun smoke projects.
- The upstream package-function proposal includes a migration from the file shim to a direct package reference.
- A migration test proves the future native callback removes the extension and corresponding doctor rule without double-releasing a row.

## Phase 11: Release

### Changes

1. Confirm npm scope ownership and trusted-publisher configuration.
2. Publish a release candidate under a `next` dist-tag.
3. In smoke project A, install only the integration package; import `Provider`, default, and `CopilotSdkProvider`, verify the default is `Provider`, exercise read-only doctor and `doctor --fix`, and confirm actionable missing-peer behavior.
4. In smoke project B, install the integration package and exact `@github/copilot-sdk` peer; run direct `CopilotSdkProvider` and composed `copilot-sdk` smoke cases.
5. Run packed and registry-installed compatibility suites.
6. Publish stable `1.0.0` with provenance.
7. Announce the exact supported Promptfoo range, Node version, ORAS requirement, optional Copilot peer, config schema, doctor workflow, transient workspace lifetime, and file-change bounds.
8. Update downstream consumer documentation to install the public integration package rather than copy provider or lifecycle implementations.

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

- packed-package stock-Promptfoo validation, export-identity checks, and read-only/fixing doctor checks without the optional Copilot peer;
- concurrent workspace isolation E2E;
- assertion-lifecycle E2E proving a response checkout exists during JavaScript assertions and is removed by `afterEach`;
- stock-Promptfoo lifecycle E2E covering CLI pass/fail/error/cancellation and Node `evaluate()`, including all-settled row and suite cleanup when one lease release rejects;
- bounded file-change E2E proving a large Git checkout does not stage files, mutate its real index, read clean tracked contents into application memory, or exceed published internal bounds;
- Git provenance E2E;
- OCI digest/authentication E2E against a disposable registry;
- Copilot protocol and cancellation E2E with a fake runner, including forced outer-runner death; and
- credentialed live-provider smoke tests when organization secrets are available.

## Completion criteria

- The integration package is public and installable from npm with provenance.
- Stock Promptfoo loads `Provider` and `CopilotSdkProvider` from the package through their documented named exports.
- `Provider` calls Promptfoo's original Codex and Claude providers and the package-local Copilot provider through closed delegate adapters.
- Git and OCI inputs produce immutable provenance and private per-call checkouts.
- Concurrent calls share no writable filesystem objects; mutation through one checkout cannot change its seed or sibling checkouts.
- Each response checkout remains available through assertions, and `workspaceLifecycle` removes the row afterward.
- The supported Promptfoo peer range begins at the first released version that passes the provider-and-extension lifecycle matrix; no upstream provider-cleanup fix is required.
- Bounded `fileChanges` metadata survives result serialization; it never promises durable workspace contents.
- Cancellation and failure leave no provider process behind; normal lifecycle cleanup removes owned paths, and a later invocation safely reaps only lease-verified abandoned roots after hard termination.
- Source credentials are absent from delegate environments, results, logs, and traces.
- No Promptfoo authoring compiler, network gateway, or custom score protocol is introduced.
