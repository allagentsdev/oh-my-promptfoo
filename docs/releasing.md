# Releasing to npm

## First release under the new name

`@allagents/promptfoo-x` is a new npm package; the published `@allagents/promptfoo-integration` package cannot be renamed in place. Version 1.5.0 is the first stable release under the new name. The Release Please workflow waits until that version exists on npm so it cannot mistake the old `v1.4.1` GitHub release for a release of the new package.

After the rename change is merged and its validation passes, tag the reviewed main commit `v1.5.0` and create a draft GitHub release at that tag. An `@allagents` npm owner must first publish a `1.5.0-rc.1` prerelease to establish the new package name. From a clean checkout of `v1.5.0`, run the following commands while authenticated to npm:

```sh
bun install --frozen-lockfile
bun run build
bootstrap_dir=$(mktemp -d)
npm pack ./packages/promptfoo-x --pack-destination "$bootstrap_dir"
mkdir "$bootstrap_dir/unpacked"
tar -xzf "$bootstrap_dir"/allagents-promptfoo-x-1.5.0.tgz -C "$bootstrap_dir/unpacked"
npm pkg set version=1.5.0-rc.1 --prefix "$bootstrap_dir/unpacked/package"
npm publish "$bootstrap_dir/unpacked/package" --access public --tag bootstrap --provenance=false
```

The bootstrap prerelease has no provenance and does not move the `latest` tag. Once `@allagents/promptfoo-x@1.5.0-rc.1` appears on npm, configure trusted publishers for `allagentsdev/promptfoo-x` and the `publish.yml` and `release-please.yml` workflows. Dispatch `publish.yml` for `v1.5.0`; it builds and publishes stable `1.5.0` with OIDC provenance, verifies registry consumers, then makes the GitHub release public. Finally dispatch `release-please.yml` to resume automatic future releases.

Keep the old npm package available. After the new package passes registry verification, deprecate the old package with a message pointing users to `@allagents/promptfoo-x`; do not unpublish it.

## Later releases

After the initial stable release, Release Please prepares version and changelog pull requests. While one is pending, each push to `main` publishes an installable `X.Y.Z-next.N` preview under npm's `next` dist-tag and creates a matching GitHub prerelease from that `main` commit. Merging the release PR creates a draft stable tag and GitHub release, then dispatches [publish.yml](../.github/workflows/publish.yml) at that tag. Publish runs source and packed Promptfoo checks, publishes stable under `latest` with npm OIDC, verifies the installed registry version, and only then makes the GitHub release public. `next` previews are not candidates from the eventual release-PR merge commit; post-publication registry checks can fail after `latest` is already immutable.

1. The first `1.0.0` of the old `@allagents/promptfoo-integration` package was tagged at reviewed `main` commit `e10a9d3` and published by the GitHub-hosted OIDC workflow. Public CI, packed consumers, and installed-registry Promptfoo E2E passed. A separate private target check is not an npm or public-package release prerequisite; run private dogfooding when the private deployment needs it.
2. For subsequent releases, use Conventional Commits. Release Please opens a draft PR updating both manifest versions and `CHANGELOG.md`; its workflow synchronizes `bun.lock` and marks the PR ready only after that commit succeeds. Review the version and CI checks before merging. GitHub does not trigger PR checks from PRs created with its default `GITHUB_TOKEN`; to avoid manual validation, configure the repository's `RELEASE_PLEASE_TOKEN` GitHub credential. This credential is not an npm token.
3. On `main` pushes while a release PR is open, `release-please.yml` publishes a new prerelease under `next`. Merging that PR tags the reviewed merge commit and dispatches `publish.yml` automatically. Publish validates that stable tag is reachable from `main`, checks local and packed consumers, publishes under `latest`, verifies registry consumers and Promptfoo E2E, then publishes the draft GitHub release.

4. If publishing fails before npm accepts the package, the GitHub release remains draft. npm may accept a package before its version and dist-tag become queryable; the publisher waits up to five minutes for indexing rather than immediately treating that lag as a failure. Rerun `publish.yml` for the same stable tag after a transient failure: an already-published version is verified, never republished. If registry consumer checks expose a real defect after npm acceptance, that version is immutable; fix it on `main` and publish a corrective version. Rerun `release-please.yml` only if dispatch itself failed.

Configure npm trusted publishers for organization `allagentsdev`, repository `promptfoo-x`, GitHub environment `npm`: `release-please.yml` publishes `next` previews and `publish.yml` publishes stable `latest`, each with direct `npm publish` allowed. Both jobs need `id-token: write` and npm 11.6.2; no npm token is stored in GitHub. See [npm's trusted-publishing setup](https://docs.npmjs.com/trusted-publishers/).

The initial `1.0.0-rc.1` was published manually without provenance. `1.0.0` was the first stable OIDC release from commit `e10a9d3`; an immediate npm indexing read failed, and the successful rerun verified the accepted package without republishing. `1.0.1-next.11` became the first automatic `next` preview, and merging Release Please PR #13 published `1.0.1` under `latest` from its reviewed merge commit. Those three OIDC-published versions have signed provenance; the manual `rc.1` does not. Published version bytes and metadata cannot be changed retroactively.
