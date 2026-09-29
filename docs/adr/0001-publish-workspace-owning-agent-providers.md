# ADR 0001: Publish a workspace-owning Promptfoo integration package

- Status: Proposed
- Date: 2026-09-29

## Context

AllAgents needs an open-source Promptfoo provider for the GitHub Copilot SDK. Coding-agent evaluations also need reproducible workspaces assembled from exact Git and OCI inputs, independent per-call write trees, trustworthy grading while those trees still exist, cancellation, and deterministic cleanup.

Promptfoo already supplies capable `openai:codex-sdk` and `anthropic:claude-agent-sdk` providers. Reimplementing those integrations would duplicate model invocation, metadata, streaming, tracing, and provider-specific behavior. A separate execution gateway would add a network protocol, queue, durable state, and another evaluation boundary that local and CI jobs do not require.

Promptfoo assertions run after a provider returns. Letting an assertion inspect a live checkout would therefore require a cross-cutting lifecycle extension and a transient filesystem path in persisted result metadata. Promptfoo 0.122.0 does not consistently invoke provider `cleanup()`, so evaluation-scoped cleanup cannot safely own those paths.

Coding-agent harnesses already solve this boundary before destroying the environment. [Harbor verifiers](https://docs.harborframework.com/core-concepts/tasks/verifier) run after the agent in the task environment and return rewards. [Vercel Agent Eval](https://github.com/vercel-labs/agent-eval/blob/7e9aae4f7779f080af785ec88c17ef3c2ab3cebd/packages/agent-eval/src/lib/agents/plugin/orchestrator.ts) runs validation, captures generated and deleted files, and then stops its sandbox. Feature parity requires durable changed-file data after cleanup, but copying Agent Eval's unbounded `git add .` and whole-file capture would be unsafe for large or composed Git/OCI workspaces.

## Decision

Create the public repository `allagentsdev/promptfoo-integrations` as a Bun workspace that publishes independently versioned npm integrations.

The initial public package is `@allagents/promptfoo-integration`. The name identifies a third-party integration rather than a Promptfoo fork and leaves room for providers and later Promptfoo-facing surfaces. `@allagents/promptfoo-plugins` is not used because Promptfoo already uses plugin terminology for red-team plugins, while `@allagents/promptfoo-tools` would obscure that this package is loaded at runtime as a provider.

The package exports:

- `Provider` — the recommended workspace-owning provider and default export; and
- `CopilotSdkProvider` — the lower-level Copilot SDK provider for callers that already own a workspace.

`Provider` materializes one private checkout, runs one supported delegate, fully stops that delegate, captures bounded agent-attributed file changes, runs one trusted consumer-supplied verifier in the still-live checkout, and attempts checkout removal before settling. It returns a successful Promptfoo response only after removal succeeds and never publishes a workspace path. The response exposes changed-file contents at `metadata.fileChanges` and verifier rewards or evidence at `metadata.verifier`; ordinary Promptfoo assertions remain the scoring system of record.

The package does not ship a lifecycle extension, configuration doctor, executable, unbounded artifact store, or custom assertion package in the initial release.

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

The wrapper configuration is closed:

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
      verifier:
        command: ./verifiers/score
        timeoutMs: 120000
        env:
          JUDGE_API_KEY: "{{env.JUDGE_API_KEY}}"
      timeoutMs: 900000
```

`delegate` is a discriminated union for the three supported IDs. Each delegate has an internal adapter and an explicit field allowlist; the initial release excludes extra directories, session reuse, settings/plugin discovery, executable overrides, arbitrary native passthroughs, environment inheritance, and function-valued hooks. Prompt-level configuration may override only fields under `delegate.config`. The wrapper validates the merged allowlisted config and injects its validated absolute checkout path as `working_dir` last.

The verifier executable is trusted configuration, analogous to a JavaScript assertion. A relative `verifier.command` resolves from Promptfoo's loader-provided config base, not the checkout or process current directory. It must resolve to an executable regular file outside the package-owned workspace root. The provider invokes it directly without a shell, uses the checkout as its current working directory, passes literal configured arguments, and never copies the executable or its source into the checkout. The verifier path and configuration are never sent to the delegate.

“Not sent to the delegate” is an accidental-disclosure boundary, not a hostile same-user sandbox. A shell-capable malicious agent can traverse other host paths. Evaluating untrusted agents or keeping verifier logic secret requires a container, VM, or separate OS identity and remains a follow-up decision.

### Provider-owned execution sequence

One `Provider.callApi()` owns the complete row-local resource lifetime:

1. validate the closed provider, workspace, delegate, and verifier configuration before creating a path;
2. resolve mutable source requests to immutable identities and obtain an immutable seed;
3. create one private writable checkout and its package-owned change baseline;
4. merge allowed prompt-level delegate fields, inject the checkout as final-precedence `working_dir`, and force a response-cache miss;
5. run the delegate in a process group with a minimal environment and the caller's cancellation signal;
6. accept one complete JSON-safe Promptfoo response, wait for native delegate cleanup, and quiesce the delegate process group;
7. reject native `metadata.fileChanges`, `metadata.verifier`, or `metadata.allagents` collisions before file capture or verifier side effects;
8. capture bounded file changes before any verifier command can mutate the checkout;
9. run the verifier with the checkout as its current working directory, the captured changes in its request, and a separate minimal environment;
10. parse one bounded verifier result and combine it with the native delegate response and file changes;
11. terminate the verifier process group and remove the checkout in `finally`; and
12. return the response only after cleanup succeeds, or return a bounded provider error when execution, verification, or cleanup fails.

A valid delegate response containing an ordinary provider-level `error` still reaches the verifier so partial workspace work can be graded. A malformed protocol, unbounded response, premature runner exit, or other failure before a valid delegate response skips verification and proceeds directly to cleanup.

A zero reward is an evaluation outcome, not infrastructure failure. Verifier launch failure, timeout, cancellation, malformed output, output overflow, or cleanup failure is a provider error and must not be represented as a zero score.

A cleanup error cannot guarantee immediate filesystem removal. The provider retries within a fixed bound, returns an infrastructure error, exposes no path, and leaves any unreleased root ownership-marked for safe stale recovery.

`Provider.cleanup()` remains an idempotent fallback for shared seeds and interrupted calls, not the normal checkout lifetime boundary. Provider construction may reap only versioned, ownership-marked runtime roots whose lease is no longer live. The provider never depends on a Promptfoo lifecycle hook to release a successful call's checkout.

### Delegate contract and native response compatibility

The initial delegate allowlist is deliberately closed:

- `openai:codex-sdk`;
- `anthropic:claude-agent-sdk`; and
- `copilot-sdk`.

Inside the isolated runner, the wrapper uses Promptfoo's public `loadApiProvider` API for Codex and Claude. The Copilot adapter calls the package's shared Copilot session runtime directly inside that runner; it does not construct `CopilotSdkProvider` or create a second detached process group. Standalone `CopilotSdkProvider` wraps the same session runtime in its own runner.

`@github/copilot-sdk` is an optional peer dependency. Selecting `copilot-sdk` or directly calling `CopilotSdkProvider` without installing it returns an actionable configuration error, while Codex- and Claude-only consumers do not install the SDK. Arbitrary Promptfoo providers are unsupported. A new delegate requires an adapter that proves the same path, serialization, cancellation, cache, metadata, and tracing invariants.

The delegate runner protocol is versioned JSON Lines. A request contains a `PromptWire` DTO (`id`, `raw`, `template`, `display`, `label`, `provider`, and `config: {}`) plus only the wire-safe context fields consumed by supported delegates: variables, debug state, JSON-safe test metadata, `bustCache: true`, W3C tracing fields, evaluation/test IDs, and row/prompt/repeat indices. The parent folds the allowed prompt-level `delegate.config` override into the validated effective delegate config before serialization, then supplies that config only to the delegate constructor. Prompt functions, live provider objects, `filters`, `getCache`, `logger`, `originalProvider`, and live `AbortSignal` objects never cross the boundary.

The terminal delegate frame carries the complete JSON-safe Promptfoo `ProviderResponse`, not a hand-picked output subset. Supported adapters normalize their native result to Promptfoo's public response shape before serialization. The parent validates response size and JSON safety and round-trips every field without renaming or dropping it. It then creates a new metadata object by preserving every native metadata key and adding `fileChanges`, `verifier`, and the vendor-specific `allagents` provenance block. Existing values at any of those keys are explicit compatibility errors rather than overwrite targets.

This preservation contract keeps normal output assertions, provider-specific JavaScript assertions, token usage, cost data, raw response data, and top-level `metadata.skillCalls` behavior intact. In particular, `skill-used` reads `metadata.skillCalls`; nesting native metadata beneath another key would be a breaking bug. Copilot supports `skill-used` only after its adapter can derive reliable normalized skill calls from public SDK events. It must not infer skill use from assistant text.

Workspace-backed calls never consume a cached delegate response. Every adapter must prove a reliable cache-read bypass, the wrapper sets `bustCache: true` at final precedence, and a response with `cached: true` fails closed. Global `evaluateOptions.cache: false` remains optional cache-write hygiene rather than a correctness prerequisite.

The child receives `traceparent` and `tracestate` and exports agent spans through explicitly configured OpenTelemetry export settings; no in-memory cache or tracer object crosses the process boundary. Agent tool spans remain on the Promptfoo row trace so `trajectory:*` assertions observe the same delegate activity through the wrapper as they do directly. Verifier execution starts a separate trace and receives no agent trace context. Its commands, tools, or judge calls must never satisfy an agent trajectory assertion. When present, the verifier trace ID is returned only in `metadata.verifier.traceId`.

### Verifier wire contract

The provider sends one bounded JSON document to verifier stdin after the agent has stopped:

```ts
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
```

The checkout path is not serialized because the verifier runs with that checkout as its current working directory. The request includes the agent's output and metadata so a verifier can combine repository inspection with the agent's explanation. The verifier must treat agent-authored text and files as untrusted evidence, not as an authoritative report of what changed or whether the task passed.

The verifier reserves stdout for exactly one JSON document:

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

At least one of `rewards` or `evidence` is required. Reward keys are non-empty stable identifiers and values are finite numbers from zero through one. Evidence must be JSON-safe and fit the package's exported serialized-byte limit. Stdout, stderr, request bytes, result bytes, elapsed time, and process shutdown are independently bounded. Unknown fields fail validation so an accidental protocol change cannot silently enter persisted Promptfoo results.

The provider adds the result at the generic path `response.metadata.verifier`, deliberately not `metadata.allagents.verifier`. This leaves assertion configuration independent of the package name and aligns with a shape Promptfoo could standardize upstream. AllAgents-specific provenance remains separate:

```ts
interface WorkspaceProvenance {
  manifestDigest: `sha256:${string}`;
  sources: ResolvedSource[];
}

interface AllAgentsMetadata {
  schemaVersion: 1;
  delegate: {
    id: "openai:codex-sdk" | "anthropic:claude-agent-sdk" | "copilot-sdk";
  };
  workspace: WorkspaceProvenance;
}

interface IntegratedMetadata extends Record<string, unknown> {
  // Native delegate keys, including skillCalls, remain at this level.
  fileChanges: FileChanges;
  verifier: VerifierMetadata;
  allagents: AllAgentsMetadata;
}
```

Promptfoo remains the evaluation system of record. Existing assertions continue to consume the unchanged delegate output. Workspace-aware assertions consume verifier rewards or evidence, for example:

```yaml
assert:
  - type: javascript
    value: |
      const verifier = context.providerResponse?.metadata?.verifier;
      const score = verifier?.rewards?.correctness;
      return {
        pass: typeof score === 'number' && score >= 0.8,
        score: typeof score === 'number' ? score : 0,
        reason: verifier?.evidence?.summary ?? 'Verifier returned no summary',
      };
```

A native Promptfoo `llm-rubric` can grade the normal agent output, or an assertion-level transform can project `context.providerResponse?.metadata?.verifier?.evidence` as the rubric input. A verifier may itself call a model or agentic judge when it needs live workspace tools. Its usage belongs to verifier metadata or its separate trace and is never merged into the delegate's `tokenUsage` or agent trajectory.

### File-change contract

The provider captures changes after the agent process group is gone and before starting the verifier. This ordering attributes the result to the agent rather than to tests, package installation, an LLM judge, or other verifier activity. The verifier receives the same capture in its request and may add task-specific explanations or diffs beneath its bounded `evidence`; Promptfoo assertions later consume only serialized response metadata, never a filesystem path.

`metadata.fileChanges` provides Agent Eval's generated/deleted-file capability with explicit bounds and byte-safe encoding:

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

`generatedFiles` contains exact after-bytes as base64, including binary files. A symlink entry encodes the link target bytes and never dereferences the link. `deletedFiles` records paths, matching Agent Eval's durable result boundary; deletion contents remain available to the verifier from the immutable source baseline but are not duplicated into Promptfoo results. Renames are a deletion plus an addition or modification rather than a similarity guess. The optional bounded unified diff covers text additions, modifications, and deletions as convenience evidence, never as the source of truth.

The collector uses immutable source baselines rather than the agent's final Git state. Git sources use package-owned private indexes and explicit source commits, with replacement objects, ambient configuration, external diff, filesystem monitors, untracked caches, and optional locks disabled. Baseline ignore rules are frozen before execution so an agent cannot hide a generated file by editing `.gitignore`; agent commits or staging cannot redefine the baseline. OCI sources reuse the verified seed inventory. A bounded contained walk finds additions outside declared source destinations.

Candidate paths are normalized, sorted, and opened without following symlinks. Fixed limits bound elapsed time, candidates, returned files, bytes per file, total captured bytes, diff bytes, Git output, omitted-path reporting, and serialized metadata. Limits produce a `truncated` result with stable codes; operational failure produces `failed` and discards partial capture. Capture failure alone does not replace a valid delegate response or skip verification; overall cancellation still skips verification and proceeds to cleanup. Verifiers and assertions can explicitly reject a non-complete capture when their rubric requires complete file evidence.

The provider adds file changes at the generic `metadata.fileChanges` path rather than beneath `metadata.allagents`, matching the generic `metadata.verifier` placement and leaving room for Promptfoo to standardize either contract upstream.

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

The initial Git adapter accepts `https://` and `file://` repositories and rejects SSH URLs. HTTPS acquisition reads `ALLAGENTS_GIT_USERNAME` and `ALLAGENTS_GIT_TOKEN`, creates a private temporary `GIT_ASKPASS` helper, sets `GIT_TERMINAL_PROMPT=0`, and passes those values only to the Git subprocess. Neither the delegate nor verifier inherits the helper environment or `SSH_AUTH_SOCK`.

OCI acquisition reads the ORAS executable from `ALLAGENTS_ORAS_PATH` and a Docker-compatible auth file path from `ALLAGENTS_ORAS_AUTH_FILE`. It copies the auth file to a private mode-`0600` path for one acquisition and passes only that copy to ORAS. `ALLAGENTS_WORKSPACE_ROOT` optionally selects the owned runtime root. Provider `options.env` takes precedence over `process.env` for these fixed runtime channels. Secret values, helper paths, and auth-file contents are redacted from arguments, bounded stderr, errors, verifier requests, results, and traces; temporary credential state is removed on success, failure, timeout, and cancellation.

Seed publication is atomic. Each provider instance owns one seed pool keyed by the resolved manifest, single-flights concurrent preparation, verifies seed integrity before each clone, and removes failed staging paths immediately. A checkout is a full copy or a copy-on-write clone with no writable hardlinks to the seed or another checkout.

OCI support initially consumes artifacts through an external ORAS 1.x executable supplied by the runtime. The materializer invokes it without a shell, resolves tags before acquisition, uses a digest-qualified reference for the pull, and supports only uncompressed regular-file layers with validated relative titles. It rejects archive and compressed layouts, verifies descriptor byte totals against the configured hard limit before pulling, and validates actual written bytes before publishing a seed. A native OCI client may replace the adapter behind the same source contract later.

The manifest digest is SHA-256 over UTF-8 RFC 8785 canonical JSON containing schema version, materializer versions, and resolved sources sorted by normalized destination.

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

It accepts an existing `working_dir`; it does not resolve Git or OCI sources or run a verifier. The workspace-owning `Provider` composes the same Copilot session runtime with its workspace and verifier lifecycle.

The implementation must follow public Copilot SDK contracts and the provider invariants in this decision. Prior implementations may inform edge cases, but they are neither dependencies nor normative specifications.

### Repository and release policy

The repository is named `promptfoo-integrations`, not `promptfoo-recipes`, because downstream projects execute its packages as production dependencies. Copyable configurations belong under `examples/`.

The package targets Node.js 22.22.0 or newer on Linux and macOS. The initial release is POSIX-only so detached process groups can be terminated reliably. Bun manages workspaces, tests, builds, and release scripts. The package ships ESM, CommonJS, and declaration entrypoints. It bundles the private workspace core while externalizing `promptfoo` and optional `@github/copilot-sdk`. Releases use GitHub trusted publishing with npm provenance and never require a long-lived npm token.

Provider configuration, file-change and verifier protocols, provider metadata, workspace manifests, and runtime environment variable names are versioned public contracts. Breaking changes require a major version.

## Consequences

### Benefits

- Copilot, Codex, and Claude receive one workspace, file-change, and verifier contract.
- Codex and Claude continue to track Promptfoo's maintained implementations.
- Every call receives a private checkout, allowing safe Promptfoo row concurrency.
- Agent-attributed changed-file contents and a bounded unified diff remain available after checkout cleanup.
- Verification happens while the checkout exists, then normal return guarantees row-local cleanup.
- Normal output, usage, skill, provider-metadata, and trajectory assertions remain usable.
- The integration works with stock Promptfoo and needs no lifecycle extension, config shim, authoring compiler, or doctor command.

### Costs

- The wrapper depends on Promptfoo's public provider, response, tracing, and assertion behavior and must test every supported Promptfoo minor.
- Bounded file capture still adds filesystem traversal, hashing, encoding, result size, and latency.
- Consumers must author and maintain a trusted verifier executable.
- OCI users must provide a supported ORAS executable in the initial release.
- A provider wrapper adds one stack layer and two child-process protocols when diagnosing delegated calls.
- Verifier time is included in provider latency, while verifier model usage is separate from delegate usage.

### Risks and mitigations

- **Credential exposure:** acquisition, delegate, and verifier environments are separate allowlists; fixed acquisition credentials reach only source subprocesses, and redaction tests cover every protocol and trace.
- **Verifier disclosure:** the verifier is not copied into the checkout or named in delegate input. Host-path secrecy against a malicious same-user process is explicitly out of scope.
- **Seed mutation:** seed paths are never sent to delegates or verifiers, seeds are treated as immutable, integrity is verified before cloning, and writable hardlinks are prohibited.
- **Cached agent response:** the wrapper forces `bustCache: true` at final precedence and rejects a delegate response marked `cached`.
- **Interrupted cleanup:** each call attempts checkout removal in `finally`; provider cleanup handles active calls and shared seeds; lease-backed stale recovery removes only verified abandoned roots.
- **Recursive delegation:** the wrapper rejects itself and delegate IDs without registered adapters.
- **Native response drift:** packed compatibility tests compare direct and wrapped providers across output, metadata, usage, skills, and traces; unsupported non-JSON values fail rather than disappear.
- **Verifier contamination:** file changes are captured before verifier launch, and verifier work uses a separate trace, so verifier filesystem and tool activity cannot alter agent evidence.
- **Unbounded results:** fixed file-capture, diff, request, stdout, stderr, evidence, timeout, and process-shutdown limits produce explicit truncation or failure.

## Alternatives considered

### Keep the checkout alive for Promptfoo assertions

Rejected. This requires a row lifecycle extension, a transient workspace path in persisted metadata, configuration shims, and recovery machinery because provider cleanup is not a reliable per-row boundary. Running the verifier inside `callApi()` makes the provider own the complete resource lifetime.

### Return unbounded files or a live artifact directory

Rejected. Agent Eval's generated/deleted-file result is valuable compatibility, so the selected design returns it in bounded, byte-safe form. Unbounded whole-file capture or a persisted filesystem path would create result-size, memory, and cleanup hazards. Large durable artifacts require a later artifact-store contract.

### Trust the agent to report changed files or success

Rejected. Agent-authored output and workspace files are untrusted evaluation inputs. The verifier determines rewards and evidence independently.

### Run the verifier as a Promptfoo assertion

Rejected. Assertions execute after `callApi()` returns, which would require keeping the checkout alive outside the provider's lifetime. The provider runs verification before cleanup; Promptfoo assertions consume the durable verifier result afterward.

### Return a verifier-owned filesystem path

Rejected. An assertion that reads a verifier output file after `callApi()` returns recreates the same lifetime and cleanup problem as exposing the checkout. The verifier receives canonical file changes and may generate task-specific evidence while the workspace is live; the provider serializes bounded results into `metadata.fileChanges` and `metadata.verifier`, removes all row-local paths, and then lets assertions inspect those durable values.

### Run the verifier concurrently with the agent

Rejected. Concurrency would expose verifier credentials and implementation to the agent process, race on workspace state, and contaminate traces. The delegate process group is gone before verification begins.

### Implement independent Copilot, Codex, and Claude providers

Rejected. Only Copilot is missing. Reimplementing Codex and Claude would duplicate Promptfoo behavior and increase maintenance.

### Put Git and OCI acquisition directly inside the Copilot provider

Rejected. Source materialization is shared by every delegate. It remains a separate internal module composed by the workspace-owning provider.

### Build a remote execution gateway

Rejected for the initial scope. A network service, durable queue, tenancy, recovery protocol, and remote artifact API are unnecessary for disposable local and CI jobs. They may be reconsidered only for concrete remote-execution or hostile multi-tenant requirements.

### Publish separate workspace and Copilot provider packages

Rejected initially. One package can expose the workspace-owning `Provider` and direct `CopilotSdkProvider`, while keeping `@github/copilot-sdk` optional. This removes a package, release stream, and self-peer dependency without widening the delegate contract.

## Follow-up decisions

A separate ADR is required before:

- replacing the ORAS adapter with a native OCI client;
- supporting arbitrary nested Promptfoo providers;
- publishing workspace core as a public API;
- introducing remote execution or hostile multi-tenant isolation;
- adding a generic durable artifact store or filesystem-path transport;
- standardizing the file-change or verifier contract upstream with Promptfoo; or
- changing the workspace, file-change, verifier, or metadata wire contract incompatibly.
