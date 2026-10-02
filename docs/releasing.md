# Releasing to npm

## First release as oh-my-promptfoo

`oh-my-promptfoo` is a new npm package. Version 1.6.0 is its first stable release. The Release Please workflow treats this package separately from releases under earlier names.

The first release was tagged `v1.6.0` at reviewed main commit `50c5684` and published with `npm login --auth-type=web` and `npm publish ./packages/oh-my-promptfoo --access public --tag latest --provenance=false`. Packed-package checks, installed-registry consumers, and Promptfoo E2E passed before the GitHub release became public.

Trusted publishing is configured for the renamed repository's preview and stable workflows. Published versions of `@allagents/promptfoo-x` remain installable and are deprecated with a pointer to `oh-my-promptfoo`. `@allagents/promptfoo-integration` is no longer available from the npm registry.

## Later releases

After the initial stable release, Release Please prepares version and changelog pull requests. While one is pending, each push to `main` publishes an installable `X.Y.Z-next.N` preview under npm's `next` dist-tag and creates a matching GitHub prerelease from that `main` commit. Merging the release PR creates a draft stable tag and GitHub release, then dispatches [publish.yml](../.github/workflows/publish.yml) at that tag. Publish runs source and packed Promptfoo checks, publishes stable under `latest` with npm OIDC, verifies the installed registry version, and only then makes the GitHub release public. `next` previews are not candidates from the eventual release-PR merge commit; post-publication registry checks can fail after `latest` is already immutable.

1. The first `1.0.0` of the old `@allagents/promptfoo-integration` package was tagged at reviewed `main` commit `e10a9d3` and published by the GitHub-hosted OIDC workflow. Public CI, packed consumers, and installed-registry Promptfoo E2E passed. A separate private target check is not an npm or public-package release prerequisite; run private dogfooding when the private deployment needs it.
2. For subsequent releases, use Conventional Commits. Release Please opens a draft PR updating both manifest versions and `CHANGELOG.md`; its workflow synchronizes `bun.lock` and marks the PR ready only after that commit succeeds. Review the version and CI checks before merging. GitHub does not trigger PR checks from PRs created with its default `GITHUB_TOKEN`; to avoid manual validation, configure the repository's `RELEASE_PLEASE_TOKEN` GitHub credential. This credential is not an npm token.
3. On `main` pushes while a release PR is open, `release-please.yml` publishes a new prerelease under `next`. Merging that PR tags the reviewed merge commit and dispatches `publish.yml` automatically. Publish validates that stable tag is reachable from `main`, checks local and packed consumers, publishes under `latest`, verifies registry consumers and Promptfoo E2E, then publishes the draft GitHub release.

4. If publishing fails before npm accepts the package, the GitHub release remains draft. npm may accept a package before its version and dist-tag become queryable; the publisher waits up to five minutes for indexing rather than immediately treating that lag as a failure. Rerun `publish.yml` for the same stable tag after a transient failure: an already-published version is verified, never republished. If registry consumer checks expose a real defect after npm acceptance, that version is immutable; fix it on `main` and publish a corrective version. Rerun `release-please.yml` only if dispatch itself failed.

npm trusted publishers for organization `allagentsdev`, repository `oh-my-promptfoo`, GitHub environment `npm` are configured for `release-please.yml` (`next` previews) and `publish.yml` (stable `latest`), each with direct `npm publish` allowed. Both jobs need `id-token: write` and npm 11.6.2; no npm token is stored in GitHub. See [npm's trusted-publishing setup](https://docs.npmjs.com/trusted-publishers/).

The initial `1.0.0-rc.1` was published manually without provenance. `1.0.0` was the first stable OIDC release from commit `e10a9d3`; an immediate npm indexing read failed, and the successful rerun verified the accepted package without republishing. `1.0.1-next.11` became the first automatic `next` preview, and merging Release Please PR #13 published `1.0.1` under `latest` from its reviewed merge commit. Those three OIDC-published versions have signed provenance; the manual `rc.1` does not. Published version bytes and metadata cannot be changed retroactively.
