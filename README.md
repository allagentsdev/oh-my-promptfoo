# Promptfoo Integrations

Public Promptfoo providers, extensions, assertions, and workspace integrations for coding agents.

The first planned package, `@allagents/promptfoo-integration`, exports:

- `Provider`, which owns a workspace and delegates execution to a supported coding-agent provider;
- `CopilotSdkProvider`, a lower-level provider for callers that already manage their workspace; and
- `@allagents/promptfoo-integration/lifecycle`, a package-matched subpath exporting the required `workspaceLifecycle` Promptfoo extension that releases row workspaces after assertions.

## Architecture

- [Domain context](CONTEXT.md)
- [ADR 0001: Publish a workspace-owning Promptfoo integration package](docs/adr/0001-publish-workspace-owning-agent-providers.md)
- [Implementation plan](docs/plans/2026-09-29-promptfoo-agent-integrations.md)

The repository currently contains the proposed design and implementation plan. Runtime packages will be added in follow-up pull requests.

The design uses stock Promptfoo package providers and lifecycle extensions. The same package ships `allagents-promptfoo doctor`: read-only mode validates every workspace config for consumer CI, while explicit `doctor --fix` makes reviewable YAML changes and stages one small config-local re-export shim per config directory. No runtime compiler, Promptfoo fork, separate CLI package, or upstream provider-cleanup change blocks implementation.
