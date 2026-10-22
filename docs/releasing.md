# Releasing to npm

## First release as oh-my-promptfoo

`oh-my-promptfoo` is a new npm package. Version 1.6.0 is its first stable release. The Release Please workflow treats this package separately from releases under earlier names.

The first release was tagged `v1.6.0` at reviewed main commit `50c5684` and published with `npm login --auth-type=web` and `npm publish ./packages/oh-my-promptfoo --access public --tag latest --provenance=false`. Packed-package checks, installed-registry consumers, and Promptfoo E2E passed before the GitHub release became public.

Trusted publishing is configured for the renamed repository's preview and stable workflows. The earlier npm packages have been removed from the registry; `oh-my-promptfoo` is the installable package.

## Later releases

After the initial stable release, Release Please prepares version and changelog pull requests. While one is pending, each push to `main` publishes an installable `X.Y.Z-next.N` preview under npm's `next` dist-tag and creates a matching GitHub prerelease from that `main` commit. Merging the release PR creates a draft stable tag and GitHub release, then dispatches [publish.yml](../.github/workflows/publish.yml) at that tag. Publish runs source and packed Promptfoo checks, publishes stable under `latest` with npm OIDC, verifies the installed registry version, and only then makes the GitHub release public. `next` previews are not candidates from the eventual release-PR merge commit; post-publication registry checks can fail after `latest` is already immutable.

1. The first `1.0.0` of the old `@allagents/promptfoo-integration` package was tagged at reviewed `main` commit `e10a9d3` and published by the GitHub-hosted OIDC workflow. Public CI, packed consumers, and installed-registry Promptfoo E2E passed. A separate private target check is not an npm or public-package release prerequisite; run private dogfooding when the private deployment needs it.
2. For subsequent releases, use Conventional Commits. Release Please opens a draft PR updating both manifest versions and `CHANGELOG.md`; its workflow synchronizes `bun.lock` and marks the PR ready only after that commit succeeds. Review the version and CI checks before merging. GitHub does not trigger PR checks from PRs created with its default `GITHUB_TOKEN`; to avoid manual validation, configure the repository's `RELEASE_PLEASE_TOKEN` GitHub credential. This credential is not an npm token.
3. On `main` pushes while a release PR is open, `release-please.yml` publishes a new prerelease under `next`. Merging that PR tags the reviewed merge commit and dispatches `publish.yml` automatically. Publish validates that stable tag is reachable from `main`, checks local and packed consumers, publishes under `latest`, verifies registry consumers and Promptfoo E2E, then publishes the draft GitHub release.

4. If publishing fails before npm accepts the package, the GitHub release remains draft. npm may accept a package before its version and dist-tag become queryable; the publisher waits up to five minutes for indexing rather than immediately treating that lag as a failure. Rerun `publish.yml` for the same stable tag after a transient failure: an already-published version is verified, never republished. If registry consumer checks expose a real defect after npm acceptance, that version is immutable; fix it on `main` and publish a corrective version. Rerun `release-please.yml` only if dispatch itself failed.

npm trusted publishers for organization `allagentsdev`, repository `oh-my-promptfoo`, GitHub environment `npm` are configured for `release-please.yml` (`next` previews) and `publish.yml` (stable `latest`), each with direct `npm publish` allowed. Both jobs need `id-token: write` and npm 11.6.2; no npm token is stored in GitHub. See [npm's trusted-publishing setup](https://docs.npmjs.com/trusted-publishers/).

The initial `1.0.0-rc.1` was published manually without provenance. `1.0.0` was the first stable OIDC release from commit `e10a9d3`; an immediate npm indexing read failed, and the successful rerun verified the accepted package without republishing. `1.0.1-next.11` became the first automatic `next` preview, and merging Release Please PR #13 published `1.0.1` under `latest` from its reviewed merge commit. Those three OIDC-published versions have signed provenance; the manual `rc.1` does not. Published version bytes and metadata cannot be changed retroactively.

## Dependency maintenance

Development and CI use Bun and the root `bun.lock`; publishing to npm does not change the package manager. Dependabot uses the `bun` ecosystem for workspace dependencies and `github-actions` for workflow actions. Updates arrive weekly, with minor/patch package updates grouped and major package updates left separate. Node types stay on major 22 until the runtime floor changes.

The [Dependency Audit workflow](../.github/workflows/dependency-audit.yml) runs daily, on dependency-changing pull requests, and manually. It runs `bun audit --audit-level=moderate` against the lockfile. Moderate, high, or critical advisories fail the job; a registry or network error also fails rather than reporting a clean audit. It then installs the frozen lockfile with dependency scripts disabled and exercises the Forge acceptance regressions below.

GitHub currently supports Bun version-update PRs but not Bun security-update PRs ([supported ecosystems](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories)). Zero Dependabot alerts is not evidence that the Bun dependency tree is clean. Scheduled audits detect newly published advisories even when no code changes.

Before merging a dependency update, run the audit and the normal validation checks. Review SDK peer requirements in `packages/oh-my-promptfoo/package.json` alongside root development pins and packed-package compatibility. `bun audit fix --dry-run` shows compatible fixes and parent ranges that block them; do not force major upgrades or add advisory exceptions just to make CI green. An advisory with no published fix remains a merge blocker until a reviewed remediation or explicit risk decision is available.

### Reviewed security overrides

The private development workspace uses Promptfoo `0.124.1` and two root overrides while upstream dependency ranges block the fixes:

* `get-uri@8.0.1` uses `basic-ftp@6.2.3`, including the directory-listing and PASV parsing fixes. The consumed download/list API is compatible; the deliberate security change is that PASV transfers to a different non-loopback host are rejected. FTP PAC deployments that require separate transfer hosts are not compatible with this override. `get-uri` cannot opt back in and has a pre-existing unhandled download-rejection path; use same-host/EPSV FTP or an HTTPS PAC URL instead. Replace the override when the upstream proxy-agent/get-uri chain ships compatible secure ranges ([upstream PR](https://github.com/TooTallNate/proxy-agents/pull/500)).
* `node-forge` uses the genuine source commit `db05494352dd3c9a5a07c5270333dcc78866cad2` from [Forge PR #1159](https://github.com/digitalbazaar/forge/pull/1159), which rejects noncanonical RSA DigestInfo encodings for CVE-2026-85393. This is an immutable, unmerged contributor commit, not an official patched release; its `1.4.1-0` version comes from upstream. The earlier element-count-only proposal does not cover all bypasses. Replace this source pin once an official release includes the canonical-encoding fix and passes the same regressions.

Bun excludes Git resolutions from its registry advisory query. A clean registry audit therefore does **not** establish that Forge is secure. `tests/dependency-security.test.ts` resolves the actual Promptfoo → JKS → Forge implementation and checks valid signatures, changed messages, both canonical parameter forms, extra sequence elements, non-NULL/nonempty parameters, nonminimal lengths, and trailing bytes with normal padding checks. The dependency-audit workflow and normal validation run these cases. Maintainers must also review new upstream Forge advisories and releases while the source pin remains; Dependabot does not manage override-only declarations.

These overrides apply to this repository's private workspace, not to consumers' independently installed Promptfoo peers. Consumers must audit their own lockfiles. Root overrides require Bun `1.4.0`; the parent-scoped FTP override uses lockfile format 3.
