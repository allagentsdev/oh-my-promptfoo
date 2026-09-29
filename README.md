# Promptfoo Integrations

Public Promptfoo providers, extensions, assertions, and workspace integrations for coding agents.

The first planned packages provide:

- a workspace-owning agent provider that delegates to Promptfoo's Codex and Claude providers or the AllAgents Copilot provider; and
- a standalone open-source Copilot SDK provider for callers that already manage their workspace.

## Architecture

- [Domain context](CONTEXT.md)
- [ADR 0001: Publish workspace-owning Promptfoo agent providers](docs/adr/0001-publish-workspace-owning-agent-providers.md)
- [Implementation plan](docs/plans/2026-09-29-promptfoo-agent-integrations.md)

The repository currently contains the proposed design and implementation plan. Runtime packages will be added in follow-up pull requests.
