# Domain context

## Agent provider

A Promptfoo provider that invokes a coding agent and returns its output, usage, trajectory, and provider metadata. An agent provider does not decide evaluation scores.

## Workspace provider

The public provider that owns workspace acquisition, one delegated agent call, transient assertion access, change reporting, and evaluation-shutdown cleanup. It delegates model execution through a supported delegate adapter.

## Delegate

The agent provider selected by the workspace provider. The initial delegates are Promptfoo's Codex SDK provider, Promptfoo's Claude Agent SDK provider, and the package's Copilot SDK provider.

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

A writable copy of one workspace seed owned exclusively by one provider call. It remains available to Promptfoo assertions through the response metadata path and is removed by the provider's evaluation-shutdown `cleanup()` hook. The package supports only Promptfoo releases that guarantee this hook after successful, failed, cancelled, and exceptional evaluations. "Private" means exclusive lifecycle and no shared writable objects, not a security sandbox against a same-user process that deliberately traverses the host filesystem.

## File changes

A bounded immutable record of paths added, modified, deleted, renamed, or left indeterminate relative to the immutable source baseline. It is convenience metadata for results and assertions, not a copy of file contents or a replacement for inspecting the live workspace.

## Provider response

Promptfoo's native response from a delegate. The workspace provider preserves its output and usage and adds namespaced workspace provenance, the transient checkout path, and bounded file-change metadata.

## Integration

A versioned Promptfoo-facing package maintained in this repository. Integrations include providers now and may include extensions and assertions later.

## Extension

A Promptfoo lifecycle hook invoked at `beforeAll`, `beforeEach`, `afterEach`, or `afterAll`. An extension is not a provider and does not invoke a model.

## Assertion

A deterministic or model-graded check that contributes to Promptfoo's score and pass/fail result. Providers and lifecycle extensions do not assign evaluation scores.
