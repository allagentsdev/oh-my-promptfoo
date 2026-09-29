# Implementation evidence

The contract is ADR 0001 and the phased plan merged from PR #1. All production modules are implemented; release publication is explicitly held until npm access is available. SDK fixtures used by the deterministic checks are consumer packages in temporary projects, never production provider hooks.

| Contract phase | Implementation and verification |
| --- | --- |
| 0: package | Dual ESM/CommonJS runtime and declarations, bundled private core, one CLI, optional Copilot peer, Changesets and trusted-publishing workflow. Packed npm, pnpm and Bun consumers pass. |
| 1: containment | Closed schemas, canonical source digest, normalized contained destinations, fixed acquisition channels and protected constructor policy. Configuration and override tests pass. |
| 2: Git | Real local object materialization and authenticated HTTPS subprocess acquisition with physically bounded staging. Disposable HTTPS and actual over-capacity writer tests pass. |
| 3: OCI | Real ORAS 1.3.0 against a disposable registry; digest, size, titles and streaming bounds validated. Registry and credential-isolation tests pass. |
| 4: cache | Owned persistent seeds, leases, admission/digest locks, protected checkout accounting, age/capacity pruning and verified hosted restoration. Lifecycle and pruning tests pass. |
| 5: views | Verified reflink, narrowly privileged OverlayFS and disk-admitted recursive copy. The 1,000-view, 2 GiB sparse gate passes. Representative private-release verification is recorded in the private `allagents-research` repository. |
| 6: capture | Immutable private-index baseline, frozen hierarchical ignores, exact binary/mode/link capture, deleted paths, bounded diff and explicit truncation/failure. Seven focused regression tests pass. |
| 7–8: providers/protocol | Workspace Provider and direct CopilotSdkProvider; closed Codex/Claude/Copilot adapters, bounded JSONL transport, process-group cancellation, native response and trace preservation. Protocol and tracing tests pass. |
| 9: lifecycle | Workspace remains live through filesystem, async and model-graded assertions. Native errors skip assertions; real CLI cleanup and later Node process recovery pass through the packed package. |
| 10: compatibility | Independently npm-installed stock Promptfoo 0.122.0 on Node 22.22.1 loads both named exports. Codex, Claude and Copilot fixtures pass all recorded stock assertions, labeled source selection, absent filters and direct Copilot. Credentialed dogfooding is recorded in the private `allagents-research` repository. |
| 11: release | Built tarball and trusted-publishing workflow are implemented; `next` uses a distinct prerelease and registry consumer/E2E gates run after publication. npm publication and registry-installed release-candidate/stable checks remain the explicit user-authorized final step; no npm token is present. |

## Reproduce

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test tests
bun run build
bun run pack:check
bun run e2e
ALLAGENTS_TEST_ORAS_PATH=/path/to/oras ALLAGENTS_TEST_GIT_HTTPS=1 bun test tests
bun scripts/benchmark-workspaces.ts
```

The current local full suite passes 87 tests with 348 assertions when the privileged OverlayFS identity gate is enabled, including real HTTPS Git and OCI acquisition. The default suite passes 82 tests with 333 assertions and skips the five real-acquisition gates. TypeScript, Biome, both builds, packed npm/pnpm/Bun consumers and stock Promptfoo E2E pass.

Install the fixed helper documented in `docs/workspace-helper.md` before the real Linux mount/acquisition gates. Validation CI runs Linux/macOS checks and a Linux real-acquisition job. The scale JSON reports fixture geometry as well as allocation; a one-file sparse fixture does not predict OverlayFS metadata cost for a large repository.

Native peers resolve the evaluation project's ESM export conditions. Using Promptfoo's CommonJS export can mask an SDK failure with `chalk.default.red is not a function` under an ordinary npm dependency graph. Native SDK discovery also uses the consumer process directory; the adapter separately forces the isolated workspace as the SDK's working directory. The import/require regression, external-directory regression and independently npm-installed E2E with workspace storage outside the consumer cover these boundaries. Overlay capability probes touch only the selected file and mount root; production views still restore writable modes throughout their source. Cleanup changes directory permissions before unlinking read-only files.

Promptfoo's native Codex adapter starts the Codex CLI with its own minimal environment. The delegate runner forwards exactly the authored `delegate.env` keys into that native adapter's internal `cli_env`, while rejecting authored `cli_env` and environment inheritance. This is required for custom Codex model providers whose CLI configuration and credential are supplied through `CODEX_HOME` and a named key variable. A focused regression checks the boundary; source-free live Azure controls and stock Promptfoo dogfooding are retained in private `allagents-research`.

`promptfoo-e2e.json` records assertions extracted from actual passing Promptfoo component results, cleanup/recovery checks and consumer versions. `scale.json` records actual 1,000 retained views, independent writes, observed allocation and retained cache after cleanup. Private-release measurements, mapped source identifiers and credentialed dogfooding belong in the private `allagents-research` repository; WTG-specific workflows belong in the private `WTG.AI.Prompts` repository.

Root ownership is published as a completed marked directory. A separate-process regression pauses marker publication and proves another publisher can initialize safely; both absent and preexisting empty roots are covered. Cache bootstrap and runtime-parent initialization use fixed sibling kernel-lock files so restored caches and managers with different caches cannot observe partial control state. Existing symlink ancestors are rejected before parent creation. A hard kill during the small bootstrap metadata write can leave a sibling metadata-only directory; it is outside the row resource journal and is not automatically reaped without verified ownership and dead-process identity.

Initialization and acquisition lock waits extend to the authored source timeout, with the existing three-minute minimum. A real cold-acquisition reproduction held admission for 195 seconds: the previous code failed the follower at 180 seconds despite its 600-second source timeout. A separate-process regression scales only native lock wait clocks and proves the corrected follower returns valid source content. Native cancellation preserves its reason and leaves the holder intact; cleanup before the first row permits a later manager to prepare normally. Lease release and pruning retain independent waits.

Overlay teardown also returns kernel-owned work entries through the fixed helper when a mount attempt has left them behind but no mount remains visible. A Linux acquisition CI run exposed this path after its five-second test timeout interrupted a privileged probe. Probe cleanup now visits both recorded views, and the initialization test allows a bounded 30 seconds on loaded runners. The fixed build passes the local real HTTPS/OCI suite and built Promptfoo E2E; the real Linux CI gate is recorded separately.
The helper and unprivileged fallback also compare each visible OverlayFS mount's source label to the target and recorded lower/upper/work paths before detach. A privileged regression mounts one owned view, presents a different owned state and a different published lower path, and confirms both releases are refused while the original mount stays live. The correct recorded tuple then detaches cleanly.
