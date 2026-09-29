# Release packages

Configure the `@allagents/promptfoo-integration` npm trusted publisher for this repository's `release.yml` workflow and its `npm` GitHub environment. The workflow uses GitHub OIDC and npm 11.6.2. Initial scope/package setup requires access to the npm account; no local npm credential is present in this implementation session.

Dispatch **Release** on `main` with `next`. It publishes `<stable manifest version>-rc.<GitHub run number>`, checks the exact registry version with npm, pnpm and Bun, both without Copilot and with the actual Copilot SDK 1.0.6, and runs built Promptfoo E2E against that installed package.

Dispatch with `latest` after the candidate passes. This first resolves and verifies the matching `next` candidate using registry consumer and E2E gates, then publishes the stable manifest version with provenance and repeats those gates against the exact stable version. The source package manifest is restored after publication. Failed E2E pipelines stop the workflow before publication; validation evidence is uploaded on success or failure.

The private representative exact-pin gate referenced in `docs/evidence/implementation.md` must pass before release. Private source and working trees stay on the private target runner; evidence and dogfooding belong in `allagents-research`. Live provider smokes run when organization model credentials are available.
