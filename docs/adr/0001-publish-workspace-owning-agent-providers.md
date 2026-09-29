# ADR 0001: Publish a workspace-owning Promptfoo integration package

- Status: Proposed
- Date: 2026-09-29

## Context

AllAgents needs an open-source Promptfoo provider for the GitHub Copilot SDK. Coding-agent evaluations also need reproducible private writable workspaces assembled from exact Git and OCI inputs, independently protected or writable source trees, normal Promptfoo assertions that can inspect those trees, optional durable file-change evidence, cancellation, and bounded resource ownership.

Promptfoo already supplies capable `openai:codex-sdk` and `anthropic:claude-agent-sdk` providers. Reimplementing those integrations would duplicate model invocation, metadata, streaming, tracing, and provider-specific behavior. A separate execution gateway would add a network protocol, queue, durable state, and another evaluation boundary that local and CI jobs do not require.

Promptfoo JavaScript assertions run after a provider returns and receive `context.providerResponse`. A provider can therefore return its workspace path and let ordinary assertions inspect the final filesystem. Cleaning up a row inside `callApi()` would make that impossible. A separate pre-return grading abstraction would duplicate Promptfoo assertions and introduce a second scoring model.

The provider keeps each row's writable workspace and source leases available while Promptfoo runs transforms and assertions. Promptfoo 0.122.0 and current upstream do not guarantee that they will call provider cleanup afterward. The Node [`evaluate()` implementation](https://github.com/promptfoo/promptfoo/blob/0.122.0/src/evaluate.ts) returns without provider cleanup. The CLI [`doEval` implementation](https://github.com/promptfoo/promptfoo/blob/0.122.0/src/node/doEval.ts) can return before its cleanup loop if a pass-rate threshold fails. We therefore make cleanup best-effort and let a later process recover abandoned workspaces with valid ownership markers. We do not wrap `promptfoo eval` just to force deletion.

Keeping a physical copy of a multi-gigabyte repository for every row would use too much disk. Instead, the provider caches one immutable source seed and gives each row a private writable source view or a link to a protected read-only checkout. On filesystems that support copy-on-write, a thousand mostly unchanged writable views can share the seed's unchanged data blocks. A plain symlink or writable hardlink to the seed cannot serve as a writable view: a write would change the shared content for other rows. Neither is allowed for writable source content.

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

`delegate` is a discriminated union for the three supported IDs. Each delegate has an internal adapter and an explicit field allowlist. The initial release excludes extra directories, session reuse, settings/plugin discovery, executable overrides, arbitrary native passthroughs, environment inheritance, and function-valued hooks. Prompt-level configuration may override only fields under `delegate.config`. The wrapper validates the merged allowlisted config and sets its private workspace root as `working_dir` last. Codex checks that its working directory is inside a Git repository, but source repositories sit beneath the workspace root. The wrapper therefore sets Codex's `skip_git_repo_check: true` last; neither provider configuration nor prompt overrides may change it. This skips Codex's root check, not the provider's source validation or isolation.

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
4. acquire the seed lease, create a private writable workspace root, and materialize each source as either a private writable view or a reference to a protected shared read-only checkout, persisting teardown state before every irreversible step;
5. transition the recovery record to active and, when `fileChanges` is enabled, establish its package-owned baseline;
6. merge allowed prompt-level delegate fields, inject the private workspace path as final-precedence `working_dir` (and `skip_git_repo_check: true` for Codex), and force a response-cache miss;
7. run the delegate in a process group with a minimal environment and the caller's cancellation signal;
8. accept one complete JSON-safe Promptfoo response, wait for native delegate cleanup, and quiesce the delegate process group;
9. reject native `metadata.workspace` or `metadata.fileChanges` collisions;
10. optionally capture bounded file changes;
11. preserve the complete delegate response and add workspace metadata plus optional file changes; and
12. return while retaining the row's workspace lease for Promptfoo transforms and assertions.

Failures before a complete, valid delegate response run the recorded teardown. The pending record exists before any seed lease, inode tree, or mount, so process death never leaves an unknown resource. Once a response containing `metadata.workspace.path` is returned, the provider retains that workspace until `cleanup()` or later stale recovery. No per-row timer may delete it because the provider cannot know when asynchronous assertions have finished.

If a valid delegate response contains a top-level `error`, the wrapper preserves the error and adds workspace metadata plus file changes when enabled. Promptfoo marks that row as an execution failure and does not run its assertions; the metadata is diagnostic, not a way to grade partial work. A malformed protocol, oversized response, premature runner exit, or other failure before a valid response runs teardown and returns a provider error. If detachment fails, the pending recovery record and seed lease remain for later recovery.


### Best-effort workspace cleanup and retained roots

`Provider.cleanup()` is the normal boundary for Promptfoo callers. It closes the provider, aborts and awaits active call process groups, and then runs one dependency-ordered teardown chain per workspace:

1. validate the recovery record;
2. detach each private writable source view (including a required overlay unmount), remove the row's references to protected read-only source checkouts, and remove the private workspace root;
3. only after detachment succeeds, release its seed and shared-checkout leases; and
4. mark the record released.

Cleanup is all-settled across independent workspace chains, not across dependent steps inside one chain. A failed detach keeps that record and lease for later recovery. The provider removes independent staging paths, retains any shared checkout still leased by another row, removes the root only when no unreleased record remains, and returns an aggregate error after attempting every chain.

Promptfoo does not guarantee `cleanup()` on every path. Current Node evaluations and some CLI exits can therefore leave a provider root behind. Returned paths are transient but may outlive their evaluation; persisted Promptfoo results must not treat them as durable artifact references. Retaining many mostly unchanged copy-on-write views is acceptable because they share immutable seed blocks, though changed blocks and overlay mounts still require eventual recovery.

GitHub-hosted Actions runners start clean and are destroyed after the job, so abandoned workspaces cannot leak into another hosted job. A workflow that wants to reuse seeds across hosted jobs saves **only published immutable seed content and its verification metadata**. It never saves leases, prepared checkouts, staging, trash, locks, or runtime roots. On a fresh runner, the provider checks restored seeds and the cache-wide size limit before using them, discards corrupt or incomplete entries, evicts unleased excess entries, and starts new local lease and checkout state. A live shared cache on a local or self-hosted runner is different: its lease records must stay with it, and stale roots must be detached before their leases are released. Never restore a hosted snapshot over a live shared cache.

Every runtime root has a versioned ownership marker and live process identity. A later provider construction reaps only roots whose marker is valid and whose owner is no longer alive. It never deletes an unmarked root, a live root, or a path outside the configured runtime parent. A same-process Node evaluation whose host skipped cleanup may retain its root until that process exits; this is an accepted limitation.

Hard termination can leave overlay mounts or directories. Each checkout adapter must expose idempotent teardown and stale-recovery operations. Recovery refuses an unknown mount, unexpected ownership, or a path that fails containment checks.

### Persistent immutable seed cache and private writable workspaces

The workspace module is deep: callers configure sources and their access, while cache identity, acquisition locking, lease tracking, eviction, adapter selection, capability probing, block sharing, mount/copy mechanics, and teardown stay behind its interface. Every call has a private writable workspace root; source destinations inside it may have different access.

Resolved source acquisition identities and destinations address a package-owned seed cache outside provider runtime roots. Per-source `permissions` is excluded from the seed digest, so provider configurations with read-only and writable access to the same inputs reuse one immutable seed. The default uses the platform cache directory; `ALLAGENTS_CACHE_ROOT` selects another contained package-owned root. Published immutable seeds live in a separate cache subtree from mutable leases, protected checkouts, locks, staging, and trash so a hosted workflow can snapshot only seeds. Providers and evaluations reuse a verified read-only seed for the same manifest digest. Cross-process per-digest locks prevent duplicate preparation, and failed preparation never publishes an entry.

The 50 GiB limit covers package-owned cache files, including published seeds, protected checkouts, incomplete staging, and trash not yet deleted. The provider takes a cache-wide admission lock **before** staging a seed or protected checkout and holds it until publication or cleanup finishes. Before starting Git or another external writer, it reserves and enforces a bound on that writer's full physical staging footprint. For writes controlled by the provider, it reserves space before each bounded increment. Measuring an unconstrained subprocess only after it exits cannot enforce the limit. If the next write cannot fit, the provider stops and removes its incomplete output; a failed removal remains charged and blocks further admission. It measures a completed candidate and publishes it atomically under the same lock. This serializes acquisition across digests, but prevents uncounted staging from exhausting the cache. Lock order is always admission followed by per-digest locks in sorted order; a lease-only operation uses its digest lock without taking admission.

The provider atomically publishes a pending workspace recovery record before it creates a seed lease, inode tree, or mount. The adapter persists enough teardown state before every irreversible creation step and marks the view active only when complete. Cleanup detaches the view before releasing its lease; a failed detach keeps both the record and lease.

An unused seed has no lease record. Automatic garbage collection runs during admission, later provider construction, and opportunistically from `Provider.cleanup()`. The provider removes unleased least-recently-used entries until the next bounded increment fits or returns a capacity error without publishing partial content. Independent age collection removes entries unused for 30 days. Opportunistic pruning failure is a bounded warning and does not replace the evaluation result. `allagents-promptfoo cache prune` applies the same policy deterministically; `cache prune --all` removes every unleased entry. Both explicit forms return nonzero on failure.

Lease creation, release, and eviction take the per-digest mutation lock under the canonical ordering when admission is also held. A dead process does not make a seed immediately evictable: later provider construction must recover and detach every dependent workspace before releasing its lease. The collector then revalidates package ownership, containment, and absence of every lease record before atomically renaming the entry into package-owned trash. It never evicts a leased seed, follows a cache symlink, or treats workspace cleanup as cache eviction.

Writable source views use three internal checkout adapters:

1. **Reflink/clone adapter** — uses verified filesystem copy-on-write cloning such as Linux `FICLONE` or macOS `clonefile`; each writable source view has private inodes while unchanged data blocks remain shared. It needs ordinary source-read and destination-write access, not mount privileges, but only works when the backing filesystem supports cloning these files; the target WTG runner returned `EOPNOTSUPP`.
2. **Overlay adapter** — also provides copy-on-write, using the source subtree in the immutable seed as a read-only lower layer with one private upper and work directory per writable source view; its merged mount occupies that source's destination inside the row's writable workspace. Its mount operation needs permission on the runner. Where unprivileged mounting is denied, a separately designed, narrowly privileged mount/unmount helper may create a view in the provider's mount namespace. The provider and delegate then access it as ordinary users; no unrestricted or implicit `sudo` invocation is part of the provider interface.
3. **Recursive-copy adapter** — a full independent copy of the writable source, **not** copy-on-write; portable when ordinary file reads and writes are permitted, but it may allocate the full source size per row. Admit each view only after a conservative full-copy estimate, headroom, currently retained views, concurrent admissions, and available disk are accounted for. Otherwise fail explicitly before that copy rather than exhaust the runner.

Selection tries reflink, then usable OverlayFS, then bounded recursive copy. Every adapter must pass a throwaway write-isolation probe; a privileged mount hidden in a private namespace does not count as usable. Failed probes clean their state and fall through. Unknown mount state or failed detach blocks teardown and seed eviction rather than continuing to copy. Package metadata and documentation report supported environments.

Writable symlinks, bind mounts of a writable seed, and writable hardlinks are prohibited. Package-created links to protected read-only source checkouts may occupy private workspace destinations; links inside source content remain ordinary source entries and are validated for containment. A row can replace its own link without changing another row's workspace or the shared checkout.

Copy-on-write allocation is approximately one seed plus each writable row's changed blocks and any protected read-only prepared checkouts, rather than one full repository per row. This is not a universal guarantee: reflink metadata, overlay upper layers, agent-generated dependencies, and recursive-copy fallback can still consume substantial disk. Concurrency and free-space behavior require a thousand-view scale test with a multi-gigabyte seed.

On WTG.AI.Prompts' [`wtg-use-linux-x64` runner](https://github.com/WiseTechGlobal/WTG.AI.Prompts/actions/runs/36551124238), reflinks and unprivileged OverlayFS mounts failed, but two CargoWise-sized OverlayFS views mounted under `sudo` in a private namespace shared unchanged data and isolated writes. A [separate direct-mount probe](https://github.com/WiseTechGlobal/WTG.AI.Prompts/actions/runs/36553859211) showed that an ordinary Node child could see and modify a `sudo`-mounted view in the job's namespace while the seed remained unchanged. These prove filesystem and process visibility, not a production privilege helper, crash recovery, actual provider integration, or thousand-view scale. CargoWise-scale writable rollout still requires a working adapter and those gates; recursive copy is not an acceptable silent replacement at that scale.

### Explicit read-only sources in writable workspaces

Every `callApi()` gets a separate writable workspace. Each source in that workspace can set `permissions: read-only` or `permissions: all`; an omitted value means `all` and gives the row a private writable source view. There is no `workspace.permissions` setting. Source permissions are fixed in the provider configuration, so prompt variables and test-level overrides cannot change them. In stock Promptfoo, authors can label provider configurations with different source permissions and select them using [`defaultTest.providers` and `tests[].providers`](https://www.promptfoo.dev/docs/configuration/test-cases/#filtering-tests-by-provider). Without a provider filter, a test runs against both configurations.

When matching rows use a read-only source and no setup changes that source, they may share one protected checkout. It is separate from the immutable seed. The provider places a link to that checkout at the source's destination inside each row's own writable workspace. Everything outside that destination remains private to the row. If setup must change the source, prepare those changes as part of the immutable input or use `permissions: all` for that source.

File modes block ordinary changes to files inside the shared checkout, but they are not a security boundary against an agent running as the same OS user. That agent can change the modes or remove its own destination link. Removing the link leaves the row's destination absent: it does not create a copy or change the shared checkout. If the row creates a replacement at that path, the replacement belongs to that row. The provider never exposes the immutable seed to the agent. If the shared checkout changes unexpectedly, the provider stops using it rather than resetting it in place; resetting it could let concurrent rows see each other's changes.

The provider keeps each row's source lease until Promptfoo cleanup or safe recovery after the owning process exits, so assertions can inspect the source after the delegate returns. The shared checkout belongs to the cache, and its allocated bytes count toward the cache ceiling. Pruning cannot remove it while any row still has a lease, or release a seed lease while the checkout depends on the seed's blocks. `metadata.workspace.path` is unique to each row and writable; only protected source content is shared. Package-owned control paths are excluded from source file-change evidence. Delegate-native sandbox settings apply to the whole working directory, not individual sources; read-only source rows still need a writable workspace setting if they write outside the source.

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

Assertions can inspect the returned `metadata.workspace.path` and the source destinations declared in provider configuration. A writable source stays under the workspace root. A read-only source is linked to a protected checkout in the cache, so its resolved path may be outside that root. Assertions should inspect only the expected destination and expected files, not arbitrary paths supplied by the agent. If the row removes or replaces its link, an assertion inspecting that source sees the missing or replaced destination in that row; the shared checkout and other rows are unchanged.

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
      permissions: read-only

    - type: oci
      repository: registry.example.com/eval-assets/skills
      digest: sha256:0123456789abcdef...
      destination: .agents/skills
```

Every source request has a contained, non-overlapping destination and an independent access mode; omitted `permissions` means `all`. Git refs and OCI tags are requests; response metadata records resolved commits and manifest digests.

Source permissions are orthogonal to Git/OCI acquisition: a release-backed commit still materializes the immutable seed, and `read-only` controls whether that particular source may use a shared protected checkout. `all` means a private writable source view; neither value is a delegate security policy.

The consuming eval project owns its own workspace-YAML interpretation and `repo + commit` resolution to a GitHub release chunk or OCI image. The generic provider accepts only the resolved Git/OCI source descriptors and materializes its own immutable seed; it does not embed WTG-specific release manifests, AgentV hooks, or a second release resolver. A YAML template containing only a Git URL and commit still needs Git acquisition unless the consumer supplies a resolved local release-backed repository or image digest. Links to shared read-only source checkouts do not satisfy private writable source views.

The initial Git adapter accepts `https://` and `file://` repositories and rejects SSH URLs. HTTPS acquisition reads fixed `ALLAGENTS_GIT_USERNAME` and `ALLAGENTS_GIT_TOKEN` channels and scopes them only to Git. OCI acquisition reads `ALLAGENTS_ORAS_PATH` and `ALLAGENTS_ORAS_AUTH_FILE`, copies registry configuration to private temporary state for one acquisition, and deletes it in `finally`. `ALLAGENTS_WORKSPACE_ROOT` optionally selects the owned runtime parent; `ALLAGENTS_CACHE_ROOT` optionally selects the separate package-owned seed-cache root. All six names are reserved from delegates.

Secret values, helper paths, and auth-file contents are redacted from arguments, bounded stderr, errors, metadata, and traces. Neither delegates nor assertions receive acquisition credentials through the provider.

Seed publication is atomic. OCI acquisition uses a runtime-supplied ORAS 1.x executable without a shell. The provider resolves a tag once, fetches a size-bounded manifest by digest, verifies it, and checks every file descriptor's title, type, digest, and declared size against the configured aggregate limits before downloading blobs. It rejects archives, compressed or special-file layouts, escaping paths, and duplicate titles. It then streams each blob by digest through a byte-counting writer, stops an oversized stream, and checks actual size and digest before publishing a regular file. An unbounded `oras pull` cannot meet this contract because descriptor preflight does not constrain bytes sent by a malformed registry.

The manifest digest is SHA-256 over UTF-8 RFC 8785 canonical JSON containing the schema version, materializer versions, and resolved acquisition identities with normalized destinations sorted by destination. Per-source `permissions` is not part of this digest: read-only and writable provider configurations over the same inputs use the same immutable seed.

### Copilot SDK provider

The lower-level `CopilotSdkProvider` owns Copilot SDK process/protocol handling, a minimal child environment, model and permission options, cancellation, timeout, process-tree termination, Promptfoo-compatible metadata and spans, usage, and redaction.

It accepts an existing `working_dir`; it does not resolve sources, retain workspaces, or capture files. The workspace-owning `Provider` composes the same Copilot session runtime with its workspace lifetime.

For bring-your-own-key use, `provider` is a closed object containing a required `baseUrl` and optional API key and supported SDK endpoint options. It is not a provider-name string. The provider rejects embedded URL credentials and redacts the API key from errors, traces, and results.

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
- Recursive-copy fallback can allocate each writable source's full size for every row; it requires workload-aware disk admission and an explicit failure when a large copy workload cannot fit.
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

Rejected for writable source content. Writes through a symlink mutate the shared target; writable sources require private copy-on-write views or independent copies. Explicit read-only sources may instead be linked into private writable workspaces from a protected prepared checkout, never directly from the immutable seed.

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
