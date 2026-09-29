---
title: "Promptfoo agent integrations implementation plan"
date: 2026-09-29
type: feat
status: proposed
---

# Promptfoo agent integrations implementation plan

## Goal

Publish `@allagents/promptfoo-integration` from `allagentsdev/promptfoo-integrations`. The package exports:

- `Provider`, a workspace-owning provider that delegates to Promptfoo's Codex and Claude providers or the package's Copilot provider, captures bounded agent file changes, runs a trusted verifier before cleanup, and returns durable results; and
- `CopilotSdkProvider`, a lower-level provider that executes the public GitHub Copilot SDK in an existing working directory.

The workspace provider must accept exact Git and OCI workspace sources, create one private checkout per Promptfoo call, preserve the complete JSON-safe native delegate response, capture bounded agent-attributed changed-file contents, run one configured verifier after the delegate has fully stopped, return changes at `metadata.fileChanges` and rewards or evidence at `metadata.verifier`, and return a successful response only after checkout removal succeeds.

ADR 0001 is authoritative for package boundaries and terminology. `CONTEXT.md` defines the domain language used below.

## Non-goals

- A network execution service, queue, database, or remote artifact API.
- Reimplementing Promptfoo's Codex or Claude providers.
- A Promptfoo lifecycle extension or post-assertion live checkout.
- A configuration doctor or Promptfoo authoring compiler.
- Unbounded file capture, a durable artifact store, or a filesystem path consumed after provider return.
- Arbitrary delegate providers in the first release.
- Making provider-returned rewards automatically replace Promptfoo assertions.
- Keeping verifier implementation secret from a malicious same-user agent without OS isolation.
- A public workspace-core package before a second external consumer exists.

## Locked contracts

### Provider references

```text
package:@allagents/promptfoo-integration:Provider
package:@allagents/promptfoo-integration:CopilotSdkProvider
```

`Provider` is both a named export and the default export. `CopilotSdkProvider` is a named export. The initial package has no subpath export and no executable.

### Supported delegates

```text
openai:codex-sdk
anthropic:claude-agent-sdk
copilot-sdk
```

The workspace provider rejects itself, unknown delegate IDs, delegates without registered adapters, and any nested delegate `working_dir`.

The external config remains a closed discriminated union. Internally, each supported ID maps to one `DelegateAdapter` that validates its allowed config, binds the owned checkout at final precedence, loads the provider, guarantees cache bypass, and declares cleanup behavior. There is no generic fallback to `loadApiProvider`.

### Public provider configuration

`Provider` accepts one closed, versioned configuration:

```ts
interface ProviderConfig {
  delegate: CodexDelegate | ClaudeDelegate | CopilotDelegate;
  workspace: WorkspaceSpec;
  verifier: VerifierConfig;
  timeoutMs?: number;
}

interface VerifierConfig {
  command: string;
  args?: string[];
  timeoutMs?: number;
  env?: Record<string, string>;
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

All public config objects reject unknown keys. Before public validation, each provider constructor extracts Promptfoo's loader-injected `basePath` into an internal envelope; users cannot set or override it through prompt config.

The initial release deliberately omits native-provider fields that enable extra directories, session reuse, settings/plugin discovery, executable overrides, arbitrary CLI/MCP passthroughs, process-environment inheritance, or function-valued hooks. Prompt-level config may override only fields under `delegate.config`. Workspace, verifier, timeouts, environments, and delegate identity are constructor-only. The wrapper merges the allowed prompt override into constructor config, rejects reserved fields in either layer, validates the result, and injects the checkout path and `bustCache: true` last.

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
      verifier:
        command: ./verifiers/score
        args: [--format, promptfoo]
        timeoutMs: 120000
        env:
          JUDGE_API_KEY: "{{env.JUDGE_API_KEY}}"
      timeoutMs: 900000
```

A relative verifier command resolves from trusted `basePath`. The resolved target must be an executable regular file, must not be a symlink, and must remain outside the package-owned runtime root. The provider invokes it directly without a shell. Arguments are literal strings. The verifier runs with the checkout as its current working directory; no workspace path is needed in config or protocol.

`timeoutMs` bounds the complete provider call. `verifier.timeoutMs` additionally bounds verification and cannot extend the remaining call deadline. Cancellation is honored before acquisition, during source preparation, during delegate execution, between delegate and verifier, during verification, and during cleanup.

Source credentials and executable paths are runtime inputs, resolved from provider `options.env` before `process.env`:

- `ALLAGENTS_GIT_USERNAME` and `ALLAGENTS_GIT_TOKEN`;
- `ALLAGENTS_ORAS_PATH`;
- `ALLAGENTS_ORAS_AUTH_FILE`; and
- optional `ALLAGENTS_WORKSPACE_ROOT`.

These names are reserved and rejected in `delegate.env`, `verifier.env`, and every prompt-level delegate field. `ALLAGENTS_ORAS_AUTH_FILE` points to a Docker-compatible registry auth file; the materializer copies it to a private mode-`0600` file for each acquisition. Defaults and hard maxima for source and protocol limits are exported constants and documented in the package README.

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

Destinations are relative, normalized, non-empty, non-overlapping, and cannot traverse or resolve outside the seed root. Configuration contains no credentials or arbitrary source-acquisition commands.

The initial Git adapter accepts `https://` and `file://` repositories. It rejects SSH, Git, and credential-bearing URLs; SSH authentication and submodules require a later contract.

### Delegate response preservation

The delegate child returns the complete JSON-safe Promptfoo `ProviderResponse` in its terminal protocol frame. The wrapper must not project a smaller hand-authored response shape. It validates serialized bytes and JSON safety, then round-trips every field and every native metadata key unchanged.

Supported adapters normalize provider-specific values into Promptfoo's public response types before serialization. Functions, symbols, circular data, unsupported binary values, and an oversized response fail explicitly; they are never silently omitted or stringified. Known Promptfoo binary response fields use their documented JSON-safe encoding.

After verification, the parent creates a fresh metadata object:

```ts
const metadata = {
  ...delegateResponse.metadata,
  fileChanges,
  verifier: verifierMetadata,
  allagents: {
    schemaVersion: 1,
    delegate: { id: configuredDelegateId },
    workspace: workspaceProvenance,
  },
};
```

A delegate response that already owns `metadata.fileChanges`, `metadata.verifier`, or `metadata.allagents` fails with an explicit compatibility error. Native metadata is not nested. In particular, `metadata.skillCalls` remains top-level so Promptfoo's `skill-used` and `not-skill-used` assertions see the same data through `Provider` as through the direct delegate.

The compatibility contract covers:

- output and error;
- token usage and cost;
- raw response, labels, log probabilities, audio, guardrail data, and other JSON-safe public response fields;
- every native metadata key, including `skillCalls`; and
- W3C trace identity and agent tool spans.

Copilot advertises `skill-used` support only after public SDK events can be mapped to Promptfoo's normalized `skillCalls` without inferring from assistant prose.

### File-change result

Capture runs after the delegate process group is gone and before the verifier starts. This makes `metadata.fileChanges` agent-attributed even when the verifier installs dependencies, runs formatters or tests, invokes another agent, or otherwise mutates the checkout.

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

This is the bounded Promptfoo equivalent of Agent Eval's `generatedFiles` and `deletedFiles`: changed after-bytes are exact and binary-safe, deleted paths remain explicit, and an optional unified diff makes bounded text additions, modifications, and deletions directly inspectable. Symlink content is the link target bytes and is never dereferenced. Renames are represented as delete plus generate rather than inferred by similarity.

All paths are normalized workspace-relative paths and sorted lexically. Fixed exported limits bound collection time, candidates, returned files, bytes per file, total captured bytes, diff bytes, subprocess output, omitted paths, and serialized metadata. A limit returns deterministic partial data with `status: "truncated"`; an operational failure returns no partial data and `status: "failed"`. Capture failure alone does not suppress a valid delegate response or verifier run; overall cancellation still skips verification and proceeds to cleanup.

The verifier receives the same `FileChanges` object in its request and may use it with the live workspace. It may add task-specific diff explanations under `evidence`, but it cannot replace the canonical pre-verifier capture. Promptfoo assertions consume `context.providerResponse.metadata.fileChanges` after cleanup and never read a retained file path.

### Verifier protocol and result metadata

The parent starts verification only after the delegate's native cleanup has settled and its complete process group is gone. The verifier gets a new minimal child environment composed from essential platform variables and explicit `verifier.env`; it never inherits `delegate.env`, acquisition credentials, `SSH_AUTH_SOCK`, or ambient process secrets.

The parent writes one bounded JSON document to verifier stdin:

```ts
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface VerifierRequest {
  schemaVersion: 1;
  prompt: PromptWire;
  response: JsonSafeProviderResponse;
  context: {
    vars: Record<string, JsonValue>;
    testMetadata?: Record<string, JsonValue>;
    evaluationId?: string;
    testId?: string;
    rowIndex?: number;
    promptIndex?: number;
    repeatIndex?: number;
  };
  fileChanges: FileChanges;
  workspace: WorkspaceProvenance;
}

interface WorkspaceProvenance {
  manifestDigest: `sha256:${string}`;
  sources: ResolvedSource[];
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
```

The verifier reads the workspace from its current working directory. No workspace path, seed path, verifier path, acquisition credential, or delegate credential enters the request. Prompt and response content are untrusted inputs even though the verifier executable is trusted.

Stdout is reserved for exactly one JSON document:

```ts
interface VerifierOutput {
  schemaVersion: 1;
  rewards?: Record<string, number>;
  evidence?: JsonValue;
}

interface VerifierMetadata extends VerifierOutput {
  durationMs: number;
  traceId?: string;
}
```

At least one of `rewards` or `evidence` is required. Reward keys are non-empty stable identifiers and values are finite numbers in `[0, 1]`. Evidence is arbitrary JSON within the fixed serialized-byte bound. Unknown keys, duplicate JSON documents, trailing protocol text, non-finite numbers, invalid UTF-8, and output overflow fail verification. Human diagnostics belong on bounded stderr.

The package fixes and exports hard limits for verifier request bytes, stdout bytes, stderr bytes, result bytes, shutdown grace, and maximum configured timeout. Limits are not row-configurable in the first release. The protocol is versioned independently from the package version.

The parent adds the successful result at `response.metadata.verifier`, not `metadata.allagents.verifier`. AllAgents-specific provenance remains at `metadata.allagents`. Promptfoo assertions use the generic path:

```js
const verifier = context.providerResponse?.metadata?.verifier;
```

A reward of zero is a valid verifier result. Launch errors, timeout, cancellation, malformed output, overflow, and cleanup errors are provider infrastructure failures and never become zero rewards. A valid delegate response containing a provider-level error still runs verification unless the overall call was cancelled; this allows grading partial workspace work.

The verifier may call deterministic tools, an LLM, or another agent. Its model usage is not merged into the delegate's `tokenUsage` or cost. It may include bounded usage information in evidence if the consumer needs it.

### Tracing and assertion compatibility

The delegate child receives the incoming `traceparent` and `tracestate` and exports spans using explicit allowlisted OpenTelemetry configuration. Its normalized tool spans must retain Promptfoo's expected attributes so these assertions behave the same through the wrapper as against the direct provider:

- `trajectory:tool-used`;
- `trajectory:tool-args-match`;
- `trajectory:tool-sequence`; and
- `trajectory:step-count`.

The verifier receives no agent trace context. The provider starts a separate verifier root trace when tracing is enabled and records its trace ID in `metadata.verifier.traceId`. Verifier commands, model calls, and tools must not enter the agent trajectory or satisfy trajectory assertions.

Promptfoo's ordinary output assertions consume the unchanged delegate output. JavaScript assertions can map verifier rewards to pass/fail and score. Assertion transforms can project verifier evidence into a native `llm-rubric`. The integration does not invent a parallel assertion engine or automatically treat rewards as the row score.

### Runtime requirements

- Node.js 22.22.0 or newer.
- Linux and macOS only in the initial release; package metadata rejects Windows because reliable process-tree termination depends on POSIX process groups.
- Bun 1.4 for repository development and publishing workflows.
- The `promptfoo` peer range begins at the first version that passes direct-versus-wrapped response, assertion, and tracing compatibility tests. Promptfoo 0.122.0 is a candidate baseline.
- The package declares `@github/copilot-sdk: "1.0.6"` as an optional peer dependency and exact development dependency. Selecting Copilot without installing the peer returns an actionable error; upgrades require protocol and live-smoke validation.
- OCI materialization uses a runtime-supplied ORAS 1.x executable in the first release.
- File capture has fixed internal defaults of 90 seconds, 10,000 candidate paths, 2,000 returned files, 256 KiB per file, 4 MiB total captured bytes, 1 MiB unified diff text, 4 MiB subprocess output, 1,000 omitted paths, and 8 MiB serialized metadata. These are safety bounds rather than completeness promises.
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
│       │   ├── verifier.ts
│       │   ├── verifier-protocol.ts
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

1. Create a Bun workspace root with private workspace-core and public promptfoo-integration package directories.
2. Configure the public package with the first Promptfoo release that passes the compatibility matrix as its peer lower bound and `@github/copilot-sdk` as an optional peer plus exact development dependency.
3. Pin Bun in `packageManager` and Node in `engines`.
4. Configure strict TypeScript, Biome, Bun tests, and dual ESM/CommonJS builds. Bundle workspace core while externalizing both peers.
5. Add Changesets for package versions and release notes.
6. Add root commands for build, typecheck, lint, test, and pack checking.
7. Add GitHub Actions for validation, packed-package smoke tests, and trusted npm publishing with provenance.
8. Add dependency update automation for Promptfoo, Copilot SDK, TypeScript, and build dependencies.
9. Confirm maintainers control the `@allagents` npm scope before enabling publication.

### Verification

- A clean checkout installs with `bun install --frozen-lockfile`.
- All root commands pass with empty package implementations.
- `npm pack --dry-run` includes only declarations, runtime files, license, package metadata, and README.
- A clean npm smoke project installs and executes the tarball. Its manifest and emitted imports contain no private workspace package dependency; `promptfoo` and `@github/copilot-sdk` remain external peers.
- The manifest exposes only the package root and has no `bin`, lifecycle, or doctor surface.

## Phase 1: Workspace configuration and containment

### Changes

Implement `workspace-core/src/config.ts` with the exact closed schemas above for `WorkspaceSpec`, `GitSource`, `OciSource`, source limits, and runtime inputs.

Validation must reject:

- empty or absolute destinations;
- `.` or `..` path segments;
- Windows drive or UNC paths;
- duplicate or ancestor/descendant destination overlap;
- repository schemes other than initial Git `https://` and `file://`;
- malformed OCI digests;
- unknown fields;
- credentials embedded in repository URLs; and
- source counts or configured limits above hard package maxima.

Use two-stage keys. First, canonical request JSON single-flights resolution of each Git ref or OCI tag. The first successful resolution is pinned for that provider instance. Second, SHA-256 over UTF-8 RFC 8785 canonical JSON containing schema version, materializer versions, and resolved sources sorted by normalized destination becomes the seed key.

Runtime input resolution records only whether a channel was present, never its value. It rejects an unwritable workspace root, non-executable ORAS path, credential values embedded in config, and source limits above exported hard maxima.

### Verification

- Table-driven tests cover POSIX and Windows path forms, Unicode normalization, overlap in both declaration orders, URL user-info, malformed digests, unknown fields, and stable canonicalization.
- Configuration tests prove prompt-level overrides cannot replace workspace, verifier, environment, deadline, delegate identity, working directory, or cache behavior.

## Phase 2: Git source materialization

### Changes

Implement `sources/git.ts` using direct process spawning without a shell.

For each Git source:

1. create a private staging directory;
2. create a subprocess-only credential helper from fixed runtime channels;
3. clone or fetch with interactive prompts disabled and helper environment scoped to that process;
4. resolve the requested ref to a commit object;
5. check out the detached commit into the declared destination;
6. remove helper, environment, remotes, temporary refs, and acquisition-only state;
7. reject submodules rather than acquiring undeclared sources;
8. verify the real path and every parent remain within staging;
9. record requested repository/ref and resolved commit; and
10. atomically publish only after the complete workspace passes validation.

Do not put credentials in command arguments, repository URLs, manifests, logs, errors, verifier requests, or metadata.

### Verification

- A mutable branch resolves once and records its commit.
- Two sources with different destinations compose into one seed.
- Invalid refs, submodules, symlink escapes, cancellation, and acquisition failure publish no seed.
- Success, failure, and cancellation prove the credential environment reaches only Git and temporary state is deleted.
- Delegate and verifier children receive none of the source credential names or values.
- A fixture repository cannot mutate the source repository through the seed.

## Phase 3: OCI source materialization

### Changes

Implement `sources/oci.ts` behind an `OciMaterializer` interface. The initial adapter invokes the runtime-supplied ORAS 1.x executable with literal arguments and no shell.

For each OCI source:

1. require `repository@sha256:<digest>` as the effective fetch identity;
2. fetch and verify the manifest descriptor and selected digest;
3. accept only uncompressed regular-file layers with valid relative `org.opencontainers.image.title` values;
4. reject archives, compressed layers, duplicate or overlapping titles, and unsupported media types;
5. reject before pull when descriptor sizes exceed configured limits;
6. pull into a private empty directory with timeout and cancellation;
7. verify actual files and bytes do not exceed descriptors or limits;
8. reject device files, FIFOs, sockets, escaping symlinks, hardlinks outside the tree, and absolute paths;
9. copy validated payloads to declared destinations;
10. remove registry configuration and acquisition state; and
11. record repository, digest, media types, descriptor sizes, and materializer version.

Registry credentials come from `ALLAGENTS_ORAS_AUTH_FILE`. Copy that file with mode `0600`, pass the copy only to ORAS, and delete it in `finally`.

### Verification

- A disposable local OCI registry serves a pinned uncompressed file artifact.
- A valid artifact materializes the expected tree and manifest digest.
- Digest mismatch, compressed/archive layouts, malicious titles, size overflow, timeout, cancellation, and authentication failure publish no seed.
- Overflow rejection occurs before payload download and staging never exceeds the configured maximum.
- Registry configuration is deleted and credentials reach neither metadata nor delegate/verifier environments.

## Phase 4: Seed pool and private checkouts

### Changes

Implement `seed-pool.ts` and `checkout.ts`:

- each `Provider` instance owns one seed pool and request-resolution map beneath a package-owned leased runtime root;
- concurrent calls for one canonical request share one resolution promise;
- the first successful commit/digest is pinned for that request for the provider instance;
- requests resolving to one manifest share one seed preparation promise;
- failed resolution or preparation entries are removed so later calls may retry;
- completed seeds remain immutable for their retained lifetime;
- each call receives a unique contained checkout;
- checkout creation uses a verified reflink/copy-on-write clone when available and recursive copy otherwise;
- writable hardlinks are prohibited;
- checkout removal is idempotent and always attempted before `callApi()` settles;
- provider cleanup aborts active calls, waits for their process groups, then removes shared staging and seeds with all-settled semantics; and
- provider construction reaps only versioned ownership-marked roots whose lease is no longer live.

Source-acquisition abort and per-call abort remain separate so cancelling one row cannot corrupt a seed in use by another row.

### Verification

- Twenty concurrent checkouts share one seed preparation and receive distinct writable roots.
- Concurrent calls while a ref moves share the first resolution; a new provider instance resolves the new target.
- Mutation in one checkout changes neither seed nor sibling checkout.
- Partial copies, cancellation, verifier failure, and process errors attempt immediate checkout removal; an injected removal failure produces a provider error and retains only an opaque ownership-marked path for recovery.
- Ownership markers and live leases prevent cleanup or stale recovery from deleting unowned or live paths.
- A successful `callApi()` returns only after its checkout is gone.

## Phase 5: Agent-attributed file changes

### Changes

Implement `workspace-core/src/file-changes.ts` and establish baselines while each checkout is still clean.

For Git sources:

1. create a package-owned private index loaded from the immutable source commit;
2. refresh and verify the clean baseline without touching the checkout's real index;
3. freeze baseline ignore rules before agent execution;
4. disable replacement objects, ambient Git config, external diff, filesystem monitors, untracked caches, and optional locks for every collector command;
5. discover tracked changes against the explicit immutable commit and untracked additions after the delegate stops;
6. preserve agent commits and staging as ordinary changes relative to that baseline; and
7. never invoke `git add`, update a ref, change a remote, or write the checkout's real index.

OCI sources reuse the verified seed inventory. A separate bounded contained walk finds agent additions outside declared source destinations. Candidate reads use no-follow file descriptors and stable pre/post metadata checks. Files and symlink targets are encoded from exact bytes; the unified text diff is optional convenience data. Candidate and output ordering is deterministic.

Capture runs before verifier launch. A complete result includes every changed path within the workspace contract. Limits return `truncated` with stable codes and bounded omitted paths. An internal timeout or operational failure returns `failed` with a stable bounded message and no partial capture; overall cancellation aborts the row instead. A non-cancellation capture failure does not prevent the verifier from inspecting the still-live checkout.

### Verification

- Tests cover added, modified, deleted, renamed, binary, executable, symlink, ignored, and outside-source files.
- Agent commits, staging, replacement refs, and `.gitignore` edits cannot redefine or hide the immutable baseline.
- Generated bytes round-trip exactly through base64; binary files are never UTF-8 decoded.
- The unified diff covers bounded text additions, modifications, and deletions and becomes explicitly truncated at its limit.
- Candidate, file, total-byte, diff, subprocess, omitted-path, metadata, timeout, cancellation, and unstable-read limits produce deterministic status and codes.
- The collector leaves the checkout's real index, refs, remotes, source repositories, and seed unchanged.
- Verifier-created files and modifications never appear because capture completed before verifier launch.
- A synthetic large-repository test proves application memory and serialized output remain within published bounds.

## Phase 6: Copilot SDK provider

### Changes

Implement the public-SDK-based provider under `packages/promptfoo-integration/src/copilot/`.

Keep provider and SDK runner responsibilities separate.

**Provider process**

- validate closed public config and trusted loader `basePath`;
- resolve the effective working directory before spawning;
- construct a versioned request containing only required SDK inputs;
- spawn the runner with piped stdio and a minimal allowlisted environment;
- own timeout, cancellation, process-tree termination, protocol parsing, redaction, and OpenTelemetry spans;
- accept one terminal response; and
- return Promptfoo-native output, error, token usage, and bounded metadata.

**Runner process**

- validate the complete request before importing `@github/copilot-sdk`;
- create `CopilotClient` with its TCP runtime and validated working directory;
- create one session with model, reasoning, provider-routing, and permissions;
- delegate execution to shared `runCopilotSession` code used by standalone and composed modes;
- normalize SDK events into bounded protocol frames and Promptfoo-compatible metadata/spans;
- extract final assistant text and usage without exposing credentials;
- disconnect the session, call client `stop`, and call `forceStop` when normal cleanup fails; and
- emit one final or error frame after cleanup completes.

**Protocol and security**

- version every frame;
- reserve stdout for protocol and bound stderr separately;
- keep API keys in request memory and redact them from frames, logs, errors, metadata, and spans;
- default to native Copilot routing when no custom provider is configured;
- require a complete custom-provider tuple;
- start from read-only permissions and require explicit unrestricted-tool opt-in; and
- test SDK upgrades before changing the pinned version.

### Verification

- Fake-runner tests cover success, SDK error, malformed protocol, timeout, cancellation, signal escalation, large output, and redaction.
- A packed-package smoke project installs the optional peer and loads `CopilotSdkProvider` through stock Promptfoo.
- Event mapping proves usage and tool spans are bounded and correctly attributed.
- `skill-used` remains documented unsupported until a public SDK event provides reliable normalized skill identity.
- An opt-in credentialed public-SDK test is available but not required for forked pull requests.

## Phase 7: Delegate protocol and compatibility

### Changes

Implement the process-isolated `delegate-runner` and closed Codex, Claude, and Copilot adapters.

Protocol v1 reserves stdout for newline-delimited frames with `{ version: 1, requestId, type, payload }`. The parent sends one `call` and optional idempotent `abort`. The child constructs its own `AbortController`, rejects unknown or duplicate frames, and emits exactly one terminal `response` or `fatal` after native cleanup. Exported constants bound frame bytes, complete response bytes, stderr bytes, and shutdown grace.

The runner receives trusted `basePath` separately from public config and supplies it to `loadApiProvider` for peer/SDK resolution even though the checkout is elsewhere. Before serialization, the parent folds allowed prompt-level `delegate.config` into the validated effective constructor config and clears `PromptWire.config`. Prompt functions, live provider objects, and process-local context fields never cross the boundary.

Adapters must preserve the entire JSON-safe native response. Codex and Claude use Promptfoo's public `loadApiProvider`; Copilot invokes shared `runCopilotSession` inside the existing runner without nesting process groups. Every adapter uses a minimal environment, binds the owned checkout, forces `bustCache: true`, rejects cached responses, and returns only after cleanup settles.

### Verification

- Contract tests run one fake coding task through all three adapters.
- Attempts to set paths, extra directories, sessions, environment inheritance, cache controls, unknown keys, or acquisition credentials are rejected.
- Every delegate receives the checkout and cache bypass at final precedence and receives no seed, sibling, verifier, or acquisition path.
- Timeout and cancellation prove the runner and descendants are gone before control returns.
- Protocol tests cover early abort, malformed/oversized frames, duplicate terminal frames, bounded stderr, redaction, JSON safety, response-size bounds, and forced process-group escalation.
- Function-backed prompts and live provider objects do not cross serialization; allowed prompt-level model overrides still reach the delegate constructor.
- Direct-versus-wrapped response fixtures compare every standard response field and native metadata key, not only output.

## Phase 8: Verifier runner

### Changes

Implement `verifier.ts` and `verifier-protocol.ts`:

1. resolve `verifier.command` from trusted `basePath` and verify executable regular-file identity before workspace acquisition;
2. reject commands under package-owned runtime roots and symlink targets;
3. wait until the delegate process group is gone;
4. spawn a new verifier process group directly, without a shell, in the checkout current directory;
5. construct a minimal environment from essential platform variables and explicit `verifier.env` only;
6. send one bounded `VerifierRequest`, including the canonical pre-verifier `fileChanges`, on stdin and close stdin;
7. capture bounded stdout and stderr independently;
8. forward cancellation and enforce the lesser of verifier timeout and remaining provider deadline;
9. terminate the complete verifier process group before reading the final workspace-independent result;
10. parse exactly one `VerifierOutput`, validate rewards and evidence, and add measured duration and optional separate trace ID; and
11. return infrastructure errors distinctly from valid zero rewards.

Verifier logic may mutate the checkout while running because no later consumer receives that filesystem. Only returned rewards and evidence survive cleanup.

### Verification

- Executable fixtures cover rewards only, evidence only, both, and a valid zero reward.
- Invalid versions, unknown keys, missing result fields, non-finite/out-of-range rewards, invalid UTF-8, extra documents, trailing text, overflow, timeout, cancellation, and premature exit fail explicitly.
- A verifier that forks a noncooperative child is fully terminated before the provider proceeds.
- The verifier receives the checkout as cwd and the exact bounded prompt, response, row context, immutable provenance, and pre-verifier file changes.
- Verifier configuration and credentials never reach delegate input, environment, metadata, errors, or agent trace.
- Delegate credentials and acquisition channels never reach the verifier environment.
- A verifier trace has a different trace ID and its tool-like spans cannot appear in the agent trace.

## Phase 9: Workspace provider integration

### Changes

Implement `Provider` as the single owner of acquisition, delegation, verification, and row checkout cleanup.

Constructor responsibilities:

- validate exact provider, workspace, delegate, and verifier config;
- extract and realpath trusted `basePath` before public validation;
- resolve and validate the verifier executable before any workspace path exists;
- initialize one owned workspace seed pool;
- resolve only fixed runtime input channels;
- reject nested self-delegation and unsupported adapters; and
- reject reserved path, session, environment, acquisition, verifier, tracing, and cache-control fields at every authored layer.

For each `callApi`:

1. honor an already-aborted signal;
2. acquire an immutable seed, create a unique checkout, and establish its change baseline;
3. construct and run the delegate under the remaining overall deadline;
4. await native delegate cleanup and quiesce its process group;
5. reject cached, malformed, oversized, or non-JSON-safe responses;
6. reject native `metadata.fileChanges`, `metadata.verifier`, or `metadata.allagents` collisions before capture or verifier side effects;
7. capture bounded file changes before launching any verifier code;
8. if a valid response exists and the call is not cancelled, run the verifier with the live checkout and captured changes;
9. preserve the complete delegate response, spread native metadata unchanged, and add `metadata.fileChanges`, `metadata.verifier`, and `metadata.allagents` provenance;
10. stop the verifier process group and remove the checkout in `finally`; and
11. return only after row-local cleanup succeeds.

If a valid delegate response contains an error, verification still runs. If execution fails before a valid response, verification does not run. If verification fails, the call returns a bounded provider error after checkout cleanup. If checkout cleanup itself fails after bounded retries, the call returns a cleanup error, exposes no path, and leaves the root ownership-marked for stale recovery rather than claiming successful removal.

### Verification

- Codex, Claude, and Copilot contract tests execute the same verifier fixture against the same workspace task.
- With Promptfoo caching enabled, identical rows execute independently, mutate distinct workspaces, invoke capture and verifier twice, and never return `cached: true`.
- Two concurrent calls share no writable objects and return isolated file changes.
- A successful return, delegate error response, truncated/failed capture, verifier zero reward, verifier crash, timeout, cancellation, and cleanup failure each follow the specified state transition.
- Valid delegate error responses still produce file changes and verifier results for partial work; transport failures launch neither collector nor verifier.
- No response contains a workspace or artifact-directory path.
- Native `metadata.skillCalls` remains top-level, while native `metadata.fileChanges`, `metadata.verifier`, and `metadata.allagents` collisions fail before collector or verifier launch.
- Changed files appear exactly at `context.providerResponse.metadata.fileChanges`; verifier rewards appear at `context.providerResponse.metadata.verifier.rewards`.
- Verifier mutations cannot alter the already-captured file changes.
- Every successful result leaves no per-call checkout. An injected removal failure returns an explicit provider error and a later invocation safely reaps only its abandoned ownership-marked root.

## Phase 10: Promptfoo assertion and tracing compatibility

### Changes

Build a direct-versus-wrapped compatibility matrix for each supported Promptfoo minor. Use deterministic fixture providers plus live provider smoke tests where credentials are available.

The matrix must exercise:

- `contains`, `regex`, `is-json`, and one provider-specific JavaScript assertion against unchanged output and metadata;
- token usage and cost accounting;
- `skill-used` and `not-skill-used` for delegates that emit normalized `metadata.skillCalls`;
- `trajectory:tool-used`, `trajectory:tool-args-match`, `trajectory:tool-sequence`, and `trajectory:step-count` against an OTLP test collector;
- a JavaScript assertion mapping `metadata.verifier.rewards.correctness` to score and pass/fail;
- an assertion transform projecting `metadata.verifier.evidence` into a native `llm-rubric`;
- a JavaScript assertion verifying changed bytes or the unified diff through `metadata.fileChanges`; and
- verifier commands and judge spans that resemble agent activity but remain absent from the agent trajectory.

Add executable examples for:

- direct Copilot with an existing directory;
- Codex with a Git workspace, generated-file assertion, and deterministic verifier;
- Claude with a Git workspace and verifier evidence consumed by `llm-rubric`;
- Copilot with composed Git and OCI sources;
- verifier-owned agentic judging; and
- parallel rows proving isolated checkout, file capture, and verifier execution.

All verifier executables live beside the Promptfoo config, outside materialized checkouts, and use local deterministic fixtures by default. No example imports repository source directly or contains live credentials.

### Verification

- Clean temporary npm, pnpm, and Bun projects install the packed tarball without the Copilot peer, import default, `Provider`, and `CopilotSdkProvider`, verify default identity, and receive an actionable missing-peer error for Copilot.
- Direct and wrapped providers return equivalent outputs, JSON-safe response fields, usage, native metadata, skills, and agent trajectories.
- Ordinary output assertions pass without a verifier-specific transform.
- Verifier-aware examples reference `context.providerResponse?.metadata?.verifier`, never an AllAgents namespace.
- File-change-aware examples reference `context.providerResponse?.metadata?.fileChanges` and decode exact bytes without a filesystem path.
- Verifier tool activity cannot produce a false-positive `trajectory:*` result.
- The compatibility matrix fails on package loading, response drift, metadata nesting, trace loss, cleanup-before-verification, or checkout survival after return.

## Phase 11: Release

### Changes

1. Confirm npm scope ownership and trusted-publisher configuration.
2. Publish a release candidate under a `next` dist-tag.
3. In smoke project A, install only the integration package; import all public exports and confirm actionable Copilot missing-peer behavior.
4. In smoke project B, install the package and exact Copilot peer; run direct and composed Copilot cases.
5. Run packed and registry-installed compatibility suites.
6. Publish stable `1.0.0` with provenance.
7. Announce the supported Promptfoo range, Node version, ORAS requirement, optional Copilot peer, config schema, file-change and verifier wire contracts, bounds, and assertion compatibility.
8. Update downstream consumers to install the package rather than copy provider implementations.

### Verification

- npm displays provenance.
- `npm view` shows expected repository, license, exports, engines, peers, and dist-tags.
- Fresh smoke projects prove no-peer and exact-peer installation paths.
- The tarball contains no lifecycle subpath, CLI, doctor, config shim, fixtures, credentials, source maps with private paths, or private repository references.

## Required quality gates

Every implementation pull request runs narrow package tests for changed behavior. Before first public release, run once from a clean checkout:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test
bun run build
bun run pack:check
```

The release candidate additionally runs:

- packed-package stock-Promptfoo provider and export compatibility;
- direct-versus-wrapped response, output assertion, skill, and trajectory parity;
- concurrent workspace and verifier isolation E2E;
- bounded file-change E2E proving exact binary capture, agent attribution before verifier mutation, explicit truncation/failure, and unchanged real Git indexes;
- verifier-before-cleanup E2E across success, zero reward, delegate error response, verifier error, timeout, and cancellation;
- Git provenance E2E;
- OCI digest/authentication E2E against a disposable registry;
- Copilot protocol and cancellation E2E with a fake runner, including forced outer-runner death; and
- credentialed live-provider smoke tests when organization secrets are available.

## Completion criteria

- The package is public and installable from npm with provenance.
- Stock Promptfoo loads `Provider` and `CopilotSdkProvider` through documented named exports.
- `Provider` calls Promptfoo's original Codex and Claude providers and the package-local Copilot runtime through closed adapters.
- Git and OCI inputs produce immutable provenance and private per-call checkouts.
- Concurrent calls share no writable filesystem objects.
- Each delegate is fully stopped before its verifier starts; each verifier is fully stopped before cleanup; and every successful response is returned only after checkout removal succeeds.
- The complete JSON-safe native delegate response survives wrapping; ordinary output, usage, provider-specific, skill, and trajectory assertions behave as documented.
- Bounded generated/deleted files and a unified diff survive result serialization at `metadata.fileChanges`; verifier rewards and evidence survive at `metadata.verifier`; Promptfoo assertions decide score and pass/fail.
- Agent and verifier traces are separate, and verifier activity can alter neither captured agent file changes nor trajectory assertions.
- No response exposes a workspace path, artifact-directory path, or verifier implementation path.
- Source, delegate, and verifier credentials remain isolated from one another and absent from results, logs, errors, and traces.
- No lifecycle extension, configuration doctor, Promptfoo authoring compiler, network gateway, or custom assertion engine is introduced.
