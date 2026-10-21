# ADR 0007: Name captured additions and modifications changedFiles

- Status: Accepted
- Date: 2026-10-21
- Supersedes: the `fileChanges.generatedFiles` field and `schemaVersion` 1 in [ADR 0001](0001-publish-workspace-owning-agent-providers.md)

## Context

The file-change capture map contains both added and modified files, already distinguished by each entry's `change` value. Its previous name misleadingly described these as generated files. The maintainer confirmed there are no external users.

## Decision

Rename the map to `metadata.fileChanges.changedFiles` with no alias or compatibility shim. Bump the file-change record's `schemaVersion` from 1 to 2 for every status because its shape changes. Retain all other fields, behavior, and limits.

## Consequences

This is a breaking metadata-field rename, shipped in a minor release rather than a major release because there are no external users. Consumers must read `changedFiles` and recognize `schemaVersion: 2`; the previous field is no longer available.
