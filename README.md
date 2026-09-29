# Promptfoo Integrations

Public Promptfoo providers and workspace integrations for coding agents.

The first planned package, `@allagents/promptfoo-integration`, exports:

- `Provider`, which acquires immutable workspace inputs, creates one private writable view per agent call, preserves the delegate's complete native response, exposes the live view to Promptfoo assertions, and optionally captures bounded changed files;
- `CopilotSdkProvider`, a lower-level provider for callers that already manage their working directory; and
- `allagents-promptfoo`, a small cache-maintenance CLI whose `cache prune` command removes unused immutable workspace seeds.

## Architecture

- [Domain context](CONTEXT.md)
- [ADR 0001: Publish a workspace-owning Promptfoo integration package](docs/adr/0001-publish-workspace-owning-agent-providers.md)
- [Implementation plan](docs/plans/2026-09-29-promptfoo-agent-integrations.md)

The repository currently contains the proposed design and implementation plan. Runtime packages will be added in follow-up pull requests.

The design uses stock Promptfoo package providers and its existing assertion engine. `Provider` preserves native output, usage, metadata, `skillCalls`, and agent traces. JavaScript assertions inspect the final filesystem through `metadata.workspace.path`; `fileChanges: true` additionally returns bounded generated or modified contents, deleted paths, and a unified diff at `metadata.fileChanges`.

Large repositories use one persistent immutable seed per resolved source manifest plus an automatically selected private reflink, overlay, or recursive-copy view. A thousand mostly unchanged views share the same cached repository blocks instead of copying the repository a thousand times. Writable symlinks and hardlinks are prohibited because they would share mutations between rows.

Use stock Promptfoo directly:

```bash
promptfoo eval --config promptfooconfig.yaml
```

Promptfoo cleanup is best effort, so a provider root may remain until a later process safely recovers it. That is acceptable for copy-on-write views: the capacity problem is the persistent seed cache, not the number of mostly unchanged workspace directories. `allagents-promptfoo cache prune` and automatic garbage collection remove only unleased seeds under age and allocated-size policy; `cache prune --all` removes every unleased seed.

GitHub-hosted Actions runners are disposable, so runner teardown removes stale workspaces and the local seed cache after each job. A seed survives into another hosted job only when the workflow explicitly restores the cache directory. Cache eviction and stale-root recovery matter primarily on local and self-hosted runners and before saving a hosted-runner cache.
