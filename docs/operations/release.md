# Release packages

Use the [tag-pinned release procedure](../releasing.md). `publish.yml` uses npm OIDC and provenance for the reviewed RC and stable tags; `release-please.yml` prepares subsequent version and changelog PRs only after the first stable release. Only `publish.yml` needs an npm trusted-publisher connection.

The private representative exact-pin gate referenced in `docs/evidence/implementation.md` must pass before release. Private source and working trees stay on the private target runner; evidence and dogfooding belong in `allagents-research`. Live provider smokes run when organization model credentials are available.
