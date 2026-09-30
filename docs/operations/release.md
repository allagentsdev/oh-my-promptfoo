# Release packages

Use the [Release Please procedure](../releasing.md). After the first `1.0.0`, `main` pushes with a pending release PR publish `next` previews. Merging that PR creates a draft GitHub stable release and dispatches the OIDC-authorized `publish.yml` for `latest`.

Private representative exact-pin verification recorded in `docs/evidence/implementation.md` applies to private consumers and is not a prerequisite for publishing this public npm package. Run private source/provider smokes when changes affect private deployments; private working trees, credentials, and evidence remain in `allagents-research`, never public CI.
