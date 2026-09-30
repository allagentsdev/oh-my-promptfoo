# @allagents/promptfoo-integration

Coding-agent providers for stock Promptfoo. `Provider` assembles a private writable workspace from pinned Git/OCI inputs and delegates to Promptfoo's Codex or Claude SDK provider, or the Copilot SDK. `CopilotSdkProvider` runs Copilot in an existing directory. Promptfoo assertions perform all grading.

Requires Node 22.22+, Linux/macOS, and Promptfoo 0.122.x. Copilot additionally requires `@github/copilot-sdk@1.0.6`. Development uses Bun 1.4.0. OCI requires an ORAS 1.x executable supplied through `ALLAGENTS_ORAS_PATH`.

```sh
npm install @allagents/promptfoo-integration promptfoo@0.122.0
# For Copilot:
npm install @github/copilot-sdk@1.0.6
promptfoo eval --config promptfooconfig.yaml
```

```yaml
prompts: ["{{task}}"]
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
tests:
  - vars:
      task: Write result.txt in your working directory.
    assert:
      - type: javascript
        value: |
          return import('node:fs').then(fs => {
            const root = context.providerResponse.metadata.workspace.path;
            return fs.readFileSync(root + '/result.txt', 'utf8').length > 0;
          });
```

Each call returns a distinct absolute `metadata.workspace.path`, an immutable manifest digest, resolved source commits/digests, and `cleanup: best-effort-evaluation`. Native output, raw response, usage, cost, and metadata (including `skillCalls`) keep their original locations. Codex's root Git check is bypassed internally because repositories are nested below the workspace root. A native top-level `error` remains an execution error; Promptfoo skips assertions for that row.

Provider config is closed: only `delegate`, `workspace`, `fileChanges`, and `timeoutMs` are accepted. The delegates are exactly `openai:codex-sdk`, `anthropic:claude-agent-sdk`, and `copilot-sdk`. Prompt-level config can change allowed `delegate.config` fields only. Authored working directories, sessions, executable overrides, discovery, arbitrary native passthroughs, environment inheritance, acquisition variables, and cache controls are rejected. The wrapper forces execution and rejects cached responses. Use explicit `delegate.env` for model credentials.

Git sources accept credential-free HTTPS or `file://` repositories and a ref; responses record the resolved commit. Submodules and escaping links are rejected. HTTPS uses noninteractive askpass and a physically bounded staging filesystem; the Linux helper documented below is required when an unprivileged bounded mount is unavailable. With that helper, local repositories use a size-capped native Git clone and checkout before a capacity-checked copy into the immutable seed. Without the helper, local repositories use bounded object streaming. Neither path changes the source repository.

OCI sources have `type: oci`, `repository`, exactly one of `tag` or `digest`, and a `destination`. Supported manifests contain uncompressed regular files with unique `org.opencontainers.image.title` paths and SHA-256 descriptors. Descriptor limits are checked before blobs; actual streamed bytes and digests are checked before publication. Archives, compressed layers, special files, and escaping paths fail explicitly.

Destinations must be relative, normalized, nonempty, nonoverlapping paths. Sources default to `permissions: all`, which creates private writable views. `permissions: read-only` links a separate protected checkout into each private writable workspace. Matching rows can share protected source contents; scratch and generated files outside the source remain private. A row can unlink or replace its destination link without changing other rows. Modes are a cooperative guardrail; same-user processes can deliberately bypass modes. Unexpected protected-content mutation invalidates reuse. The immutable seed is never the delegate workspace.

Select source policy with labeled providers and `defaultTest.providers` / `tests[].providers`; without a filter, a test runs against every configured provider. There is no workspace-wide permissions setting. Native sandbox settings apply to the whole workspace.

`fileChanges: true` captures generated/modified after-bytes as base64, SHA-256 hashes, executable modes, symlink target bytes, deleted paths, and a text diff. Renames are delete plus add. Capture uses an immutable baseline; agent commits, staging, replacement refs, and changed ignore rules cannot redefine it. Disabled capture does no baseline work and omits the key. Results are `complete`, `truncated` with explicit codes/omitted paths, or `failed` with no partial data. Fixed bounds: 90 seconds, 10,000 candidates, 2,000 files, 256 KiB/file, 4 MiB total bytes, 1 MiB diff, 4 MiB subprocess output, 1,000 omitted paths, and 8 MiB serialized metadata. Capture failure preserves a valid agent response.

Workspaces remain live through synchronous/asynchronous assertions. `Provider.cleanup()` closes calls, stops active process groups, detaches views, then releases leases. Promptfoo 0.122 does not guarantee cleanup on every CLI/Node path. Paths are transient and may survive until later dead-owner recovery or runner disposal. There is no cleanup timer. Call `cleanup()` explicitly when using providers directly. Dead-owner recovery uses process start identity and never removes live or unmarked roots; failed detach retains leases.

The seed cache is persistent and separate from runtime roots. Seeds and protected checkouts share a 50 GiB allocated-size ceiling; unused entries expire after 30 days. Seed last-use checkpoints have one-hour granularity, while a fresh process verifies the restored tree before reuse. Admission and digest locks serialize publication and lease changes. Acquisition reserves the controlled materialization budget, a bounded temporary clone budget for Git, and up to 512 MiB for inventory metadata. The temporary mount counts toward the cache ceiling, while the host-disk free-space check reserves only writes to that disk. Atomic inventory replacements also reserve their temporary allocation before writing. Every lease blocks pruning, including dead-owner leases until dependent workspaces are recovered. Workspace cleanup retains reusable seeds.

Initialization and acquisition lock waits allow at least three minutes and extend to the configured `workspace.limits.timeoutMs` for slower sources. Acquisition waits also honor cancellation. CLI pruning and lease release use independent three-minute waits, so a canceled row can still detach its views and release its leases.

```sh
allagents-promptfoo cache prune
allagents-promptfoo cache prune --all
```

Both commands report removed/retained entries and allocated bytes and return nonzero on failure. They do not run evaluations or delete runtime roots. Unmarked and symlinked configured roots are refused. `ALLAGENTS_CACHE_ROOT` and `ALLAGENTS_WORKSPACE_ROOT` must be separate. Acquisition channels are `ALLAGENTS_GIT_USERNAME`, `ALLAGENTS_GIT_TOKEN`, `ALLAGENTS_ORAS_PATH`, and `ALLAGENTS_ORAS_AUTH_FILE`. Provider loader `options.env` takes precedence over process environment. None of these six channels reaches delegates.

Package maintainers use the tag-pinned [npm release procedure](docs/releasing.md).

Writable views try verified reflink, provider-visible OverlayFS, then disk-admitted full copy. Copy allocates a full source per retained row; insufficient capacity fails before copying. Large-repository writable rollout requires verified copy-on-write on the target runner. A successful small copy fallback does not clear that gate. Linux administrators can install the narrowly scoped helper using the repository's `scripts/workspace-helper.py` and its installation documentation. The provider invokes only that fixed root-owned helper, never arbitrary sudo commands.

For hosted cache reuse, save only the published `published` subtree and verification metadata. Restore it into a fresh marked cache; never restore leases, protected checkouts, staging, locks, trash, or runtime roots. Local/self-hosted caches retain live mutable state and must recover abandoned roots before releasing leases. Hosted runner disposal is the final cleanup backstop.

Direct Copilot uses `package:@allagents/promptfoo-integration:CopilotSdkProvider` with an existing absolute `working_dir`, optional `model`, `reasoning_effort`, `timeoutMs`, `permissions`, and explicit `env`. Its optional BYOK `provider` is an endpoint object with required `baseUrl` and supported SDK fields (`type`, `wireApi`, `apiKey`, `wireModel`, `azure.apiVersion`); strings and embedded URL credentials are rejected. Defaults deny writes, shell, and network. Copilot tool events produce tool spans; skill inference from assistant text is disabled.

The Linux OverlayFS adapter uses metadata copy-up to restore writable file modes while seed contents stay protected. Existing Git object files remain read-only because Git creates new objects instead of editing them; their directories remain writable. Preparing a view still creates upper-layer metadata for working files and mutable Git state, so cost scales with entry count even before file writes. Writes can copy an entire modified file into the upper layer. The sparse benchmark measures 1,000 views of one 2 GiB file; it does not predict the metadata cost of 1,000 large source trees. Cache inventories are bounded to one million entries and 512 MiB of JSON. macOS cache locks require Python 3 from Xcode command line tools. Copilot's experimental usage `cost` is forwarded in SDK units and should not be interpreted as a USD price.
