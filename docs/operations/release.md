# Release packages

Use the [release procedure](../releasing.md), including the one-time publication of `@allagents/promptfoo-x@1.5.0`. After that bootstrap, `main` pushes with a pending release PR publish `next` previews. Merging that PR creates a draft GitHub stable release and dispatches the OIDC-authorized `publish.yml` for `latest`.

Private representative exact-pin verification recorded in `docs/evidence/implementation.md` applies to private consumers and is not a prerequisite for publishing this public npm package. Run private source/provider smokes when changes affect private deployments; private working trees, credentials, and evidence remain in `allagents-research`, never public CI.
