# Domain context

## Agent provider

A Promptfoo provider that invokes a coding agent and returns its output, usage, trajectory, and provider metadata. An agent provider does not decide evaluation scores.

## Workspace provider

The public provider that owns workspace acquisition, one delegated agent call, one post-agent verifier call, and checkout cleanup. It reads the workspace and verifier specifications from its own config and returns a successful response only after the private checkout has been removed. A cleanup failure is a provider error, and any unreleased path remains opaque and ownership-marked for recovery.

## Delegate

The agent provider selected by the workspace provider. The initial delegates are Promptfoo's Codex SDK provider, Promptfoo's Claude Agent SDK provider, and the package's Copilot SDK provider.

## Verifier

A trusted consumer-supplied executable that runs after the delegate has fully stopped and before its private checkout is removed. It inspects the final workspace, may consider the prompt and delegate response, and emits bounded rewards, JSON evidence, or both. It does not directly decide Promptfoo pass/fail.

## Verifier result

The durable, workspace-independent output returned at `providerResponse.metadata.verifier`. It contains bounded rewards or evidence and may identify a separate verifier trace. Promptfoo assertions consume this result after the checkout no longer exists.

## File changes

The bounded agent-attributed result returned at `providerResponse.metadata.fileChanges`. The provider captures exact generated or modified after-bytes, deleted paths, and an optional unified diff after the delegate stops but before verifier code runs. Assertions consume this durable result after the checkout no longer exists.

## Source request

A credential-free configured request for materialization at a non-overlapping destination within a workspace seed. Its Git ref or OCI tag may be mutable.

## Requested identity

The source identity supplied by configuration, such as a Git ref or OCI tag. It may be mutable and is never sufficient provenance by itself.

## Resolved source

A source request paired with the immutable identity selected during preparation: a Git commit or OCI manifest digest.

## Workspace specification

The complete declaration of source requests and their destinations for an agent run. It contains no credentials or arbitrary commands and is normalized by destination for identity.

## Workspace seed

A verified materialization owned by one workspace provider instance. The provider treats it as immutable, verifies its integrity before cloning, and never shares writable filesystem objects with checkouts.

## Workspace checkout

A writable copy of one workspace seed owned exclusively by one provider call. The delegate mutates it and the verifier inspects it. A successful provider response means removal succeeded; cleanup failure returns an error and leaves any unreleased root opaque and ownership-marked for recovery. “Private” means exclusive lifecycle and no shared writable objects, not a security sandbox against a same-user process that deliberately traverses the host filesystem.

## Workspace provenance

The immutable manifest digest and resolved Git commits or OCI digests that identify the checkout's inputs. It is durable metadata and contains no local filesystem path.

## Provider response

Promptfoo's complete JSON-safe native response from a delegate. The workspace provider preserves its fields and native metadata at their original locations, then adds `metadata.fileChanges`, `metadata.verifier`, and an AllAgents-specific provenance block. In particular, normalized `metadata.skillCalls` remains top-level.

## Agent trace

The Promptfoo row trace containing only delegated agent activity. It carries normalized tool spans used by `trajectory:*` assertions and must not contain verifier commands, tools, or judge calls.

## Verifier trace

A separate optional trace for verifier activity. Its identifier may appear in `metadata.verifier.traceId`; it does not contribute to agent trajectory assertions or delegate token usage.

## Integration

A versioned Promptfoo-facing package maintained in this repository. The first package is `@allagents/promptfoo-integration`; it contains the workspace-owning provider and lower-level Copilot SDK provider. Later integrations may include assertions only when a concrete consumer requires them.

## Assertion

A deterministic or model-graded Promptfoo check that contributes to the evaluation score and pass/fail result. Assertions may inspect the unchanged delegate output, durable file changes, or verifier result. Providers and verifiers do not replace Promptfoo's assertion engine.
