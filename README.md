# Promptfoo Integrations

Public Promptfoo providers, extensions, assertions, and workspace integrations for coding agents.

The first planned package, `@allagents/promptfoo-provider`, exports:

- `Provider` / `WorkspaceProvider`, which owns a workspace and delegates execution to a supported coding-agent provider; and
- `CopilotSdkProvider`, a lower-level provider for callers that already manage their workspace.

## Architecture

- [Domain context](CONTEXT.md)
- [ADR 0001: Publish a workspace-owning Promptfoo provider package](docs/adr/0001-publish-workspace-owning-agent-providers.md)
- [Implementation plan](docs/plans/2026-09-29-promptfoo-agent-integrations.md)

The repository currently contains the proposed design and implementation plan. Runtime packages will be added in follow-up pull requests.
