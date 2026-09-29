# Promptfoo Integrations

Public Promptfoo providers and workspace integrations for coding agents.

The first planned package, `@allagents/promptfoo-integration`, exports:

- `Provider`, which acquires immutable workspace inputs, creates one private writable workspace per agent call with independently writable or protected read-only sources, preserves the delegate's complete native response, exposes the live workspace to Promptfoo assertions, and optionally captures bounded changed files;
- `CopilotSdkProvider`, a lower-level provider for callers that already manage their working directory; and
- `allagents-promptfoo`, a small cache-maintenance CLI whose `cache prune` command removes unleased cached inputs.

## Architecture

- [Domain context](CONTEXT.md)
- [ADR 0001: Publish a workspace-owning Promptfoo integration package](docs/adr/0001-publish-workspace-owning-agent-providers.md)
- [Implementation plan](docs/plans/2026-09-29-promptfoo-agent-integrations.md)

The repository currently contains the proposed design and implementation plan. Runtime packages will be added in follow-up pull requests.

The design uses stock Promptfoo package providers and its existing assertion engine. `Provider` preserves native output, usage, metadata, `skillCalls`, and agent traces. JavaScript assertions inspect the final filesystem through `metadata.workspace.path`; `fileChanges: true` additionally returns bounded generated or modified contents, deleted paths, and a unified diff at `metadata.fileChanges`.

Large repositories use one persistent immutable seed per resolved source manifest. Each source defaults to a private writable reflink, overlay, or recursive-copy view; a source configured with `workspace.sources[].permissions: read-only` may instead reuse a protected prepared checkout. Every row still receives its own writable workspace path. Source permissions do not change the seed identity, so read-only and writable configurations reuse the same immutable input. Writable symlinks and hardlinks are prohibited because they would share mutations between rows.

Use stock Promptfoo directly:

```bash
promptfoo eval --config promptfooconfig.yaml
```

Promptfoo cleanup is best effort, so a provider root may remain until a later process safely recovers it. Copy-on-write views share unchanged blocks, while shared protected source checkouts retain leases until their rows finish. `allagents-promptfoo cache prune` and automatic garbage collection remove only unleased cache entries under age and allocated-size policy; `cache prune --all` removes every unleased entry.

GitHub-hosted Actions runners discard workspaces and caches after each job. To reuse a seed across hosted jobs, cache only the published immutable seed subtree and its verification metadata; never cache leases, prepared checkouts, staging, locks, or runtime roots. A fresh runner validates restored seeds and starts new local lease state. Local and self-hosted runners retain their live cache and leases together until stale workspaces have been recovered.
