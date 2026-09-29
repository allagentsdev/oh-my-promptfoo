# Domain context

## Agent provider

A Promptfoo provider that invokes a coding agent and returns its output, usage, trajectory, and provider metadata. An agent provider does not decide evaluation scores.

## Workspace provider

The public provider that owns workspace acquisition, one delegated agent call, transient assertion access, and change reporting. It reads the workspace specification from its own config and registers each private checkout under the opaque row claim supplied by the workspace lifecycle.

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

A writable copy of one workspace seed owned exclusively by one provider call. It remains available to Promptfoo assertions through the response metadata path. The workspace lifecycle removes it after that row's assertions; suite cleanup, provider cleanup, and lease-backed stale recovery are fallbacks. "Private" means exclusive lifecycle and no shared writable objects, not a security sandbox against a same-user process that deliberately traverses the host filesystem.

## File changes

A bounded immutable record of paths added, modified, deleted, renamed, or left indeterminate relative to the immutable source baseline. It is convenience metadata for results and assertions, not a copy of file contents or a replacement for inspecting the live workspace.

## Provider response

Promptfoo's native response from a delegate. The workspace provider preserves its output and usage and adds namespaced workspace provenance, the transient checkout path, and bounded file-change metadata.

## Integration

A versioned Promptfoo-facing package maintained in this repository. The first package is `@allagents/promptfoo-integration`; it contains providers, their coupled workspace lifecycle, and the matching configuration doctor. Later integrations may include assertions.

## Workspace lifecycle

The package-matched Promptfoo extension that creates opaque row claims in `beforeEach`, removes registered row checkouts in `afterEach`, and sweeps remaining resources in `afterAll`. It does not define workspace sources or invoke a model.

## Configuration doctor

The `allagents-promptfoo doctor` command shipped by the integration package. It validates workspace-provider lifecycle configuration without modifying files. Explicit `doctor --fix` applies idempotent, reviewable YAML repairs and stages only the package re-export shim required by Promptfoo's current `file://` extension loader. It never compiles or mutates configuration at evaluation time.

## Extension

A Promptfoo lifecycle hook invoked at `beforeAll`, `beforeEach`, `afterEach`, or `afterAll`. An extension is not a provider and does not decide evaluation scores.

## Assertion

A deterministic or model-graded check that contributes to Promptfoo's score and pass/fail result. Providers and lifecycle extensions do not assign evaluation scores.
