# Provider guide

The [README](../README.md) covers installation and a first eval, and the
[grading guide](grading-guide.md) covers `llmAssert` and `agentAssert`. The
[agent-facing usage skill](../skills/oh-my-promptfoo/SKILL.md) gives concrete
eval configs. This guide records configuration, response, and resource
behavior. The [examples](../examples) include Codex, Claude, Copilot, Git/OCI,
source permissions, and cache use.

Both providers use stock Promptfoo. Their YAML IDs are `package:oh-my-promptfoo/providers:Agent` (the workspace agent) and `package:oh-my-promptfoo/providers:CopilotSdk`. Every provider comes from the `oh-my-promptfoo/providers` entry; the package root exports nothing.

The package also ships a judge provider, `package:oh-my-promptfoo/providers:Fallback`, which tries `llmAssert` and `llm-rubric` judges in order and fails over on rate limits and outages. Name `llmAssert`'s judge with `defaultTest.options.provider` for the suite, a test's `options.provider`, or `--grader` for the run; one assertion that needs its own judge can set `config.provider`. `llmAssert` does not read `OPENAI_*` variables itself. The [grading guide](grading-guide.md#choosing-llmasserts-judge) covers both.

## Provider response and assertions

Each workspace-provider call returns a distinct absolute `metadata.workspace.path`, an immutable manifest digest, resolved source commits/digests, and `cleanup: best-effort-evaluation`. Native output, raw response, usage, cost, and metadata (including `skillCalls`) keep their original locations. Codex's root Git check is bypassed internally because workspace roots may contain nested repositories. A native top-level `error` remains an execution error; Promptfoo skips assertions for that row.

For `type: local`, `metadata.workspace.sources[].digest` identifies the complete
staged directory, including scripts and untracked files. It hashes sorted
relative paths, modes, and file bytes. This is input provenance, not a record
of agent edits.

### Skill-use assertions

Stock Promptfoo's `skill-used` assertion reads `metadata.skillCalls` from the
provider response. It works with all four delegates without changing skill
files or assertion syntax. No OpenTelemetry collector, OTLP endpoint, or
`tracing.enabled: true` setting is required for this assertion.

| Delegate | Skill-use evidence |
| --- | --- |
| `anthropic:claude-agent-sdk` | Promptfoo derives calls from the native `Skill` tool's `input.skill`, with `source: "tool"`. Calls marked `is_error: true` do not satisfy `skill-used`. |
| `openai:codex-sdk` | Promptfoo derives calls from successful commands referencing recognized skill paths, with `source: "heuristic"`. Failed commands can appear in `attemptedSkillCalls` without satisfying `skill-used`. |
| `copilot-sdk` | The adapter records successful contained skill-file reads or verified SDK skill-loader records. See [Direct Copilot configuration](#direct-copilot-configuration). |
| `pi-sdk` | Successful guarded `read` tool calls to contained, non-symlink `SKILL.md` files produce `source: "read-tool"`. Discovery, failed reads and assistant claims do not count. |

Claude and Codex use the consumer's native Promptfoo providers; the wrapper
preserves their metadata and provenance rather than deriving skills again.
Assistant text claiming skill use is not evidence. Missing `skillCalls` is
treated by Promptfoo as no observed use, so a failing gate alone cannot
distinguish missing reporting from a genuine miss.

Delegate-specific provider configuration still differs. Use explicit labeled
provider entries to select a delegate, not one templated delegate ID sharing
incompatible config fields. Skill staging is unchanged.

### Certified tool inventory and absence assertions

All delegates return `metadata.toolInventory` with `schemaVersion: 1`,
`status: complete | incomplete`, `incompleteReasons: string[]`, `calls`,
`skillInventory: sdk | read-tool-only | failed`, and `loadedSkills: string[]`.
Each call records `{ id, name, mcpServer?, mcpTool?, arguments,
argumentsTruncated, startedAt, endedAt, success }`. Names preserve the runtime
display name; stable MCP server/tool identity is separate. Failed attempts count
as invocations. Missing completion/success and unknown native timestamps are
`null`, never fabricated success or execution times. Copilot timestamps use the
SDK event timestamp when present, otherwise the adapter's event receipt time.
An omitted argument field is unavailable evidence: the retained value is `null`
with `missing-tool-arguments`, and the inventory is incomplete. An explicitly
reported JSON `null` is distinct and remains valid evidence.

Copilot explicitly enables subagent streaming. It certifies `complete` only after
`sendAndWait` succeeds, no session/cleanup/abort/stream errors occurred, every
unique start has one matching completion with a boolean success, no evidence was
truncated/redacted, and the SDK invoked-skill RPC returned a valid bounded list.
A clean zero-call stream is complete. Orphan completions and duplicate IDs are
incomplete, not silently ignored. Fixed bounds are 100,000 received events,
16 MiB received event JSON, 1,024 retained calls, 8,192 UTF-8 bytes of JSON per
call's arguments, and 4 MiB for the entire inventory. The retained-call byte
budget reserves room for up to 1,024 SDK skill names of at most 512 characters,
with a 768 KiB serialized SDK-name budget.
Exceeding a bound is explicit and invalidates the certificate. Oversized arguments
become a bounded `{ preview }` record with `argumentsTruncated: true`; unsafe
JSON becomes `null` with the same flag. Known credential values and structural
HTTP(S) URL userinfo (including username-only, mixed-case schemes and all userinfo
through the final `@` in the authority) are redacted before argument retention.
Paths and queries outside the authority are preserved. Any redaction of arguments,
tool/MCP identities or SDK skill names makes the inventory incomplete: a replaced
value cannot silently become a successful negative match. Raw secrets are never
retained. All three assertions return a grader error for that evidence loss.

For pinned SDK 1.0.22, a non-autopilot root `session.idle` explicitly means no
background agents or attached shell commands remain in flight. The adapter must
observe that clean root idle; a resolved `sendAndWait` promise alone is not a
certificate. Child-only/autopilot idle cannot substitute for it. This certificate
covers one fresh single-turn call, with no further prompts or runtime work
configured after idle. Explicit `abort` and error `session.shutdown` events
permanently invalidate the inventory, even if a later idle lacks an aborted flag.

Each observed child is attributed to its own lifecycle using the SDK's lifecycle
`agentId` (the child instance) and `data.toolCallId` (the spawning tool invocation).
Starts and completions/failures establish and validate that association in both
directions. A contradictory terminal identity cannot close another child or
overwrite a sibling's association. This supports zero-tool children and child
tool events carrying only `agentId`. Older parent-only lifecycle events remain
supported; an event carrying both `agentId` and `parentToolCallId` can establish
the same association when the lifecycle omitted its optional `agentId`.
Unrelated siblings cannot borrow a lifecycle or another child's observed calls.
Optional reported tool totals are reconciled per child. Missing/contradictory
attribution, pending, failed, cancelled or malformed lifecycles prevent
certification.

The adapter remains subscribed until disconnect, but SDK disconnect clears its
handlers before client shutdown: observation after detach is not claimed.
Any tool, skill or subagent activity actually observed after the clean root idle
(including before the promise settles or during detach) invalidates completeness.
The clean global idle is the quiescent call boundary; successful shutdown alone
cannot replace missing idle or upgrade incomplete evidence.

`loadedSkills` contains all valid SDK-reported invoked skill names, deduplicated,
even when a legacy `skillCalls` record is rejected because its local body/path
cannot be verified. This list proves SDK-reported loading, not that the loaded
body matched a staged file. Malformed/unbounded names, a failing or timed-out
RPC, or an unsupported RPC cannot certify skill absence. The RPC has a one-second
budget within the call's execution deadline. `metadata.skillCalls` and stock
`skill-used` keep their existing stronger local-body verification behavior.
A malformed unrelated entry invalidates the new SDK snapshot but does not drop
separately valid verified `metadata.skillCalls` records: stock positive
`skill-used` remains usable even when absence assertions return grader errors.

Native Claude/Codex calls retain available tool spans (not model/root spans),
Claude `metadata.toolCalls`, and Codex raw tool items, including observed command,
MCP, search, plan-update and delegation calls. Summaries without timestamps retain
`null` timestamps; known trace times are preserved. A missing native summary ID
gets a stable per-response `native-summary:<source>:<ordinal>` observation ID and
an explicit incomplete reason, never a fabricated execution timestamp.
Native summaries/traces cannot
certify a full stream, so native inventories remain `incomplete` with
`delegate-does-not-expose-tool-stream`. Pi retains its observed start/end calls
but remains incomplete because only read-tool skill evidence is available.
Neither traces nor assistant prose prove universal absence.

The inventory is reserved at the native adapter boundary: delegate-supplied
`metadata.toolInventory` is rejected even if structurally valid. The adapter sends
its own inventory separately from the delegate response. The host validates and
attaches it with private process-local provenance; `Agent` accepts that generated
inventory while rejecting an untrusted reserved key. This is an adapter trust
boundary, not an OS sandbox against malicious same-user SDK code.

Use stock Promptfoo JavaScript package assertions, not custom assertion types:

```yaml
assert:
  - type: javascript
    value: package:oh-my-promptfoo/assertions:tool-called
    config:
      name: { regex: '^(read|read_file|view)$' }
      argumentsMatch: { path: /path, regex: 'README' }
      before: { name: { regex: '^(write|write_file|create)$' } }
  - type: javascript
    value: package:oh-my-promptfoo/assertions:tool-not-called
    config:
      name: bash
      argumentsMatch: { path: command, regex: 'git\s+pull' }
  - type: javascript
    value: package:oh-my-promptfoo/assertions:skill-not-loaded
    config: { name: forbidden-skill }
```

Tool selectors combine optional exact `name`, regex `name: { regex, flags? }`,
exact `mcpServer`, and `argumentsMatch: { path, regex }`. Programmatic callers
may also pass `RegExp` values. Argument paths are JSON Pointer (`/items/0/name`,
with `~0`/`~1` escaping), dotted own-property paths (`items.0.name`, optionally
`$.items.0.name`), or an empty path for the whole arguments value. Regexes match
strings directly and other JSON values as serialized JSON. Missing paths do not
match. An empty selector matches every invocation.

`before` is another tool selector, without nested `before`. It selects invocations
whose **start event precedes the first matching reference start event** in SDK
stream order. Equal timestamps are ordered by callback order; overlapping calls
count by invocation order, not completion order. The reference invocation itself
is excluded. A missing reference is a grader error, not vacuous absence.
`skill-not-loaded` accepts a required exact/regex `name` and requires SDK skill
completeness. All three assertions fail with `pass: false`, `score: 0`, and
`metadata.graderError: true` for missing, malformed or incomplete inventories.

The certificate covers tool invocations, not every side effect inside a tool.
For example, a `bash` call's `git pull` arguments can be matched; a network call
hidden inside a script is not separately visible. The
[executable example](../examples/tool-inventory/promptfooconfig.yaml) uses the
unmodified package loader. From an installed evaluation project, run
`npx promptfoo eval -c examples/tool-inventory/promptfooconfig.yaml --no-cache`.
For maintainers, after `corepack pnpm build`, `corepack pnpm pack:check` exercises
strict packed ESM/CJS exports and declarations; `corepack pnpm e2e` installs the
tarball alongside stock Promptfoo 0.124.1 and runs these exact package assertions
against deterministic SDK fixtures (including incomplete grader errors).

### Agent workspace grading

`package:oh-my-promptfoo/assertions:agentAssert` accepts the same `components`,
`threshold`, `scoring` and `rubricPrompt` fields as `llmAssert`,
plus required `grader: { id, config?, env? }` and optional `timeoutMs`,
`queueTimeoutMs` and `maxPromptBytes`. Its workspace verification rule is
always built in.
The grader IDs are the same four supported delegates as the workspace provider.
Use explicit `grader.env` for credentials. `--grader` and `options.provider`
choose `llmAssert`'s judge and never this grader. The assertion consumes
`context.providerResponse.metadata.workspace.path`; absent or released paths
are errors even when a candidate answer or durable file changes are available.

The grader inspects the live directory without acquiring a new workspace or
extending its lifetime. Do not call provider cleanup or mutate the directory
while assertions are running. Optional `metadata.fileChanges` contributes only
changed-file paths/change/kind/mode, deleted paths, the diff and completeness,
truncation and failure information, never captured base64 contents. Files, tool
output and candidate text cannot override grading instructions.

`maxPromptBytes` defaults to 131,072 UTF-8 bytes (128 KiB), with an allowed
integer range of 1–16,777,216. It measures the full assembled prompt, including
rules, criteria and evidence. An oversized prompt drops the diff with a notice
stating the omitted byte count; if still too large, the assertion fails before
starting a grader and reports the measured size and budget.

Claude, Copilot and Pi grader tools are restricted to filesystem reads within
the workspace and declared protected sources, with shell and network denied.
Codex graders run stock Promptfoo Codex: the shell stays inside the read-only
sandbox, which blocks writes and command network access but can read the whole
disk; commands get Promptfoo's minimal environment plus the grader's API key;
and the workspace's `AGENTS.md` and skills load as in stock Codex. See
[ADR 0013](adr/0013-codex-graders-use-a-sandboxed-shell.md). Conflicting
native settings are rejected. Model-service network traffic is not blocked.
These restrictions are not an OS sandbox against malicious same-user
processes. No chmod or snapshot changes the candidate workspace.

`timeoutMs` defaults to 120,000 ms and bounds execution across up to two attempts
(one retry for malformed verdicts), starting after acquiring a grader slot.
`queueTimeoutMs` separately bounds queue wait, defaulting to 900,000 ms. Both
accept integers from 1 to 3,600,000 and are independent of `workspaceTimeoutMs`.
Sessions serialize within a process, separately from provider workers.
Multiple evaluation processes have independent queues. Measured tokens and request
counts from all attempts flow through assertion `tokensUsed`; scalar costs require
complete, compatible [judge accounting](grading-guide.md#judge-accounting-v1). Promptfoo
0.122 aggregates assertion tokens but not `tokensUsed.cost`; consumers can inspect
the returned cost directly. A time bound is not a dollar budget. See
[ADR 0008](adr/0008-agent-assert-workspace-grading.md).

Codex grading requires `grader.config.apiKey` or explicit
`grader.env.OPENAI_API_KEY`; ChatGPT login auth is not supported for graders.
The temporary Codex home never copies `auth.json`, avoiding refresh-token races
with the user's normal sessions. This restriction does not change candidate
provider authentication.

## Workspace provider configuration

Provider config is closed: only `delegate`, `workspace`, `workspaceTimeoutMs`, `workingDir`, `fileChanges`, and `timeoutMs` are accepted. The delegates are exactly `openai:codex-sdk`, `anthropic:claude-agent-sdk`, `copilot-sdk`, and `pi-sdk`. Prompt-level config can change `delegate.config` fields only. The wrapper forces execution and rejects cached responses. Use explicit `delegate.env` for model credentials; reserved `ALLAGENTS_*` environment names are rejected, case-insensitively.

For Codex and Claude **candidates**, `delegate.config` passes through to the consumer's native Promptfoo provider for validation. Options such as Codex `cli_config`, `additional_directories`, `codex_path_override`, Claude plugins, settings and settings discovery are allowed. Authors and their configuration are trusted; this is not a sandbox against malicious configuration. The wrapper still validates its contained stdio `mcpServers` structure and Claude `tools` configuration.

Only native keys that conflict with provider-owned workspace, per-row sessions or CLI environment are denied, in both provider config and prompt overrides:

| Delegate | Workspace keys | Session keys | Environment keys |
| --- | --- | --- | --- |
| `openai:codex-sdk` | `working_dir`, `copy_working_dir`, `skip_git_repo_check` | `thread_id`, `persist_threads`, `thread_pool_size` | `inherit_process_env`, `cli_env` |
| `anthropic:claude-agent-sdk` | `working_dir` | `resume`, `fork_session`, `resume_session_at`, `continue`, `session_id`, `persist_session` | `env` |

Claude `extra_args` cannot bypass these ownership checks. Denied session flags are `resume`/`r`, `continue`/`c`, `fork-session`, `session-id`, `resume-session-at`, `resume-drops-turn`, `no-session-persistence`, `from-pr`, `teleport` and `cloud`; `worktree`/`w` is denied because it changes the workspace. Leading dashes, case and `=value` spelling do not bypass the check. `add-dir` remains allowed, just like `additional_directories`. All other extra flags pass through to Promptfoo.

Use provider-level `workingDir` to select a contained workspace directory and `delegate.env` for CLI environment values. Copilot and Pi keep their closed delegate-config lists because their adapters run our own runtime code. Read-only `agentAssert` graders also keep explicit closed native-config lists: candidate passthrough does not admit `cli_config`, additional directories, executable overrides, plugins or settings discovery into a grader. See [ADR 0014](adr/0014-pass-native-delegate-config-through.md).

Promptfoo forwards the judge selected by `--grader`, `defaultTest.options.provider`,
or a test's `options.provider` into `context.prompt.config.provider`. It also
forwards native `llm-rubric` templates from `defaultTest.options.rubricPrompt` or a
test's `options.rubricPrompt`. The workspace provider ignores these two grading-only
fields when validating generation overrides; neither configures the generation
delegate. The caller's context is left unchanged for grading, so a shared native
rubric can live once in `defaultTest.options` instead of on every assertion.
All other non-undefined prompt-config root keys except `delegate` remain rejected,
and `delegate.config.timeoutMs` remains constructor-only.

| Field | Required | Purpose |
| --- | --- | --- |
| `delegate.id` | Yes | Selects one of the four supported agents |
| `delegate.config` | Pi only | Passes native candidate options to Promptfoo for Codex/Claude, except provider-owned keys above; Copilot/Pi use closed lists, and Pi requires nonempty `provider` and `model` |
| `delegate.env` | No | Passes only the named environment values to the agent |
| `workspace` | Yes | A single workspace spec (unchanged), or `{ fromVar, variants }` to select an authored spec per test |
| `workspace.sources` | Yes, per spec | Lists Git, OCI, or host-local inputs; `[]` starts with an empty workspace |
| `workspace.limits` | No, per spec | Narrows source count and download/extraction byte budgets |
| `workspaceTimeoutMs` | No | Bounds workspace preparation; provider value overrides `ALLAGENTS_WORKSPACE_TIMEOUT_MS`, then the 120,000 ms package default |
| `workspace.viewMode` | No, per spec | `auto` (default) tries reflinks then disk-admitted physical copies; `copy-only` skips reflinks and uses disk-admitted physical copies for writable views and protected read-only checkouts |
| `workingDir` | No | Starts the agent in an existing directory relative to the prepared workspace root, such as `project`; defaults to the root. The path must be normalized and contained. A protected read-only source can be selected. |
| `fileChanges` | No | Captures bounded after-bytes and a diff; defaults to `false` |
| `timeoutMs` | No | Limits the agent call |

`workspaceTimeoutMs` accepts an integer from 1 to 3,600,000 ms. The separate
`timeoutMs` limits the agent call and defaults to 900,000 ms.

### Select a workspace per test

Existing `workspace: { sources, limits?, viewMode? }` configs keep the same
behavior. To use different inputs with one shared provider, replace that spec
with `workspace: { fromVar: workspaceName, variants: { ... } }`. Each variant is
a complete workspace spec with its own sources, source permissions, limits and
view mode.

For example, on Linux, create `fixtures/checkout` and `fixtures/catalog` next
to this config and put the files to inspect in each directory:

```yaml
prompts: ["{{task}}"]
providers:
  - id: package:oh-my-promptfoo/providers:Agent
    config:
      delegate:
        id: copilot-sdk
        env:
          GH_TOKEN: "{{env.GH_TOKEN}}"
      workingDir: project
      workspaceTimeoutMs: 120000
      timeoutMs: 900000
      workspace:
        fromVar: workspaceName
        variants:
          checkout:
            sources:
              - type: local
                path: ./fixtures/checkout
                destination: project
                permissions: all
          catalog:
            sources:
              - type: local
                path: ./fixtures/catalog
                destination: project
                permissions: read-only
tests:
  - vars:
      workspaceName: checkout
      task: Inspect the checkout code and explain how it handles an empty price.
  - vars:
      workspaceName: catalog
      task: Inspect the catalog code and explain how it handles an unknown item.
```

`context.vars` must have its own `workspaceName` property whose value is a
string exactly matching an own key in `variants`. Selection is case-sensitive:
there is no coercion, default or fallback. A missing, non-string or unknown
selection fails before source acquisition. All variant specs, including unused
ones, are validated before any source acquisition.

`fromVar` names one variable, not a dotted path: use letters, numbers and
underscores, starting with a letter or underscore. Variant names use 1–64
letters, numbers, underscores or hyphens, starting with a letter or number.

Variants are literal, authored configuration. Test vars select a name only;
they cannot supply specs, repository URLs, refs or host paths, and workspace
fields are not templates. Local paths and `file://` Git repositories in every
variant use the loader's `basePath`, just like a single workspace spec. Literal
repository URLs remain visible under `workspace.variants` so runners can inspect
every possible source when scoping acquisition credentials.

`delegate`, `workingDir`, `workspaceTimeoutMs`, `timeoutMs` and `fileChanges`
remain common provider settings, not variant fields. In this example, both
variants therefore stage a `project` directory. Existing prompt-level
`delegate.config` overrides are unchanged; they do not override workspace
selection.

Every call still gets a distinct private workspace, even when calls select
the same variant. Selected sources retain the existing provenance metadata,
source-permission rules, assertions and cleanup lifecycle. Workspaces remain
live through assertions; selecting a variant does not extend their lifetime.

## Workspace sources and permissions

| Source type | Required fields | Identity recorded in the response |
| --- | --- | --- |
| Git | `type: git`, `repository`, `ref`, `destination` | Resolved commit |
| OCI | `type: oci`, `repository`, `destination`, and one of `tag` or `digest` | Resolved manifest digest |
| Local | `type: local`, `path`, `destination` | SHA-256 of sorted relative paths, modes, and file bytes |

Relative paths in provider config resolve the way Promptfoo resolves its own `file://` references: against the eval config's directory, which Promptfoo's loader passes to every provider as `basePath`. A provider included through `providers: file://providers.yaml` uses the same directory, not the directory of the included file. This covers a local `path` such as `../plugins/x/skills` and a `file://` Git repository such as `file://../vendor/repo`. Absolute paths, `file:///absolute` and `file://localhost/absolute` URLs are used unchanged. Without a loader `basePath`, as when constructing a provider directly, the base is the process working directory. See [ADR 0010](adr/0010-resolve-provider-paths-against-the-eval-config.md).

Use `permissions: read-only` for a protected source checkout. The default, `permissions: all`, creates a private writable source view. See the [source-permissions example](../examples/source-permissions/promptfooconfig.yaml) for labeled providers that run tests against both policies.

Git sources accept credential-free HTTPS or `file://` repositories and a ref; responses record the resolved commit. A relative `file://` repository resolves against the eval config's directory. Promptfoo itself reads every `file://` value in an included provider file as a file while loading the config and fails on a directory, so write `file://` Git sources in an inline provider config. Submodules and escaping links are rejected. HTTPS uses noninteractive askpass and a physically bounded staging filesystem. A trusted runner can supply a private directory on an already-mounted, byte- and inode-bounded tmpfs via `ALLAGENTS_GIT_STAGING_ROOT`; the provider verifies the mount and physical capacity before starting Git, without sudo or unmounting it. Otherwise the [Linux helper](operations/linux-helper.md) provides bounded temporary mounts. With the helper, a local repository with a self-contained object store uses a size-capped shared clone and native checkout, repacks only the pinned commit's reachable objects into an independent Git store, then makes a capacity-checked copy into the immutable seed. Other local repositories use a bounded native clone or object streaming. No path changes the source repository.

OCI sources have `type: oci`, `repository`, exactly one of `tag` or `digest`, and a `destination`. Supported manifests contain uncompressed regular files with unique `org.opencontainers.image.title` paths and SHA-256 descriptors. Descriptor limits are checked before blobs; actual streamed bytes and digests are checked before publication. Archives, compressed layers, special files, and escaping paths fail explicitly.

Local sources read a host directory directly; they are not Git repositories. A relative `path` resolves against the eval config's directory, so a config in `evals/` can name `../plugins/x/skills`. The resolved path must stay inside a containment boundary. By default, the boundary is the root of the Git repository that contains the eval config directory: the nearest ancestor with a `.git` entry, which is a file in linked worktrees and submodules. If that directory is not inside a Git repository, the boundary is the directory itself. A trusted runner can set an absolute `ALLAGENTS_LOCAL_SOURCE_ROOT` via provider loader `options.env` or the provider process environment to replace that boundary, for example to narrow it on a shared runner. This channel is not authored workspace configuration or delegate environment. Paths containing `..` are normalized before containment checking, but symlink ancestors of the boundary or source, symlinked entries, special files, and escapes from the boundary are rejected. Promptfoo does not resolve symlinks in the config directory, so address a config through its physical path. Every regular file is included, even untracked or Git-ignored files; `.git` metadata at any level is excluded. Source hashing and the copy are bounded by workspace byte and preparation-time limits, and a changed file or directory during copying prevents seed publication. One provider instance pins a single immutable baseline across concurrent and subsequent cases; a fresh provider instance hashes the directory again and observes later host edits. Agents edit private writable views, never the host source; the local source's resolved digest in `metadata.workspace.sources` identifies the original directory contents, independent of agent edits and Git.
Direct local sources require Linux `/proc/self/fd` descriptor-anchored traversal; Git and OCI sources retain their existing platform support.

Destinations must be relative, normalized, nonempty paths, and they may not nest inside one another. A read-only source links a separate protected checkout into each private writable workspace. Matching rows can share protected source contents; scratch and generated files outside the source remain private. A row can unlink or replace its destination link without changing other rows. Modes are a cooperative guardrail; same-user processes can deliberately bypass modes. Unexpected protected-content mutation invalidates reuse. The immutable seed is never the delegate workspace.

Several `type: local` sources may repeat one destination exactly and merge into a single tree, which is how N plugins stage their skills into one `.agents/skills`. The merged tree still produces exactly one view, one seed subtree and one protected checkout, and the checkout key covers every contributing source, so a different set of sources never reuses another set's checkout. Three rules keep the result independent of acquisition order and are enforced rather than documented as a convention. Every source sharing a destination must declare the same `permissions`, because one tree cannot be both protected and writable. No two of them may contribute the same relative path; a collision fails and names both source paths rather than letting the last source win. A directory path may repeat only when the sources agree on its mode. Git and OCI sources keep exclusive destinations: a Git destination carries the `.git` that governs that subtree and that `git status` reads for file changes, a prepared checkout is stamped as a whole external tree, and an OCI artifact tree is published as a unit. Nested destinations such as `a` and `a/b` stay rejected; only exact repetition merges. See [ADR 0005](adr/0005-merge-shared-source-destinations.md).

Select source policy with per-test workspace variants above, or with labeled providers and `defaultTest.providers` / `tests[].providers`; without a provider filter, a test runs against every configured provider. There is no workspace-wide permissions setting. Native sandbox settings apply to the whole workspace.

### Optional sibling agent workspace

By default, the agent starts at the private workspace root; keep native
`AGENTS.md`, `.agents/skills/`, and `.github/` inputs there when they are needed.
An optional `agent-workspace` local directory source can instead carry those
native paths with `workingDir: agent-workspace`. Repositories remain siblings,
addressed as `../CargoWise` and similar paths. Use a private writable view
(`permissions: all`) for that working directory; a `read-only` source is linked
to a protected cache checkout and does not have the outer workspace as its
physical parent. Sibling access still depends on the delegate's directory
permissions. [Case-scoped asset registration and access](https://github.com/allagentsdev/oh-my-promptfoo/issues/62)
is tracked separately; the default root cwd remains unchanged.

### Unprivileged workspace runners

Set `workspace.viewMode: copy-only` and `ALLAGENTS_NO_PRIVILEGED_HELPER=1` for runners without reflink support or sudo. Writable source views are independent full copies, admitted against available disk before writing; a protected read-only source gets one independent physical checkout per source identity, shared across matching rows. Neither mode mounts OverlayFS. In `auto`, verified unprivileged reflinks remain available for compatible seed and runtime filesystems before the admitted full-copy fallback. `ALLAGENTS_NO_PRIVILEGED_HELPER=1` forbids the bounded staging helper during acquisition and cleanup.

For HTTPS Git, the runner image must provide a private `0700` directory owned by the runner inside a pre-mounted tmpfs, named by `ALLAGENTS_GIT_STAGING_ROOT`. Only Linux can verify this mount: macOS and Windows refuse any staging root, so HTTPS acquisition fails closed there. It must be outside the seed cache: cache staging is renamed into the published seed on the same disk filesystem. The package checks the containing mount, its total byte and inode capacities against the configured source download/extraction limits, free capacity, and path ownership before launching Git. Git and its descendants use only this tmpfs for their temporary HOME and TMPDIR; the package cleans its marked children but never mounts, unmounts, or runs sudo. The image must reserve enough memory and swap for the tmpfs. Provision and smoke-test the actual runner; neither an mtime check nor an ordinary file copy is copy-on-write.

A pre-mounted tmpfs has a fixed capacity while Git sources acquire serially.
The package checks that capacity against the original suite-wide physical
reservation, not a shrinking remainder after the first source. It still
enforces the remaining download/extraction limits on each materialized source
and the aggregate limits before publishing the immutable seed. The cache
admits space for both the bounded temporary stage and final controlled writes.

This opt-in path requires a trusted, single-job runner with no concurrent untrusted process under the runner UID and no untrusted process that can add mounts in its namespace during acquisition or cleanup. Mode `0700` excludes other users, not another process with the same UID: such a process could rename staging paths between verification and Git's writes, bypassing the physical bound. The package cannot establish this host-level isolation from a path check. Do not configure `ALLAGENTS_GIT_STAGING_ROOT` on a shared or adversarial same-UID host; leave HTTPS acquisition fail-closed without the privileged helper.

### Trusted prebuilt Git views

For a trusted single-job runner, `ALLAGENTS_PREBUILT_ROOT` can point to an existing absolute, owned private `0700` directory, outside the seed-cache and workspace roots. It is a provider runtime channel (via loader `options.env` or the runner's process environment), not authored workspace configuration or delegate environment. The provider never creates or deletes this root. It rejects symlink ancestors, unowned or group-writable prepared directories, and a missing or malformed ownership marker (`.allagents-owner.json` containing `{"schemaVersion":1,"package":"@allagents/promptfoo-integration","kind":"prebuilt-sources"}`). The old package name remains the on-disk owner identifier for compatibility with existing prepared workspaces.

The runner atomically publishes `manifest.json` only after preparing its sources: `{"schemaVersion":1,"sources":[{"repository":"https://…","commit":"<40 lowercase hex>","destination":"project"}]}`. Its records must exactly match the pinned, credential-free HTTPS, `read-only` Git sources authored in `workspace.sources`. With workspace variants, use the union across every variant instead; repeated identical identities need one record. Missing, duplicate and undeclared identities fail closed. Identity includes the repository URL spelling, commit in `ref`, and normalized destination, so different variants may use different repositories at the same destination. Each case links only its selected sources, including none for an empty variant.

For each record, compute `key = SHA256(UTF8(JSON.stringify([repository, commit, destination])))` in lowercase hexadecimal and prepare a physically independent checkout at `<root>/sources/<key>/protected`; its `.git` directory must be local, HEAD pinned and working tree clean. The runner also prepares a clean original at `<root>/sources/<key>/seed` and a Git object mirror at `<root>/sources/<key>/mirror`; these are runner-owned, not provider cache entries. Publish the root and manifest privately only after verifying the checkout and any asset hashes.

With this channel set, the provider links each matching prepared checkout directly into each private row; it neither fetches that source nor copies it through the seed cache. Writable HTTPS Git and OCI sources are refused rather than fetched; local Git sources still follow ordinary acquisition and private-copy rules, with separate cache identity. Before delegate execution it checks Git HEAD, cleanliness and a full metadata tree stamp (including no writable files or directories on POSIX); after execution it checks again against that row's baseline. A failed check rejects the row and invalidates reuse in that manager, even if the delegate returns successfully. The root remains external and untouched by workspace cleanup and abandoned-record recovery. Without the channel, the normal bounded acquisition and protected-checkout behavior is unchanged. Read-only modes are cooperative against the same UID, not an isolation boundary: restrict the runner to a trusted job and dispose of the external root after its lifetime.

Tree stamps fetch up to 64 sibling inode records concurrently, then hash them
in the same depth-first order as earlier releases. Existing protected checkout
stamps remain valid. This is still a full-tree metadata check, not a Git HEAD
comparison.

## File-change evidence

`fileChanges: true` captures generated/modified after-bytes as base64, SHA-256 hashes, executable modes, symlink target bytes, deleted paths, and a text diff. Symlinks are recorded as their target bytes and never followed. A changed regular file with more than one hard link is never read, because it may alias an inode outside the workspace; its path is omitted with truncation code `HARDLINK`. Renames are delete plus add. Capture uses an immutable baseline; agent commits, staging, replacement refs, and changed ignore rules cannot redefine it. Disabled capture does no baseline work and omits the key. Results are `complete`, `truncated` with explicit codes/omitted paths, or `failed` with no partial data. Fixed bounds: 90 seconds for the baseline and 90 seconds for the capture, each including every Git command it runs, 10,000 candidates, 2,000 files, 256 KiB/file, 4 MiB total bytes, 1 MiB diff, 1,000 omitted paths, and 8 MiB serialized metadata. Capture failure preserves a valid agent response.

A writable Git source is compared by content against its pinned commit with a private Git index and the seed's object database. Unchanged tracked files are neither retained nor counted, so the candidate bound applies only to tracked paths that differ from the commit and to untracked paths, and a large checkout with a bounded edit captures `complete`. Git listings are streamed rather than buffered. With Git 2.41 or later the comparison ignores `.gitattributes`, so line-ending-only edits are reported byte-exactly. A Git failure reports `Private Git baseline failed:` followed by the Git command, its cause (exit code, signal, timeout, or output limit) and Git's error text, with cache paths redacted.

`metadata.fileChanges.schemaVersion` is `2`. Its `changedFiles` map contains added and modified files keyed by relative path, with each entry's `change` identifying `"added"` or `"modified"`. Each entry retains `kind`, `mode`, `size`, `sha256`, `encoding: "base64"`, and `content`; `deletedFiles`, optional `diff`, status, truncation, failure, and all capture limits are unchanged. This is a breaking metadata-field rename with no alias or compatibility shim.

## Opt-in evaluation progress

Subscribe to Node's `diagnostics_channel` named `allagents.workspace.progress` in the evaluation process to observe workspace-provider case boundaries. Without a subscriber, no progress events are constructed or emitted. Events are plain objects with only `phase`, optional positive safe-integer `caseIndex` and `sourceIndex`, optional nonnegative safe-integer `sourceCount`, and optional `outcome: \"ok\" | \"error\"`. `caseIndex` identifies a call within the process; `sourceIndex` is a one-based ordinal in sorted destination order, never a repository name. Counters are not persisted between processes. No event includes source paths, URLs, refs, credentials, prompts, model output, errors or grader details.

With a subscriber, the workspace provider also returns
`response.metadata.allagentsCaseIndex`, the same ordinal as that call's
`case-start` and `case-finished` events. This includes provider responses
containing an execution `error`, so a Promptfoo `afterEach` hook can associate
the final scored row with its actual workspace call even when prompts or grades
complete out of order. Without a subscriber, response metadata is unchanged.

Phases: `case-start`, `seed-start`, `seed-cache-hit`, `source-start`, `git-fetch-start`, `git-fetch-finished`, `source-finished`, `seed-ready`, `protected-copy-start`, `protected-copy-finished`, `workspace-ready`, `agent-start`, `agent-finished`, `protected-git-check-start`, `protected-git-check-finished`, `protected-stamp-start`, `protected-stamp-finished`, `case-finished`. `git-fetch-*` covers the single pinned-commit HTTPS fetch, without cloning the unrelated default branch; `source-*` covers actual materialization, not ref resolution. A cached seed emits `seed-cache-hit` and `seed-ready` without source events. `protected-copy-*` appears only when a new protected checkout requires a physical copy; cache reuse and successful reflinks omit it. A failing phase may have no matching finish, but each started provider case ends with `case-finished` and `outcome: \"error\"`. A native agent error marks both `agent-finished` and `case-finished` as errors. Event objects carry no timings; subscribers can record elapsed time locally. This channel is separate from `allagents.workspace.preparation`; its `{ phase, elapsedMs }` timing schema remains unchanged, with remote acquisition now reporting `git-init` and `git-fetch` instead of `git-clone`.

Post-agent verification of each prepared read-only Git source emits
`protected-git-check-start` / `protected-git-check-finished` around pinned HEAD
and clean-worktree checks, followed by `protected-stamp-start` /
`protected-stamp-finished` around the full metadata stamp and baseline comparison.
These events do not appear during pre-agent preparation. Each includes
`caseIndex`, `sourceIndex` (one-based among prepared read-only Git sources), and
`sourceCount` (the number of those sources), all positive safe integers. A
finished phase carries `outcome: "ok" | "error"`; a failing Git check does not
start the stamp phase. The checks and mutation rejection are unchanged; the
event pairs allow subscribers to time each step without exposing source identity.
Distinct protected sources are checked concurrently, so their phase events
may interleave. Each source still checks pinned HEAD and Git cleanliness
before its full stamp, and the provider waits for every check to settle before
returning success or reporting a mutation.

The existing preparation timing channel also emits fixed `checkout-admission`,
`checkout-copy-and-protect`, `checkout-inventory`, `checkout-stage-stamp`,
`checkout-published-stamp`, `checkout-reuse-stamp`, and `checkout-verify-stamp`
phases with elapsed milliseconds. These identify full-tree work without
source identities; subscribing does not add copies or verification passes.

## Workspace lifetime

Workspaces remain live through synchronous/asynchronous assertions. `Agent.cleanup()` closes calls, stops active process groups, removes private views, then releases leases. Promptfoo 0.122 does not guarantee cleanup on every CLI/Node path. Paths are transient and may survive until later dead-owner recovery or runner disposal. There is no cleanup timer. Call `cleanup()` explicitly when using providers directly. Dead-owner recovery uses process start identity and never removes live or unmarked roots; an unknown mount or legacy OverlayFS recovery record fails closed and retains leases for manual cleanup.

Cancelled calls do not publish a workspace path, even when a delegate returns
an aborted response with partial accounting. Their unpublished workspace is
released before the call returns; Copilot accounting remains available on the
error response. A teardown failure retains its recovery record rather than
pretending cleanup succeeded.

## Seed cache and resource limits

The seed cache is persistent and separate from runtime roots. Seeds and protected checkouts share a 50 GiB allocated-size ceiling; unused entries expire after 30 days. Seed last-use checkpoints have one-hour granularity, while a fresh process verifies the restored tree before reuse. Admission and digest locks serialize publication and lease changes. Acquisition reserves the controlled materialization budget, bounded temporary Git staging for the pinned fetch, and up to 512 MiB for inventory metadata. The temporary mount counts toward the cache ceiling, while the host-disk free-space check reserves only writes to that disk. Atomic inventory replacements also reserve their temporary allocation before writing. Every lease blocks pruning, including dead-owner leases until dependent workspaces are recovered. Workspace cleanup retains reusable seeds.

Protected checkout last-use checkpoints also have one-hour granularity.
Admission reuses the post-eviction allocated size already measured under its
lock rather than walking the full cache again; the 50 GiB and disk checks
remain in force.

For hosted cache reuse, save only the published `published` subtree and verification metadata. Restore it into a fresh marked cache; never restore leases, protected checkouts, staging, locks, trash, or runtime roots. Local/self-hosted caches retain live mutable state and must recover abandoned roots before releasing leases. Hosted runner disposal is the final cleanup backstop.

## Lock waits and maintenance

Initialization and acquisition lock waits allow at least three minutes and extend to the effective `workspaceTimeoutMs` (provider config, then `ALLAGENTS_WORKSPACE_TIMEOUT_MS`) for slower sources. Acquisition waits also honor cancellation. CLI pruning and lease release use independent three-minute waits, so a canceled row can still detach its views and release its leases.

```sh
allagents-promptfoo cache prune
allagents-promptfoo cache prune --all
```

Both commands report removed/retained entries and allocated bytes and return nonzero on failure. They do not run evaluations or delete runtime roots or the external prebuilt root. Unmarked and symlinked configured roots are refused. `ALLAGENTS_CACHE_ROOT`, `ALLAGENTS_WORKSPACE_ROOT`, and `ALLAGENTS_PREBUILT_ROOT` must be distinct and non-overlapping. Acquisition channels are `ALLAGENTS_GIT_USERNAME`, `ALLAGENTS_GIT_TOKEN`, `ALLAGENTS_ORAS_PATH`, and `ALLAGENTS_ORAS_AUTH_FILE`; prepared sources use `ALLAGENTS_PREBUILT_ROOT`, and the optional `ALLAGENTS_LOCAL_SOURCE_ROOT` replaces the default boundary for local directory sources. `ALLAGENTS_WORKSPACE_TIMEOUT_MS` supplies a bounded preparation deadline. Provider loader `options.env` takes precedence over process environment. These channels never reach delegates.

## Pi configuration

Install the optional maintained SDK peer with
`npm install --save-dev @earendil-works/pi-coding-agent@1.3.0`.
Select Pi using the same labeled workspace-provider pattern:

```yaml
providers:
  - id: package:oh-my-promptfoo/providers:Agent
    label: pi
    config:
      delegate:
        id: pi-sdk
        config:
          provider: openai
          model: gpt-4o-mini
          permissions: { filesystem: read, shell: deny }
        env:
          OPENAI_API_KEY: '{{env.OPENAI_API_KEY}}'
      workspace:
        sources: []
```

Stage skills in `.agents/skills`, `.claude/skills`, or `.github/skills` with
the existing workspace sources; skill files and stock `skill-used` assertions
are unchanged. Pi also reads the workspace root `AGENTS.md`. Only successful
contained, non-symlink skill-body reads count as skill use, not discovery.

Pi requires `provider` and `model`. Optional `apiKey` supplies a credential
directly; otherwise pass the provider's credential explicitly in `delegate.env`.
Global login credentials are not imported. Optional `baseUrl` accepts an absolute
HTTP(S) endpoint without embedded credentials, including local compatible model
servers; it overrides the selected provider's endpoint, not its model catalog.
`provider` and `model` must identify a built-in chat model in the pinned SDK.
`thinkingLevel` accepts `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`.
Permissions default to `{ filesystem: read, shell: deny }`, exposing `read` and
`ls` for file inspection and directory discovery. Filesystem `write` and shell
`allow` are explicit opt-ins. These tool restrictions are not an OS sandbox.

Each call uses in-memory sessions, settings, credentials and model catalogs,
plus a private temporary agent directory removed after execution. Pi loads no global/project
extensions, hooks, settings, model files, or global auth, and discovers no
resources beyond the staged skill roots and workspace root `AGENTS.md`.
Prompts are submitted as raw text with prompt-template expansion disabled,
so eval text cannot dispatch slash commands. Output, cached and uncached token
usage, request count, cost and tool start/end traces remain available.
`metadata.pi` identifies SDK `1.3.0`, provider, model and skill support.

For `agentAssert`, choose `grader.id: pi-sdk` with the same model and credential
fields. The grader enables guarded `read` and `ls` tools, with no skill/context
discovery. Read preserves image attachments; both tools reject paths outside
the workspace and declared protected sources. Explicit filesystem `write` or
shell `allow` is rejected rather than silently weakened.

## Local MCP servers

Copilot and Claude candidates accept the same closed
`delegate.config.mcpServers.<name>` object. Server names use
`^[A-Za-z0-9_-]{1,64}$`; each entry has only:

| Field | Required | Meaning |
| --- | --- | --- |
| `path` | Yes | Normalized relative Node script path, resolved against the delegate working directory |
| `args` | No | Literal string arguments; no shell or interpolation |
| `env` | No | Literal string environment entries, default `{}`; no host/delegate inheritance or interpolation |
| `tools` | No | Exact, case-sensitive tool names; omitted or `["*"]` allows all, `[]` allows none |
| `timeoutMs` | No | Positive safe-integer limit for each tool request; timeout closes the server |

For Claude, configured names cannot overlap at a double-underscore boundary:
`a` and `a__b` cannot coexist, because a tool `b__read` on `a` has the same
flattened namespace prefix as `read` on `a__b`. An isolated name containing `__`
is valid. Copilot supplies structured server/tool identity and retains overlapping
names without this Claude-specific restriction.

Scripts must realpath to a regular file inside the workspace or one of its declared
protected read-only sources. An undeclared symlink target, directory, absolute path,
`..`, command, URL, HTTP/SSE transport, headers, or authored `cwd` is rejected.
Use a read-only source for mocks so ordinary candidate edits cannot change the
canned answers; this is a recommendation, not a requirement. `type: local`
acquisition requires Linux; a pinned `type: git` source supports all platforms.
Node code remains trusted suite code, not an OS/network sandbox, just like
JavaScript assertions.

See [`examples/mcp/promptfooconfig.yaml`](../examples/mcp/promptfooconfig.yaml).
Per-test `options.delegate.config.mcpServers` (forwarded by Promptfoo as
`context.prompt.config.delegate.config.mcpServers`) replaces the complete
server map; an empty map removes configured servers for that test. The same key is
available directly in `CopilotSdk` config, with containment against its existing
`working_dir`. Pi and read-only `agentAssert` graders reject it. Contained stdio translation is available only for Claude and Copilot; Codex's native options are validated by Promptfoo.

The package invokes only its bundled Node stdio launcher and the contained Node
script. The actual script receives only its authored env, including when the SDK
merges inherited environment or Node adds platform defaults. Injection variables
such as `NODE_OPTIONS`, `PATH` and `HOME`, NULs, and secret-shaped credential values
are rejected. Reserved environment names and the `ALLAGENTS_` prefix are checked
case-insensitively, including per-test overrides and delegate env. Allowed authored
keys and values keep their original case. Pass delegate credentials in
`delegate.env`, not the fixture's env.
Control data is held in an owner-private, bounded file, never serialized into
process arguments, and removed by the host even if the runner is force-killed.
Normal shutdown, cancellation, failure and timeout stop both launcher and server.
A separate Worker thread inside the Node server monitors a private launcher-owned
pipe and forcibly kills the server on EOF, even if its main thread is blocked.
A one-byte pipe handshake must succeed before suite code starts; abrupt launcher
termination does not depend on a main-thread disconnect callback or polling.

Copilot receives explicit stdio options, tools and timeout with
`enableConfigDiscovery: false`; permission requests approve only configured server
and tool pairs. Claude receives Promptfoo's `mcp.servers`,
`strict_mcp_config: true`, with configured MCP names added to its allowed-tools
policy without replacing existing native restrictions. Authored Claude
`setting_sources`, settings and plugins pass through unchanged.
Model-free consumer tests exercise native Read and permitted/denied Write/Edit
filesystem actions through stock Promptfoo and a synthetic SDK executor, including
custom/append allowed tools, disallowed tools, accept-edits, bypass and don't-ask
modes. They verify adapter policy composition, not the installed Claude CLI's
independent enforcement; no live model service is involved.
Promptfoo 0.124.1's Claude transform cannot carry a per-server allow-list or timeout:
the launcher therefore filters both `tools/list` and `tools/call` and enforces the
deadline for both delegates, even with bypass permissions. It accepts newline
JSON-RPC only, bounds each frame at 16 MiB and pending requests at 1,024, and
forwards no late success after timeout. Workspace `.mcp.json`, `.github/mcp.json`,
`.vscode/mcp.json` and `.copilot/mcp-config.json` cannot add servers through these
contained-tool adapters. Claude candidates can separately opt into native plugins
and settings discovery through `delegate.config`; those options are trusted.

Observed tool spans preserve display names, arguments and call IDs, and add stable
`gen_ai.tool.mcp.server` and `gen_ai.tool.mcp.tool` attributes. MCP reads are not
counted as skill-file reads.

Tool inventories reuse that configured server/tool identity for both native spans
and summary-only observations. Invalid SDK MCP identity fields make evidence
incomplete rather than disappearing during normalization. Copilot can certify
clean MCP invocations; Claude retains the observations but remains incomplete,
so the strict inventory assertions return grader errors for its responses.

For model-free packed verification, install the built tarball and Promptfoo in a
consumer directory, then run `node scripts/smoke-mcp.mjs /absolute/consumer` from
this repository. It exercises packed ESM/CJS providers, stock Promptfoo's Claude
translation, real Node stdio, literal env, denied tools and private-file cleanup.

## Direct Copilot configuration

Direct Copilot uses `package:oh-my-promptfoo/providers:CopilotSdk` with an existing `working_dir`. An absolute path is used as is; a relative path resolves against the eval config's directory, like other Promptfoo file references. Optional fields are `model`, `reasoning_effort`, `timeoutMs`, `permissions`, and explicit `env`. Its optional BYOK `provider` is an endpoint object with required `baseUrl` and supported SDK fields (`type`, `wireApi`, `apiKey`, `wireModel`, `azure.apiVersion`); strings and embedded URL credentials are rejected. Defaults deny writes, shell, and network. Copilot tool events produce tool spans; skill inference from assistant text is disabled.

Both direct and workspace-backed Copilot responses report `metadata.skillCalls`
and `metadata.copilot.skillSupport: true`. A successful local `read`,
`read_file`, or `view` of a contained `SKILL.md` records
`source: "read-tool"`. Verified shell reads use the same `read-tool` provenance:
it denotes a verified tool-mediated file read, while `sdk-skill-loader` denotes
the SDK's loader. The exact tool name and command remain in `toolInventory`.
This preserves the existing source values for consumer assertions that accept
verified read/loader records. Shell recognition admits this deliberately small
literal-command subset:

- `bash`: `cat [--] <path>`, optionally followed by `; ls <skill-directory>`.
- `powershell`: `Get-Content <path>`, with optional `-Path` or `-LiteralPath`
  and `-Raw`. Command and parameter names are case insensitive.

One unquoted or simply quoted path is supported. Relative paths resolve against
the delegate's working directory or an explicit contained `cwd` argument.
Both start and completion must see a contained, non-symlinked skill file with
the same complete body. The successful completion's model-facing `result.content`
must contain that entire body, including frontmatter (CRLF is normalized).
Reported nonzero exits, unfinished terminal results and reported cwd mismatches
are rejected. This output check also prevents a successful trailing `ls` from
masking a failed `cat`. Only names, paths and provenance enter `skillCalls`.

Shell reads with missing, truncated or redacted bodies do not count. Neither do
files over 1 MiB, empty files, `..` traversal, wildcards, expansions, pipelines,
redirections, shell wrappers, `cd`, or other compound commands. Persistent shell
cwd changes are not inferred. These rules apply to Copilot; Pi continues to
record its guarded `read` tool only.

Copilot's built-in Skill loader also records
`source: "sdk-skill-loader"`, but only when its invoked-skill RPC supplies a
contained, non-symlinked `SKILL.md` path and the loaded body matches the file
after YAML frontmatter removal. Copilot redacts secret-shaped text in that body,
including prose such as `Bearer authentication`, as `******`. A redacted body
still matches only when every visible character is unchanged and in order, each
mask hides one non-empty single-line span of at most 256 characters, there are at
most 64 masks, and at least 90% of the file body stays visible. Alignments that
exceed a fixed search budget are rejected. Only skill names,
paths, and provenance leave the runner; loaded content does not. Failed or
unfinished reads, bare Skill invocations, text mentions, mismatched content, MCP
reads, and paths outside the workspace do not count.

Copilot sessions enable skills only when a real `.agents/skills`,
`.claude/skills`, or `.github/skills` directory exists immediately under the
delegate's working directory. The package supplies those directories explicitly
while leaving general SDK configuration discovery disabled; a symlinked skill
root is not admitted. Merely discovering a skill does not count as using it:
a file read or SDK-confirmed body load must complete successfully. Sessions
without a local skills directory keep skill loading disabled.

| Field | Required | Purpose |
| --- | --- | --- |
| `working_dir` | Yes | Existing directory where Copilot runs; absolute, or relative to the eval config's directory |
| `env` | No | Explicit values, including `COPILOT_GITHUB_TOKEN`, passed to Copilot |
| `model`, `reasoning_effort` | No | Select the model and its supported reasoning effort |
| `permissions` | No | Allow filesystem writes, shell, or network requests when needed |
| `provider` | No | Configure a BYOK endpoint with `baseUrl` and supported SDK fields |
| `mcpServers` | No | Contained local Node MCP fixtures with the shape above |
| `timeoutMs` | No | Limit the call |

### Copilot runtime accounting v1

Direct and workspace-backed Copilot calls use a fresh session and capture its
optional experimental `session.rpc.usage.getMetrics` snapshot after execution
settles, before unsubscribing or disconnecting. Capture waits at most one second,
also bounded by the configured call timeout and the host's remaining deadline
(reserving 50 ms for returning the response). An unsupported RPC, missing field,
error or timeout does not turn a successful model response into a failure.
Actual telemetry availability depends on the installed SDK/CLI; no account or
billing API is queried, and no pricing table is used.

The response carries this versioned wire record at
`metadata.copilot.accounting`:

```ts
type CopilotAccounting = {
  version: 1;
  source: "session.rpc.usage.getMetrics";
  scope: "session";
  unit: "nano-AIU";
  status: "complete" | "partial" | "unavailable";
  totalNanoAiu?: number;
  reason?: "unsupported" | "timeout" | "capture_failed" | "missing_total"
    | "invalid_total" | "execution_incomplete" | "session_not_created";
  requestedModel?: string;
  currentModel?: string;
  totalPremiumRequestCost?: number;
  totalUserRequests?: number;
};
```

`totalNanoAiu` must be a nonnegative safe integer. Reported zero is retained;
absence, negative/fractional/unsafe values, strings, NaN and infinity are not
zero. `complete` means a valid final session total after successful execution;
`partial` retains a valid total when execution, cleanup, cancellation or host
workspace validation fails. `unavailable` has no valid monetary total and a
fixed reason code. Partial and unavailable responses omit generic `cost`.
Snapshot metadata and measured tokens survive errors when the runner can return
a valid result; a forcibly killed process cannot supply missing telemetry.
An execution failure remains a failure even when its error message is empty;
retained assistant text does not turn that failed call into a successful grade.

Only a complete snapshot supplies generic `response.cost`: **USD usage value**
`totalNanoAiu / 100_000_000_000`. One billion nano-AIU is one AI credit; one
[AI credit is USD0.01](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing).
This is not an invoice, net/additional spending, allowance allocation or a
historical estimate. The session total is never added to usage events, shutdown
events, per-model totals or parent/subagent breakdowns.

`requestedModel` comes only from the request; `currentModel` comes only from
reported metrics and is not a per-request model history. Both are bounded model
identifiers (at most 256 ASCII identifier characters). Raw metrics/model/agent
maps, prompts, output, auth and opaque errors are not copied into accounting.
The existing `metadata.copilot.sdkVersion` identifies the supported SDK contract,
not a detected CLI version.

The RPC's `totalPremiumRequestCost` is a finite, nonnegative user-initiated
**multiplier** total (fractional values allowed, bounded by MAX_SAFE_INTEGER);
`totalUserRequests` is its nonnegative safe-integer request count. Neither is USD.
Separately, `metadata.copilot.premiumRequestUsage` contains
`{ source: "assistant.usage", scope: "received-events", reportedCost?, numRequests }`.
Its `reportedCost` sums received per-call multipliers only when every received
value and the sum are valid; missing/invalid values or no received events omit
it. These event counters do not establish complete session billing and are
never exported as generic money.

[Copilot cost methodology](copilot-cost-methodology.md) defines the unit
conversions and how to combine this usage with token-price estimates and native
costs.


## Filesystem behavior

In `auto` mode, writable views try verified reflink, then disk-admitted full copy. In `copy-only` mode they directly use admitted full copies, without a reflink probe. Protected read-only checkouts use forced reflinks with full-copy fallback in `auto`, or physical copies in `copy-only`; they are admitted once per distinct source identity and mode and then shared by matching rows. A full writable source copy consumes disk per retained row; a protected read-only copy consumes peak disk in addition to the seed and any other sources. Insufficient capacity fails before copying. Plan capacity for seeds, protected copies, mutable views, Git objects, and temporary acquisition at peak concurrency; large-repository writable rollout depends on actual runner capacity or verified reflinks.

On Windows, protected source trees use scoped NTFS ACLs. Linux-only tmpfs acquisition is not available; HTTPS Git requires capacity-bounded staging and fails closed without it. Workspace cache locks and process identity require the system Windows PowerShell executable.

Existing Git object files remain read-only because Git creates new objects instead of editing them; their directories remain writable. The sparse benchmark measures 1,000 views of one 2 GiB file; it does not predict the metadata or physical copy cost of large source trees. Cache inventories are bounded to one million entries and 512 MiB of JSON. macOS cache locks require Python 3 from Xcode command line tools.

## For maintainers

Package maintainers use the tag-pinned [npm release procedure](releasing.md).
