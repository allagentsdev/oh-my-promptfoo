# Promptfoo Integrations

Public Promptfoo providers and workspace integrations for coding agents.

The first planned package, `@allagents/promptfoo-integration`, exports:

- `Provider`, which owns a workspace, delegates one coding-agent call, captures bounded generated/deleted files and a unified diff, runs a trusted verifier while the workspace is still live, and returns success only after cleanup; and
- `CopilotSdkProvider`, a lower-level provider for callers that already manage their working directory.

## Architecture

- [Domain context](CONTEXT.md)
- [ADR 0001: Publish a workspace-owning Promptfoo integration package](docs/adr/0001-publish-workspace-owning-agent-providers.md)
- [Implementation plan](docs/plans/2026-09-29-promptfoo-agent-integrations.md)

The repository currently contains the proposed design and implementation plan. Runtime packages will be added in follow-up pull requests.

The design uses stock Promptfoo package providers. `Provider` preserves the delegate's native output, usage, metadata, skills, and agent trace; captures agent-attributed files and a bounded diff at `metadata.fileChanges`; adds verifier rewards or evidence at `metadata.verifier`; and returns a successful result only after removing the private checkout. Assertions consume durable response data rather than a transient filesystem path. Cleanup failure remains an explicit provider error with ownership-marked stale recovery. No lifecycle extension, configuration doctor, runtime compiler, Promptfoo fork, or separate execution gateway blocks implementation.
