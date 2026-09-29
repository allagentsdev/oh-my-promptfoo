# Domain context

## Agent provider

A Promptfoo provider that invokes a coding agent and returns its output, usage, trajectory, and provider metadata. An agent provider does not decide evaluation scores.

## Workspace provider

The public `Provider` that resolves workspace inputs, acquires immutable cached sources, creates one private writable workspace per call with the requested source access, invokes one delegate, optionally captures changed files, and publishes the workspace for Promptfoo assertions. It retains successful workspaces until best-effort provider cleanup instead of guessing when a row's assertions have finished.

## Delegate

The agent provider selected by the workspace provider. The initial delegates are Promptfoo's Codex SDK provider, Promptfoo's Claude Agent SDK provider, and the package's Copilot SDK provider.

## Source request

A credential-free configured request for materialization at a non-overlapping destination within a workspace. Its Git ref or OCI tag may be mutable. Its source access is either private writable (`all`, the default) or protected read-only.

## Requested identity

The source identity supplied by configuration, such as a Git ref or OCI tag. It may be mutable and is never sufficient provenance by itself.

## Resolved source

A source request paired with the immutable identity selected during preparation: a Git commit or OCI manifest digest.

## Workspace specification

The complete declaration of source requests, destinations, and source permissions for an agent run. The workspace itself is private and writable. The specification contains no credentials or arbitrary commands and is normalized by destination for identity.

## Seed cache

The package-owned, content-addressed store of immutable workspace seeds and protected prepared source checkouts. Seeds are keyed by resolved manifest digest. The cache is shared across providers and evaluations and lives outside provider runtime roots. Successful workspace cleanup releases leases but does not discard reusable cache entries.

## Workspace seed

One verified immutable materialization in the seed cache. It is never the agent's workspace. Private writable source views and protected read-only source checkouts may both depend on it.

## Prepared read-only source checkout

A package-owned, protected materialization of one source, separate from the immutable seed and accounted for in the seed cache. Matching evaluations may share its source contents while retaining different private writable workspaces.

## Seed lease

A package-owned record that prevents cache garbage collection while a workspace source depends on a seed. A dead owner does not make a seed immediately evictable: stale-root recovery must release the dependent source before releasing its lease.

## Checkout adapter

The private mechanism that turns an immutable seed into an isolated writable source view. Implementations use verified reflink/clone primitives, an overlay with a read-only lower layer and private upper/work directories, or recursive copy. Plain writable symlinks, hardlinks, and writable bind mounts are not checkout adapters because they share mutable filesystem objects.

## Workspace checkout

A private writable workspace owned exclusively by one provider call. Each source destination is either a private writable view or a reference to a protected shared read-only source checkout. The delegate and Promptfoo assertions access it through `metadata.workspace.path`. “Private” means exclusive workspace lifetime and no shared writable source objects, not a security sandbox against a same-user process that deliberately traverses the host filesystem.

## Provider runtime root

A contained, ownership-marked directory for one workspace-provider instance. It contains private workspaces, source views, adapter state, a live process identity, and package-owned recovery records. Each workspace record exists before its source leases, inode trees, or mounts. `Provider.cleanup()` detaches views before releasing leases; failed detachment retains both for later recovery. The shared seed cache is never part of the root.

## Cache garbage collection

The independent process that removes unleased cache entries according to age and allocated-size policy, releasing protected source checkouts before any seed they depend on. One cache-wide admission lock serializes the size snapshot, LRU eviction, capacity decision, and publication across different digests; per-digest locks protect entries and leases. The collector rechecks package ownership, containment, and absence of every lease record before atomically moving an entry to package-owned trash. Workspace cleanup never doubles as cache eviction.

## Cache CLI

The `allagents-promptfoo cache prune` command. It applies normal age/size policy, while `cache prune --all` removes every unleased cache entry. It does not run Promptfoo, inspect result files, or delete provider runtime roots.

## Workspace metadata

The generic `providerResponse.metadata.workspace` block containing schema version, absolute private writable workspace path, manifest digest, resolved sources, and `cleanup: "best-effort-evaluation"`. The path is live through normal assertions but may remain after the evaluation if Promptfoo skips provider cleanup; it becomes invalid after provider cleanup, stale-root recovery, or host teardown.

## File changes

The optional bounded agent-attributed result at `providerResponse.metadata.fileChanges`. When enabled, the provider captures exact generated or modified after-bytes, deleted paths, and an optional unified diff after the delegate has fully stopped. The result is durable evaluation data; it does not extend checkout lifetime.

## Workspace provenance

The manifest digest and resolved Git commits or OCI digests that identify a checkout's immutable inputs. It is durable metadata and contains no local filesystem path.

## Provider response

Promptfoo's complete JSON-safe native response from a delegate. The workspace provider preserves fields and native metadata at their original locations, then adds `metadata.workspace` and optional `metadata.fileChanges`. Normalized `metadata.skillCalls` remains top-level.

## Agent trace

The Promptfoo row trace containing delegated agent activity. It carries normalized tool spans used by `trajectory:*` assertions and preserves incoming W3C trace identity across the delegate subprocess boundary.

## Integration

A versioned Promptfoo-facing package maintained in this repository. The first package is `@allagents/promptfoo-integration`; it contains the workspace-owning provider, lower-level Copilot SDK provider, and seed-cache maintenance CLI.

## Assertion

A deterministic or model-graded Promptfoo check that contributes to the evaluation score and pass/fail result. Assertions may inspect unchanged delegate output, the live workspace, optional durable file changes, skills, or the agent trajectory. The integration does not introduce a second grading engine.
