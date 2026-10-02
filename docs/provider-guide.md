# Provider guide

The [README](../README.md) has quick starts for the workspace-owning `Provider` and the direct `CopilotSdkProvider`. This guide records their configuration, response, and resource behavior. The [examples](../examples) include Codex, Claude, Copilot, Git/OCI, source permissions, and cache use.

Both providers use stock Promptfoo. Their YAML IDs are `package:@allagents/promptfoo-x:Provider` and `package:@allagents/promptfoo-x:CopilotSdkProvider`.

## Provider response and assertions

Each workspace-provider call returns a distinct absolute `metadata.workspace.path`, an immutable manifest digest, resolved source commits/digests, and `cleanup: best-effort-evaluation`. Native output, raw response, usage, cost, and metadata (including `skillCalls`) keep their original locations. Codex's root Git check is bypassed internally because repositories are nested below the workspace root. A native top-level `error` remains an execution error; Promptfoo skips assertions for that row.

## Workspace provider configuration

Provider config is closed: only `delegate`, `workspace`, `fileChanges`, and `timeoutMs` are accepted. The delegates are exactly `openai:codex-sdk`, `anthropic:claude-agent-sdk`, and `copilot-sdk`. Prompt-level config can change allowed `delegate.config` fields only. Authored working directories, sessions, executable overrides, discovery, arbitrary native passthroughs, environment inheritance, acquisition variables, and cache controls are rejected. The wrapper forces execution and rejects cached responses. Use explicit `delegate.env` for model credentials.

| Field | Required | Purpose |
| --- | --- | --- |
| `delegate.id` | Yes | Selects one of the three supported agents |
| `delegate.config` | No | Sets options allowed by that agent's Promptfoo provider |
| `delegate.env` | No | Passes only the named environment values to the agent |
| `workspace.sources` | Yes | Lists Git or OCI inputs; `[]` starts with an empty workspace |
| `workspace.limits` | No | Narrows source count, download/extraction bytes, or acquisition timeout |
| `workspace.viewMode` | No | `auto` (default) tries reflinks then disk-admitted physical copies; `copy-only` skips reflinks and uses disk-admitted physical copies for writable views and protected read-only checkouts |
| `fileChanges` | No | Captures bounded after-bytes and a diff; defaults to `false` |
| `timeoutMs` | No | Limits the agent call |

## Workspace sources and permissions

| Source type | Required fields | Identity recorded in the response |
| --- | --- | --- |
| Git | `type: git`, `repository`, `ref`, `destination` | Resolved commit |
| OCI | `type: oci`, `repository`, `destination`, and one of `tag` or `digest` | Resolved manifest digest |

Use `permissions: read-only` for a protected source checkout. The default, `permissions: all`, creates a private writable source view. See the [source-permissions example](../examples/source-permissions/promptfooconfig.yaml) for labeled providers that run tests against both policies.

Git sources accept credential-free HTTPS or `file://` repositories and a ref; responses record the resolved commit. Submodules and escaping links are rejected. HTTPS uses noninteractive askpass and a physically bounded staging filesystem. A trusted runner can supply a private directory on an already-mounted, byte- and inode-bounded tmpfs via `ALLAGENTS_GIT_STAGING_ROOT`; the provider verifies the mount and physical capacity before starting Git, without sudo or unmounting it. Otherwise the [Linux helper](operations/linux-helper.md) provides bounded temporary mounts. With the helper, a local repository with a self-contained object store uses a size-capped shared clone and native checkout, repacks only the pinned commit's reachable objects into an independent Git store, then makes a capacity-checked copy into the immutable seed. Other local repositories use a bounded native clone or object streaming. No path changes the source repository.

OCI sources have `type: oci`, `repository`, exactly one of `tag` or `digest`, and a `destination`. Supported manifests contain uncompressed regular files with unique `org.opencontainers.image.title` paths and SHA-256 descriptors. Descriptor limits are checked before blobs; actual streamed bytes and digests are checked before publication. Archives, compressed layers, special files, and escaping paths fail explicitly.

Destinations must be relative, normalized, nonempty, nonoverlapping paths. A read-only source links a separate protected checkout into each private writable workspace. Matching rows can share protected source contents; scratch and generated files outside the source remain private. A row can unlink or replace its destination link without changing other rows. Modes are a cooperative guardrail; same-user processes can deliberately bypass modes. Unexpected protected-content mutation invalidates reuse. The immutable seed is never the delegate workspace.

Select source policy with labeled providers and `defaultTest.providers` / `tests[].providers`; without a filter, a test runs against every configured provider. There is no workspace-wide permissions setting. Native sandbox settings apply to the whole workspace.

### Unprivileged workspace runners

Set `workspace.viewMode: copy-only` and `ALLAGENTS_NO_PRIVILEGED_HELPER=1` for runners without reflink support or sudo. Writable source views are independent full copies, admitted against available disk before writing; a protected read-only source gets one independent physical checkout per source identity, shared across matching rows. Neither mode mounts OverlayFS. In `auto`, verified unprivileged reflinks remain available for compatible seed and runtime filesystems before the admitted full-copy fallback. `ALLAGENTS_NO_PRIVILEGED_HELPER=1` forbids the bounded staging helper during acquisition and cleanup.

For HTTPS Git, the runner image must provide a private `0700` directory owned by the runner inside a pre-mounted tmpfs, named by `ALLAGENTS_GIT_STAGING_ROOT`. It must be outside the seed cache: cache staging is renamed into the published seed on the same disk filesystem. The package checks the containing mount, its total byte and inode capacities against the configured source download/extraction limits, free capacity, and path ownership before launching Git. Git and its descendants use only this tmpfs for their temporary HOME and TMPDIR; the package cleans its marked children but never mounts, unmounts, or runs sudo. The image must reserve enough memory and swap for the tmpfs. Provision and smoke-test the actual runner; neither an mtime check nor an ordinary file copy is copy-on-write.

A pre-mounted tmpfs has a fixed capacity while Git sources acquire serially.
The package checks that capacity against the original suite-wide physical
reservation, not a shrinking remainder after the first source. It still
enforces the remaining download/extraction limits on each materialized source
and the aggregate limits before publishing the immutable seed. The cache
admits space for both the bounded temporary stage and final controlled writes.

This opt-in path requires a trusted, single-job runner with no concurrent untrusted process under the runner UID and no untrusted process that can add mounts in its namespace during acquisition or cleanup. Mode `0700` excludes other users, not another process with the same UID: such a process could rename staging paths between verification and Git's writes, bypassing the physical bound. The package cannot establish this host-level isolation from a path check. Do not configure `ALLAGENTS_GIT_STAGING_ROOT` on a shared or adversarial same-UID host; leave HTTPS acquisition fail-closed without the privileged helper.

### Trusted prebuilt Git views

For a trusted single-job runner, `ALLAGENTS_PREBUILT_ROOT` can point to an existing absolute, owned private `0700` directory, outside the seed-cache and workspace roots. It is a provider runtime channel (via loader `options.env` or the runner's process environment), not authored workspace configuration or delegate environment. The provider never creates or deletes this root. It rejects symlink ancestors, unowned or group-writable prepared directories, and a missing or malformed ownership marker (`.allagents-owner.json` containing `{"schemaVersion":1,"package":"@allagents/promptfoo-integration","kind":"prebuilt-sources"}`). The old package name remains the on-disk owner identifier for compatibility with existing prepared workspaces.

The runner atomically publishes `manifest.json` only after preparing its sources: `{"schemaVersion":1,"sources":[{"repository":"https://…","commit":"<40 lowercase hex>","destination":"project"}]}`. Each record must match **exactly** one pinned, credential-free HTTPS, `read-only` Git source from `workspace.sources` (including the repository URL spelling, commit in `ref`, and normalized destination). Order is immaterial; missing, duplicate and unexpected records fail closed. For each record, compute `key = SHA256(UTF8(JSON.stringify([repository, commit, destination])))` in lowercase hexadecimal and prepare a physically independent checkout at `<root>/sources/<key>/protected`; its `.git` directory must be local, HEAD pinned and working tree clean. The runner also prepares a clean original at `<root>/sources/<key>/seed` and a Git object mirror at `<root>/sources/<key>/mirror`; these are runner-owned, not provider cache entries. Publish the root and manifest privately only after verifying the checkout and any asset hashes.

With this channel set, the provider links each matching prepared checkout directly into each private row; it neither fetches that source nor copies it through the seed cache. Writable HTTPS Git and OCI sources are refused rather than fetched; local Git sources still follow ordinary acquisition and private-copy rules, with separate cache identity. Before delegate execution it checks Git HEAD, cleanliness and a full metadata tree stamp (including no writable files or directories on POSIX); after execution it checks again against that row's baseline. A failed check rejects the row and invalidates reuse in that manager, even if the delegate returns successfully. The root remains external and untouched by workspace cleanup and abandoned-record recovery. Without the channel, the normal bounded acquisition and protected-checkout behavior is unchanged. Read-only modes are cooperative against the same UID, not an isolation boundary: restrict the runner to a trusted job and dispose of the external root after its lifetime.

Tree stamps fetch up to 64 sibling inode records concurrently, then hash them
in the same depth-first order as earlier releases. Existing protected checkout
stamps remain valid. This is still a full-tree metadata check, not a Git HEAD
comparison.

## File-change evidence

`fileChanges: true` captures generated/modified after-bytes as base64, SHA-256 hashes, executable modes, symlink target bytes, deleted paths, and a text diff. Renames are delete plus add. Capture uses an immutable baseline; agent commits, staging, replacement refs, and changed ignore rules cannot redefine it. Disabled capture does no baseline work and omits the key. Results are `complete`, `truncated` with explicit codes/omitted paths, or `failed` with no partial data. Fixed bounds: 90 seconds, 10,000 candidates, 2,000 files, 256 KiB/file, 4 MiB total bytes, 1 MiB diff, 4 MiB subprocess output, 1,000 omitted paths, and 8 MiB serialized metadata. Capture failure preserves a valid agent response.

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

Workspaces remain live through synchronous/asynchronous assertions. `Provider.cleanup()` closes calls, stops active process groups, removes private views, then releases leases. Promptfoo 0.122 does not guarantee cleanup on every CLI/Node path. Paths are transient and may survive until later dead-owner recovery or runner disposal. There is no cleanup timer. Call `cleanup()` explicitly when using providers directly. Dead-owner recovery uses process start identity and never removes live or unmarked roots; an unknown mount or legacy OverlayFS recovery record fails closed and retains leases for manual cleanup.

## Seed cache and resource limits

The seed cache is persistent and separate from runtime roots. Seeds and protected checkouts share a 50 GiB allocated-size ceiling; unused entries expire after 30 days. Seed last-use checkpoints have one-hour granularity, while a fresh process verifies the restored tree before reuse. Admission and digest locks serialize publication and lease changes. Acquisition reserves the controlled materialization budget, bounded temporary Git staging for the pinned fetch, and up to 512 MiB for inventory metadata. The temporary mount counts toward the cache ceiling, while the host-disk free-space check reserves only writes to that disk. Atomic inventory replacements also reserve their temporary allocation before writing. Every lease blocks pruning, including dead-owner leases until dependent workspaces are recovered. Workspace cleanup retains reusable seeds.

Protected checkout last-use checkpoints also have one-hour granularity.
Admission reuses the post-eviction allocated size already measured under its
lock rather than walking the full cache again; the 50 GiB and disk checks
remain in force.

For hosted cache reuse, save only the published `published` subtree and verification metadata. Restore it into a fresh marked cache; never restore leases, protected checkouts, staging, locks, trash, or runtime roots. Local/self-hosted caches retain live mutable state and must recover abandoned roots before releasing leases. Hosted runner disposal is the final cleanup backstop.

## Lock waits and maintenance

Initialization and acquisition lock waits allow at least three minutes and extend to the configured `workspace.limits.timeoutMs` for slower sources. Acquisition waits also honor cancellation. CLI pruning and lease release use independent three-minute waits, so a canceled row can still detach its views and release its leases.

```sh
allagents-promptfoo cache prune
allagents-promptfoo cache prune --all
```

Both commands report removed/retained entries and allocated bytes and return nonzero on failure. They do not run evaluations or delete runtime roots or the external prebuilt root. Unmarked and symlinked configured roots are refused. `ALLAGENTS_CACHE_ROOT`, `ALLAGENTS_WORKSPACE_ROOT`, and `ALLAGENTS_PREBUILT_ROOT` must be distinct and non-overlapping. Acquisition channels are `ALLAGENTS_GIT_USERNAME`, `ALLAGENTS_GIT_TOKEN`, `ALLAGENTS_ORAS_PATH`, and `ALLAGENTS_ORAS_AUTH_FILE`; prepared sources use `ALLAGENTS_PREBUILT_ROOT`. Provider loader `options.env` takes precedence over process environment. None of these seven channels reaches delegates.

## Direct Copilot configuration

Direct Copilot uses `package:@allagents/promptfoo-x:CopilotSdkProvider` with an existing `working_dir`; use an absolute path in evaluation configs. Optional fields are `model`, `reasoning_effort`, `timeoutMs`, `permissions`, and explicit `env`. Its optional BYOK `provider` is an endpoint object with required `baseUrl` and supported SDK fields (`type`, `wireApi`, `apiKey`, `wireModel`, `azure.apiVersion`); strings and embedded URL credentials are rejected. Defaults deny writes, shell, and network. Copilot tool events produce tool spans; skill inference from assistant text is disabled.

Both direct and workspace-backed Copilot responses report `metadata.skillCalls` and `metadata.copilot.skillSupport: true`. Only successful local `read`, `read_file`, or `view` tool events targeting an existing `.agents/skills/<name>/SKILL.md`, `.claude/skills/<name>/SKILL.md`, or `.github/skills/<name>/SKILL.md` inside the working directory produce `{ name, path, source: "read-tool" }`. Failed or unfinished reads, assistant text, other tool names, MCP tools, symlinked skill paths, and paths escaping the workspace do not count; other skill invocation mechanisms are not observed.

| Field | Required | Purpose |
| --- | --- | --- |
| `working_dir` | Yes | Existing directory where Copilot runs; use an absolute path |
| `env` | No | Explicit values, including `COPILOT_GITHUB_TOKEN`, passed to Copilot |
| `model`, `reasoning_effort` | No | Select the model and its supported reasoning effort |
| `permissions` | No | Allow filesystem writes, shell, or network requests when needed |
| `provider` | No | Configure a BYOK endpoint with `baseUrl` and supported SDK fields |
| `timeoutMs` | No | Limit the call |

## Filesystem behavior

In `auto` mode, writable views try verified reflink, then disk-admitted full copy. In `copy-only` mode they directly use admitted full copies, without a reflink probe. Protected read-only checkouts use forced reflinks with full-copy fallback in `auto`, or physical copies in `copy-only`; they are admitted once per distinct source identity and mode and then shared by matching rows. A full writable source copy consumes disk per retained row; a protected read-only copy consumes peak disk in addition to the seed and any other sources. Insufficient capacity fails before copying. Plan capacity for seeds, protected copies, mutable views, Git objects, and temporary acquisition at peak concurrency; large-repository writable rollout depends on actual runner capacity or verified reflinks.

On Windows, protected source trees use scoped NTFS ACLs. Linux-only tmpfs acquisition is not available; HTTPS Git requires capacity-bounded staging and fails closed without it. Workspace cache locks and process identity require the system Windows PowerShell executable.

Existing Git object files remain read-only because Git creates new objects instead of editing them; their directories remain writable. The sparse benchmark measures 1,000 views of one 2 GiB file; it does not predict the metadata or physical copy cost of large source trees. Cache inventories are bounded to one million entries and 512 MiB of JSON. macOS cache locks require Python 3 from Xcode command line tools. Copilot's experimental usage `cost` is forwarded in SDK units and should not be interpreted as a USD price.

## For maintainers

Package maintainers use the tag-pinned [npm release procedure](releasing.md).
