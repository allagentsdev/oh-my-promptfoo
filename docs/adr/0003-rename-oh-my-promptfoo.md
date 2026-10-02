# ADR 0003: Name the Promptfoo toolkit oh-my-promptfoo

- Status: Accepted
- Date: 2026-10-03
- Supersedes: the repository and npm package names in [ADR 0002](0002-rename-promptfoo-x.md)

## Context

`@allagents/promptfoo-x` shipped on 2026-10-02. The repository already describes a broader direction for coding-agent evaluations, and `promptfoo-x` gives little indication of that purpose. This is the earliest practical point to settle a long-term name before more users adopt it.

## Decision

Rename the GitHub repository to `allagentsdev/oh-my-promptfoo` and publish the package as `@allagents/oh-my-promptfoo`, starting at 1.6.0. Keep the Promptfoo provider IDs explicit: `package:@allagents/oh-my-promptfoo:Provider` and `package:@allagents/oh-my-promptfoo:CopilotSdkProvider`.

Keep the previously published `@allagents/promptfoo-x` and `@allagents/promptfoo-integration` packages installable for existing users. Deprecate their versions with a pointer to the new package after its registry verification succeeds. Do not reuse their package names for new releases.

The workspace cache directory and ownership markers retain their `promptfoo-integration` identifiers. These identify existing on-disk data and are independent of the public package name.

The initial 1.6.0 publication uses an npm CLI login because the new package does not yet have an npm trusted-publisher registration. Configure the trusted publisher for the renamed GitHub repository before enabling later automated `next` and stable publications.
