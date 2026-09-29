# ADR 0001: Publish a workspace-owning Promptfoo integration package

- Status: Proposed
- Date: 2026-09-29

## Context

AllAgents needs an open-source Promptfoo provider for the GitHub Copilot SDK. Coding-agent evaluations also need reproducible workspaces assembled from exact Git and OCI inputs, independent per-call write trees, normal Promptfoo assertions that can inspect those trees, optional durable file-change evidence, cancellation, and bounded resource ownership.

Promptfoo already supplies capable `openai:codex-sdk` and `anthropic:claude-agent-sdk` providers. Reimplementing those integrations would duplicate model invocation, metadata, streaming, tracing, and provider-specific behavior. A separate execution gateway would add a network protocol, queue, durable state, and another evaluation boundary that local and CI jobs do not require.

Promptfoo JavaScript assertions run after a provider returns and receive `context.providerResponse`. A provider can therefore return its private workspace path and let ordinary assertions inspect the final filesystem. Cleaning the workspace inside `callApi()` would make that impossible. A separate pre-return grading abstraction would duplicate Promptfoo assertions and introduce a second scoring model.

Keeping every private workspace until Promptfoo finishes its transforms and assertions is simpler than inventing an earlier row boundary. Promptfoo 0.122.0 and current upstream do not guarantee provider cleanup on every path. The Node [`evaluate()` implementation](https://github.com/promptfoo/promptfoo/blob/0.122.0/src/evaluate.ts) returns without provider cleanup, and the CLI [`doEval` implementation](https://github.com/promptfoo/promptfoo/blob/0.122.0/src/node/doEval.ts) can return on a failed pass-rate threshold before its cleanup loop. The initial contract therefore accepts best-effort cleanup and safely recovers abandoned ownership-marked roots in a later process. It does not wrap `promptfoo eval` merely to guarantee workspace deletion.

Retaining one physical copy of a multi-gigabyte repository per row would be unacceptable. The provider therefore separates a persistent, content-addressed immutable seed cache from private writable views. Safe copy-on-write adapters let a thousand mostly unchanged views share cached repository blocks while giving every row private writable state. A plain symlink or writable hardlink to a seed is not copy-on-write: writes would mutate every row, so either mechanism is prohibited.

[Vercel Agent Eval](https://github.com/vercel-labs/agent-eval/blob/7e9aae4f7779f080af785ec88c17ef3c2ab3cebd/packages/agent-eval/src/lib/agents/shared.ts#L229-L276) returns generated file contents and deleted paths. AllAgents retains this capability as optional bounded metadata. Direct workspace inspection is the primary assertion path; file capture is durable evidence for reports and consumers that need results after cleanup.

## Decision

Create the public repository `allagentsdev/promptfoo-integrations` as a Bun workspace that publishes independently versioned npm integrations.

The initial public package is `@allagents/promptfoo-integration`. The name identifies a third-party integration rather than a Promptfoo fork and leaves room for later Promptfoo-facing modules. `@allagents/promptfoo-plugins` is not used because Promptfoo already uses plugin terminology for red-team plugins.

The package exports:

- `Provider` — the recommended workspace-owning provider and default export; and
- `CopilotSdkProvider` — the lower-level Copilot SDK provider for callers that already own a working directory.

The same package ships an `allagents-promptfoo` executable whose `cache prune` command removes unused immutable seeds. Promptfoo remains the evaluation runner and grader.

Shared workspace implementation begins as a private workspace package. Its runtime and declaration output is bundled into `@allagents/promptfoo-integration`; the published manifest has no dependency on the private package. It becomes public only after a second external consumer requires a supported interface.

### Public provider references

```ts
export class Provider {
  // implementation
}

export class CopilotSdkProvider {
  // implementation
}

export default Provider;
```

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
      fileChanges: true
      timeoutMs: 900000
```

`delegate` is a discriminated union for the three supported IDs. Each delegate has an internal adapter and an explicit field allowlist. The initial release excludes extra directories, session reuse, settings/plugin discovery, executable overrides, arbitrary native passthroughs, environment inheritance, and function-valued hooks. Prompt-level configuration may override only fields under `delegate.config`. The wrapper validates the merged allowlisted config and injects its validated absolute workspace path as `working_dir` last.

`fileChanges` is optional and defaults to `false`. Enabling it captures bounded generated or modified contents, deleted paths, and a unified text diff before `callApi()` returns. It never changes workspace lifetime.

Use stock Promptfoo directly:

```bash
promptfoo eval --config promptfooconfig.yaml
```

Cache maintenance is independent of evaluation execution:

```bash
allagents-promptfoo cache prune
```

Workspace cleanup releases private views when Promptfoo invokes `Provider.cleanup()`; it never deletes reusable immutable seeds.

### Provider-owned call sequence

One `Provider.callApi()` owns execution but deliberately does not own normal row cleanup:

1. validate the closed provider, workspace, and delegate configuration before creating a path;
2. resolve mutable source requests to immutable identities and obtain an immutable seed entry;
3. reserve an opaque workspace ID and contained adapter paths, then atomically publish a pending recovery record;
4. acquire the seed lease and create the private view, persisting teardown state before every irreversible adapter step;
5. transition the recovery record to active and, when `fileChanges` is enabled, establish its package-owned baseline;
6. merge allowed prompt-level delegate fields, inject the workspace path as final-precedence `working_dir`, and force a response-cache miss;
7. run the delegate in a process group with a minimal environment and the caller's cancellation signal;
8. accept one complete JSON-safe Promptfoo response, wait for native delegate cleanup, and quiesce the delegate process group;
9. reject native `metadata.workspace` or `metadata.fileChanges` collisions;
10. optionally capture bounded file changes;
11. preserve the complete delegate response and add workspace metadata plus optional file changes; and
12. return while retaining the private workspace for Promptfoo transforms and assertions.

Construction, acquisition, or execution failure runs the same dependency-ordered teardown recorded for normal cleanup. The pending record exists before any seed lease, inode tree, or mount, so process death never leaves an unknown resource. Once a response containing `metadata.workspace.path` is returned, the provider retains that workspace until `cleanup()` or later stale recovery. No per-row timer may delete it because the provider cannot know when asynchronous assertions have finished.

A valid delegate response containing an ordinary provider-level `error` still receives workspace metadata and optional file changes so assertions can grade partial work. A malformed protocol, oversized response, premature runner exit, or other failure before a valid delegate response runs the recorded teardown chain and returns a provider error. A detach failure keeps the unpublished workspace record and seed lease for later recovery rather than exposing an unsafe lower-layer deletion race.


### Best-effort workspace cleanup and retained roots

`Provider.cleanup()` is the normal boundary for Promptfoo callers. It closes the provider, aborts and awaits active call process groups, and then runs one dependency-ordered teardown chain per workspace:

1. validate the recovery record;
2. detach the adapter view, including a required overlay unmount;
3. only after detachment succeeds, remove private paths and release the seed lease; and
4. mark the record released.

Cleanup is all-settled across independent workspace chains, not across dependent steps inside one chain. A failed detach keeps that record and lease for later recovery. The provider removes independent staging paths, removes the root only when no unreleased record remains, and returns an aggregate error after attempting every chain.

Promptfoo does not guarantee `cleanup()` on every path. Current Node evaluations and some CLI exits can therefore leave a provider root behind. Returned paths are transient but may outlive their evaluation; persisted Promptfoo results must not treat them as durable artifact references. Retaining many mostly unchanged copy-on-write views is acceptable because they share immutable seed blocks, though changed blocks and overlay mounts still require eventual recovery.

GitHub-hosted Actions runners start clean and are destroyed after the job, so abandoned roots cannot leak into a later hosted job. A seed persists across hosted jobs only when a workflow explicitly restores the cache directory. Cache pruning and stale recovery primarily protect local development, long-lived self-hosted runners, and hosted workflows before saving that directory.

Every runtime root has a versioned ownership marker and live process identity. A later provider construction reaps only roots whose marker is valid and whose owner is no longer alive. It never deletes an unmarked root, a live root, or a path outside the configured runtime parent. A same-process Node evaluation whose host skipped cleanup may retain its root until that process exits; this is an accepted limitation.

Hard termination can leave overlay mounts or directories. Each checkout adapter must expose idempotent teardown and stale-recovery operations. Recovery refuses an unknown mount, unexpected ownership, or a path that fails containment checks.

### Persistent immutable seed cache and private writable views

The workspace module is deep: callers configure sources, while cache identity, acquisition locking, lease tracking, eviction, adapter selection, capability probing, block sharing, mount/copy mechanics, and teardown stay behind its interface.

Resolved source manifests address a package-owned seed cache outside provider runtime roots. The default uses the platform cache directory; `ALLAGENTS_CACHE_ROOT` selects another contained package-owned root for self-hosted runners or an explicit GitHub Actions cache. Providers and evaluations reuse one verified read-only seed for the same manifest digest. Cross-process per-digest locks single-flight preparation, and failed preparation never publishes an entry.

A separate cache-wide admission lock protects the 50 GiB allocated-size ceiling. Complete seeds are staged and measured before admission. The admission critical section covers the usage snapshot, LRU selection, candidate eviction, capacity decision, and atomic seed publication, so different digests cannot jointly over-admit. Operations needing both scopes always take the admission lock first and then per-digest locks in sorted digest order. Preparation releases its per-digest lock before admission and rechecks the entry after reacquiring locks in canonical order.

The provider atomically publishes a pending workspace recovery record before it creates a seed lease, inode tree, or mount. The adapter persists enough teardown state before every irreversible creation step and marks the view active only when complete. Cleanup detaches the view before releasing its lease; a failed detach keeps both the record and lease.

An unused seed has no lease record. Automatic garbage collection runs before adding a seed, during later provider construction, and opportunistically from `Provider.cleanup()`. Admission removes unleased least-recently-used entries until the measured staged seed fits the cache-wide ceiling or returns a bounded capacity error. Independent age collection removes entries unused for 30 days. Opportunistic pruning failure is a bounded warning and does not replace the evaluation result. `allagents-promptfoo cache prune` applies the same policy deterministically; `cache prune --all` removes every unleased entry. Both explicit forms return nonzero on failure.

Lease creation, release, and eviction take the per-digest mutation lock under the canonical ordering when admission is also held. A dead process does not make a seed immediately evictable: later provider construction must recover and detach every dependent workspace before releasing its lease. The collector then revalidates package ownership, containment, and absence of every lease record before atomically renaming the entry into package-owned trash. It never evicts a leased seed, follows a cache symlink, or treats workspace cleanup as cache eviction.

The checkout module has three internal adapters:

1. **Reflink/clone adapter** — uses verified filesystem copy-on-write cloning such as Linux `FICLONE` or macOS `clonefile`; each workspace has private inodes while unchanged data blocks remain shared.
2. **Overlay adapter** — uses the immutable seed as a read-only lower layer with one private upper and work directory per workspace; the merged mount is the only path sent to the agent.
3. **Recursive-copy adapter** — portable correctness fallback when safe copy-on-write is unavailable; it may allocate the full workspace size.

Selection is automatic and capability-tested at runtime. An adapter is accepted only after a throwaway write proves that mutating its private view cannot change the seed or a sibling view. Failed capability probes clean their state and fall through. Package metadata and documentation report the platforms on which each adapter is supported.

Writable symlinks, bind mounts of a writable seed, and writable hardlinks are prohibited. Symlinks inside source content remain ordinary source entries and are validated for containment; they are not a checkout-sharing mechanism.

Copy-on-write allocation is approximately one seed plus each row's changed blocks, rather than one full repository per row. This is not a universal guarantee: reflink metadata, overlay upper layers, agent-generated dependencies, and recursive-copy fallback can still consume substantial disk. Concurrency and free-space behavior require a thousand-view scale test with a multi-gigabyte seed.

### Delegate contract and native response compatibility

The initial delegate allowlist is deliberately closed:

- `openai:codex-sdk`;
- `anthropic:claude-agent-sdk`; and
- `copilot-sdk`.

Inside the isolated runner, the wrapper uses Promptfoo's public `loadApiProvider` API for Codex and Claude. The Copilot adapter calls the package's shared Copilot session runtime directly inside that runner; it does not construct `CopilotSdkProvider` or create a second detached process group. Standalone `CopilotSdkProvider` wraps the same session runtime in its own runner.

`@github/copilot-sdk` is an optional peer dependency. Selecting `copilot-sdk` or directly calling `CopilotSdkProvider` without installing it returns an actionable configuration error. Arbitrary Promptfoo providers are unsupported. A new delegate requires an adapter that proves the same path, serialization, cancellation, cache, metadata, and tracing invariants.

The delegate runner protocol is versioned JSON Lines. A request contains a JSON-safe `PromptWire` plus only context fields consumed by supported delegates: variables, debug state, test metadata, `bustCache: true`, W3C tracing fields, evaluation/test IDs, and row/prompt/repeat indices. Prompt functions, live provider objects, filters, cache functions, loggers, and live `AbortSignal` objects never cross the boundary.

The terminal frame carries the complete JSON-safe Promptfoo `ProviderResponse`, not a hand-picked output subset. The parent validates response size and JSON safety and round-trips every field without renaming or dropping it. It creates a fresh metadata object by preserving every native key and adding `workspace` plus optional `fileChanges`. Existing values at either reserved key are compatibility errors before capture or publication.

This preservation contract keeps normal output assertions, provider-specific JavaScript assertions, token usage, cost data, raw response data, and top-level `metadata.skillCalls` behavior intact. Copilot supports `skill-used` only after its adapter can derive reliable normalized skill calls from public SDK events. It must not infer skill use from assistant text.

Workspace-backed calls never consume a cached delegate response. Every adapter must prove a reliable cache-read bypass, the wrapper sets `bustCache: true` at final precedence, and a response with `cached: true` fails closed.

The child receives `traceparent` and `tracestate` and exports agent spans through explicit OpenTelemetry settings. Agent tool spans remain on the Promptfoo row trace so `trajectory:*` assertions observe the same delegate activity through the wrapper as they do directly.

### Workspace metadata contract

The wrapper preserves native metadata at the top level and adds:

```ts
interface WorkspaceMetadata {
  schemaVersion: 1;
  path: string;
  manifestDigest: `sha256:${string}`;
  sources: ResolvedSource[];
  cleanup: "best-effort-evaluation";
}

interface IntegratedMetadata extends Record<string, unknown> {
  // Native delegate keys, including skillCalls, remain at this level.
  workspace: WorkspaceMetadata;
  fileChanges?: FileChanges;
}
```

`workspace.path` is an absolute local path. It remains valid through transforms and assertions when Promptfoo evaluates the row normally. It becomes invalid when provider cleanup, later stale recovery, or host teardown removes the runtime root. The `cleanup` value makes the lack of a guaranteed Promptfoo cleanup boundary explicit.

Assertions inspect the workspace directly:

```yaml
assert:
  - type: javascript
    value: |
      const root = context.providerResponse?.metadata?.workspace?.path;
      if (!root) return { pass: false, score: 0, reason: 'Missing workspace path' };
      // Resolve only expected contained paths beneath root, then inspect them.
      return { pass: true, score: 1 };
```

### Optional file-change contract

When `fileChanges: true`, the provider adds `metadata.fileChanges`:

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

`generatedFiles` contains exact after-bytes as base64, including binary files. A symlink entry encodes link-target bytes and never dereferences it. `deletedFiles` records paths. Renames are represented as delete plus generate rather than inferred by similarity. The optional unified diff is bounded convenience data for text additions, modifications, and deletions.

The collector uses immutable source baselines rather than the agent's final Git state. Git sources use package-owned private indexes and explicit source commits. Agent commits, staging, replacement refs, or `.gitignore` edits cannot redefine the baseline. OCI sources reuse their verified seed inventory. A bounded contained walk finds additions outside source destinations.

Fixed limits bound time, candidates, returned files, bytes per file, total captured bytes, diff bytes, subprocess output, omitted paths, and serialized metadata. Limits produce explicit `truncated` results; operational failure produces `failed` with no partial capture. File capture failure does not invalidate an otherwise valid delegate response.

Assertions may inspect `context.providerResponse.metadata.fileChanges` without reading the live workspace. When disabled, the key is absent rather than containing a synthetic empty result.

### Workspace source contract

A workspace specification contains one discriminated `sources` collection:

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

Every source request has a contained, non-overlapping destination. Git refs and OCI tags are requests; response metadata records resolved commits and manifest digests.

The initial Git adapter accepts `https://` and `file://` repositories and rejects SSH URLs. HTTPS acquisition reads fixed `ALLAGENTS_GIT_USERNAME` and `ALLAGENTS_GIT_TOKEN` channels and scopes them only to Git. OCI acquisition reads `ALLAGENTS_ORAS_PATH` and `ALLAGENTS_ORAS_AUTH_FILE`, copies registry configuration to private temporary state for one acquisition, and deletes it in `finally`. `ALLAGENTS_WORKSPACE_ROOT` optionally selects the owned runtime parent; `ALLAGENTS_CACHE_ROOT` optionally selects the separate package-owned seed-cache root. All six names are reserved from delegates.

Secret values, helper paths, and auth-file contents are redacted from arguments, bounded stderr, errors, metadata, and traces. Neither delegates nor assertions receive acquisition credentials through the provider.

Seed publication is atomic. OCI support initially invokes a runtime-supplied ORAS 1.x executable without a shell, resolves tags before acquisition, pulls by digest, accepts only bounded uncompressed regular-file layers with validated relative titles, and rejects archive/compressed layouts and special files.

The manifest digest is SHA-256 over UTF-8 RFC 8785 canonical JSON containing schema version, materializer versions, and resolved sources sorted by normalized destination.

### Copilot SDK provider

The lower-level `CopilotSdkProvider` owns Copilot SDK process/protocol handling, a minimal child environment, model and permission options, cancellation, timeout, process-tree termination, Promptfoo-compatible metadata and spans, usage, and redaction.

It accepts an existing `working_dir`; it does not resolve sources, retain workspaces, or capture files. The workspace-owning `Provider` composes the same Copilot session runtime with its workspace lifetime.

### Repository and release policy

The repository is named `promptfoo-integrations`, not `promptfoo-recipes`, because downstream projects execute its packages as production dependencies. Copyable configurations belong under `examples/`.

The package targets Node.js 22.22.0 or newer on Linux and macOS. Bun manages workspaces, tests, builds, and release scripts. The package ships ESM, CommonJS, and declaration entrypoints. It bundles private workspace implementation while externalizing `promptfoo` and optional `@github/copilot-sdk`. Releases use GitHub trusted publishing with npm provenance.

Provider configuration, workspace metadata, optional file-change results, manifests, and runtime environment variable names are versioned public contracts. Breaking changes require a major version.

## Consequences

### Benefits

- Promptfoo's existing assertions remain the only grading model.
- Assertions inspect the exact final workspace through provider metadata while it remains available.
- Copilot, Codex, and Claude share one workspace and optional file-change contract.
- Persistent immutable seeds and private copy-on-write views let a thousand retained workspaces share one multi-gigabyte repository on supported filesystems.
- Native output, usage, skill, provider metadata, and trajectory assertions remain usable.
- Stock Promptfoo remains the runtime entrypoint.
- Workspace cleanup never discards a reusable seed; explicit and automatic cache pruning target only unleased entries.

### Costs

- Direct Promptfoo and same-process Node evaluations can retain roots until process exit when Promptfoo skips provider cleanup.
- Persistent seeds intentionally consume cache disk until age or allocated-size policy evicts them.
- Recursive-copy fallback may allocate the full seed for every row.
- Optional file capture adds traversal, hashing, encoding, result size, and latency.
- A provider wrapper adds one stack layer when diagnosing delegated calls.
- OCI users must provide a supported ORAS executable initially.

### Risks and mitigations

- **Shared-seed mutation:** seeds are immutable; capability probes must prove view isolation; writable symlinks and hardlinks are prohibited.
- **Disk exhaustion:** serialize cache-wide admission and eviction, enforce allocated-size and unused-age limits, evict only unleased least-recently-used seeds, publish thousand-view scale measurements, and document recursive-copy cost.
- **Skipped cleanup:** provider roots are ownership-marked and carry live process identity so a later provider reaps only abandoned state; hosted runner teardown is the final CI backstop.
- **Credential exposure:** acquisition and delegate environments are separate allowlists with redaction tests.
- **Cached agent response:** force `bustCache: true` and reject `cached: true`.
- **Native response drift:** compare direct and wrapped providers across output, metadata, usage, skills, and traces.
- **Unbounded capture:** fixed limits produce explicit truncation or failure.
- **Recursive delegation:** reject the wrapper itself and delegates without registered adapters.

## Alternatives considered

### Run grading inside the provider

Rejected. Promptfoo already has deterministic, JavaScript, model-graded, and trajectory assertions. A pre-return grader would duplicate concepts, configuration, scores, errors, and model usage.

### Use a row lifecycle extension

Rejected for the initial release. It can release a workspace immediately after assertions, but it adds configuration, module-coordination, and hook-ordering surface to every consumer. Evaluation-scoped retention is simpler and copy-on-write storage bounds normal disk growth.

### Never attempt cleanup

Rejected. Promptfoo may skip cleanup, but `Provider.cleanup()` still removes roots on supported paths, and stale recovery handles later processes. Intentional permanent retention would turn temporary evaluation data into an unmanaged artifact store.

### Use symlinks to the cached repository

Rejected for writable workspace content. Writes through a symlink mutate the shared target. Only a read-only lower layer behind a private copy-on-write view is safe.

### Delete the seed cache after every evaluation

Rejected. Workspace cleanup owns private views and leases, not reusable immutable inputs. Deleting a multi-gigabyte seed after every run would make the cache ineffective. Independent lease-aware garbage collection removes only unused entries under age and allocated-size policy.

### Require a reliable upstream cleanup release

Rejected as a release blocker. A future Promptfoo outer-`finally` cleanup guarantee would improve lifetime behavior, but the package can operate with explicit best-effort retention and stale recovery.

### Monitor Promptfoo JSONL to clean workspaces

Rejected. JSONL is optional output, is normally written after evaluation, and may be buffered or interrupted. Copy-on-write views make workspace count acceptable, while output-driven deletion would add an unsafe path authority for little benefit.

### Return unbounded files or a durable artifact directory

Rejected. Bounded optional file changes provide Agent Eval compatibility without introducing a persistent artifact-store interface.

### Implement independent Copilot, Codex, and Claude providers

Rejected. Only Copilot is missing. Reimplementing Codex and Claude would duplicate Promptfoo behavior and increase maintenance.

### Build a remote execution gateway

Rejected for the initial scope. A network service, queue, tenancy, and remote artifact interface are unnecessary for local and CI evaluations.

## Follow-up decisions

A separate ADR is required before:

- replacing ORAS with a native OCI client;
- supporting arbitrary nested Promptfoo providers;
- publishing workspace core as a public interface;
- introducing remote execution or hostile multi-tenant isolation;
- adding a durable artifact store;
- guaranteeing cleanup through a new Promptfoo host contract;
- adding a Promptfoo eval wrapper or lifecycle integration; or
- changing the workspace or file-change metadata incompatibly.
