# ADR 0002: Use a short Promptfoo package name

- Status: Accepted
- Date: 2026-10-02
- Supersedes: the repository and npm package names in [ADR 0001](0001-publish-workspace-owning-agent-providers.md)

## Context

Users repeat the package name in each Promptfoo `package:` provider reference. The published package is `@allagents/promptfoo-integration` at version 1.4.2. The longer name makes evaluation YAML harder to read.

## Decision

Rename the GitHub repository to `allagentsdev/promptfoo-x` and publish future versions as `@allagents/promptfoo-x`. Use the named workspace provider as `package:@allagents/promptfoo-x:Provider`; the direct Copilot provider remains `package:@allagents/promptfoo-x:CopilotSdkProvider`. Promptfoo requires the export suffix after the package name. The published `:default` alias remains available for compatibility.

The new npm name requires a separate first publication. Publish a manually authenticated `1.5.0-rc.1` under the `bootstrap` tag to establish the name, then publish stable 1.5.0 through the trusted GitHub Actions workflow. Keep `@allagents/promptfoo-integration` available for existing installs and document the migration.

The workspace cache directory and ownership marker retain their old `promptfoo-integration` identifiers. They identify existing on-disk data, so retaining them lets the renamed package use a caller's current cache and prebuilt workspaces.
