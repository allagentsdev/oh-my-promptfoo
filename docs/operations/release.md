# Release packages

Use the [Release Please procedure](../releasing.md). After the first `1.0.0`, `main` pushes with a pending release PR publish `next` previews. Merging that PR creates a draft GitHub stable release and dispatches the OIDC-authorized `publish.yml` for `latest`.

The private representative exact-pin gate referenced in `docs/evidence/implementation.md` is required before the initial `1.0.0` release. It is not an automated gate for subsequent releases. Run private source and provider smokes before merging future release PRs when those changes affect private deployments; private working trees and evidence remain in `allagents-research`.
