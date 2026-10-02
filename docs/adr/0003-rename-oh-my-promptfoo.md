# ADR 0003: Name the Promptfoo toolkit oh-my-promptfoo

- Status: Accepted
- Date: 2026-10-03
- Supersedes: the repository and npm package names in [ADR 0002](0002-rename-promptfoo-x.md)

## Context

`@allagents/promptfoo-x` shipped on 2026-10-02. The repository already describes a broader direction for coding-agent evaluations, and `promptfoo-x` gives little indication of that purpose. This is the earliest practical point to settle a long-term name before more users adopt it.

## Decision

Rename the GitHub repository to `allagentsdev/oh-my-promptfoo` and publish the unscoped package `oh-my-promptfoo`, starting at 1.6.0. The unscoped name matches the repository and keeps installation and YAML references short. Keep the Promptfoo provider IDs explicit: `package:oh-my-promptfoo:Provider` and `package:oh-my-promptfoo:CopilotSdkProvider`.

Keep previously published `@allagents/promptfoo-x` versions installable for existing users and deprecate them with a pointer to the new package after registry verification succeeds. `@allagents/promptfoo-integration` is no longer available from the npm registry. Do not reuse the earlier package names for new releases.

The workspace cache directory and ownership markers retain their `promptfoo-integration` identifiers. These identify existing on-disk data and are independent of the public package name.

The initial 1.6.0 publication used an npm CLI login because the new package did not yet have an npm trusted-publisher registration. Trusted publishers for the renamed GitHub repository are configured for later automated `next` and stable publications.
