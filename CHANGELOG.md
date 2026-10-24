# Changelog

## Unreleased

### Features

* Add `pi-sdk` workspace and read-only agent-grader delegates using the maintained optional `@earendil-works/pi-coding-agent@1.3.0` peer, explicit model/credentials and local endpoint support. Isolated in-memory sessions report successful skill-file reads to stock `skill-used` without changing skill authoring.
* Add closed, workspace-contained Node stdio `mcpServers` for Copilot and Claude candidates, including per-test overrides, literal-only child environment, case-insensitive reserved env checks, configured-tool permissions, unambiguous Claude trace identity and independently supervised abort cleanup. Read-only graders reject configured servers; general configuration discovery remains disabled.

### Bug Fixes

* **workspace:** canonicalize declared protected source link targets in the workspace reader so Windows 8.3 short temp paths (`RUNNER~1`) are accepted; undeclared, mismatched and non-symlink sources are still refused.
* **copilot:** capture bounded final session nano-AIU metrics with versioned units and completeness; export USD usage value only for complete reported totals instead of treating premium-request multipliers as money. Preserve partial/error accounting and distinguish measured zero from unavailable telemetry.
* **grading:** retain a bounded, authoritative Copilot attempt ledger across rubric retries and judge fallbacks, including failures; exclude cached usage and reject incomplete or mixed-unit monetary totals without duplicating batched criterion spend.
* **accounting:** preserve empty-message execution failures, retain failure history after ledger overflow, and carry nested failed-attempt usage across bundled entrypoints without changing native-only throws or cancellation.
* **accounting:** retain bounded Copilot-history provenance across nested ledger overflow, including later permanent fallback failures and throwing rubric retries; verify failure evidence across mixed packed ESM/CJS entrypoints.
* **copilot:** accept Skill-loader evidence when Copilot CLI redacts secret-shaped prose such as `Bearer authentication` as `******`. Every visible character must still match the local `SKILL.md` body in order; each mask may hide only one non-empty single-line span of at most 256 characters, with at most 64 masks and at least 90% of the body visible.

* **workspace:** remove a half-made runtime root when initialization fails after creating it, so later runs no longer refuse it. Recovery now names an unmarked runtime root and says it is a leftover from an interrupted run that is safe to delete when no eval is running, instead of a bare `ENOENT` ([#95](https://github.com/allagentsdev/oh-my-promptfoo/issues/95)).
* **dependencies:** update the development Promptfoo peer to `0.124.1`, override get-uri's FTP client to patched `6.2.3`, and pin Forge's canonical RSA DigestInfo fix by immutable source commit. Add real-dependency rejection regressions to daily audits; document the Git audit coverage limit and intentional separate-host PASV restriction.
* **protocol:** on Windows, stopping a delegate for cancellation or timeout no longer terminates the runner before it reports; the abort frame requests shutdown and the runner is force-killed only after the shutdown grace, so captured Copilot accounting survives ([#128](https://github.com/allagentsdev/oh-my-promptfoo/issues/128)).

### Tests and documentation

* Verify Copilot transport failures retain measured tokens and premium-request multipliers without inventing monetary cost when session usage metrics are unavailable.
* Verify packed ESM/CJS assertion metadata remains extensible while retaining unknown native judge-attempt accounting without inventing monetary totals.
* Verify `skill-used` with tracing disabled for Claude, Codex, and Copilot, including failed skill loads and text-only claims. Document native skill metadata preservation and that no OpenTelemetry collector is required.
* Exercise the real Pi SDK with local model-service responses, including chunked streaming, bounded output, guarded directory and screenshot reads, credential errors, cancellation, skill evidence, and retained billing. Verify native Codex skill gates with two live SDK sessions, without tracing.
* Remove obsolete `@types/diff`; workspace file-change capture uses the declarations bundled with `diff@9`.

## [1.22.4](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.22.3...v1.22.4) (2026-10-24)


### Bug Fixes

* **workspace:** canonicalize Windows paths in the workspace reader ([#148](https://github.com/allagentsdev/oh-my-promptfoo/issues/148)) ([0f013e2](https://github.com/allagentsdev/oh-my-promptfoo/commit/0f013e20199364bded3990a352c2fb04d16c0957))

## [1.22.3](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.22.2...v1.22.3) (2026-10-24)


### Bug Fixes

* **tests:** make platform validation pass on macOS and Windows ([#142](https://github.com/allagentsdev/oh-my-promptfoo/issues/142)) ([d7d0cb2](https://github.com/allagentsdev/oh-my-promptfoo/commit/d7d0cb2b839b295ae1fe4bf442ca0c58e11123d1))

## [1.22.2](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.22.1...v1.22.2) (2026-10-24)


### Bug Fixes

* **providers:** use Copilot model limits and no default temperature in CopilotModel ([#141](https://github.com/allagentsdev/oh-my-promptfoo/issues/141)) ([94e8f5a](https://github.com/allagentsdev/oh-my-promptfoo/commit/94e8f5ab1ba600a748763d3b1c51930db86e48ec))
* **workspace:** capture file changes for large Git sources ([#144](https://github.com/allagentsdev/oh-my-promptfoo/issues/144)) ([daaf17e](https://github.com/allagentsdev/oh-my-promptfoo/commit/daaf17e63854b6a32e5c1131405b0b8f904189e6))
* **workspace:** never read hardlinked files during change capture ([#145](https://github.com/allagentsdev/oh-my-promptfoo/issues/145)) ([b1b0146](https://github.com/allagentsdev/oh-my-promptfoo/commit/b1b01464517134dd6de678a322d8083a07ebfeae))

## [1.22.1](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.22.0...v1.22.1) (2026-10-23)


### Bug Fixes

* **assertions:** keep judge cache-token details in llmAssert usage ([#138](https://github.com/allagentsdev/oh-my-promptfoo/issues/138)) ([1d8e2b0](https://github.com/allagentsdev/oh-my-promptfoo/commit/1d8e2b0ebb862ef31122e01f637f85c72b3ce179))

## [1.22.0](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.21.2...v1.22.0) (2026-10-23)


### Features

* **providers:** move every provider under ./providers without the Provider suffix ([#135](https://github.com/allagentsdev/oh-my-promptfoo/issues/135)) ([6247490](https://github.com/allagentsdev/oh-my-promptfoo/commit/6247490e98e25fe41caf079185a09455d47f4795))
* **providers:** route CopilotModel to each model's Copilot API ([#137](https://github.com/allagentsdev/oh-my-promptfoo/issues/137)) ([aea64fd](https://github.com/allagentsdev/oh-my-promptfoo/commit/aea64fd748593144f9dc42e34006cc772055f3d5))

## [1.21.2](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.21.1...v1.21.2) (2026-10-23)


### Bug Fixes

* **judge:** resolve judge providers from the eval's install, not the working directory ([#132](https://github.com/allagentsdev/oh-my-promptfoo/issues/132)) ([a79426d](https://github.com/allagentsdev/oh-my-promptfoo/commit/a79426dd7a6a4b53cb6c4111adbdff6ec017b103))

## [1.21.1](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.21.0...v1.21.1) (2026-10-23)


### Bug Fixes

* **protocol:** keep Copilot accounting when stopping runners on Windows ([#130](https://github.com/allagentsdev/oh-my-promptfoo/issues/130)) ([0604ec9](https://github.com/allagentsdev/oh-my-promptfoo/commit/0604ec912aa29748512a1a462e5a80f0a3edea62)), closes [#128](https://github.com/allagentsdev/oh-my-promptfoo/issues/128)

## [1.21.0](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.20.6...v1.21.0) (2026-10-23)


### Features

* **providers:** add Copilot Responses provider ([#127](https://github.com/allagentsdev/oh-my-promptfoo/issues/127)) ([bc28bb2](https://github.com/allagentsdev/oh-my-promptfoo/commit/bc28bb23a847b0f140baeb1462611934fcbf0cf1))

## [1.20.6](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.20.5...v1.20.6) (2026-10-23)


### Bug Fixes

* **copilot:** accept redacted Skill-loader content as bounded evidence ([#124](https://github.com/allagentsdev/oh-my-promptfoo/issues/124)) ([20776de](https://github.com/allagentsdev/oh-my-promptfoo/commit/20776dedb0b20c88b32908c294f0cbffbb9df9fc))

## [1.20.5](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.20.4...v1.20.5) (2026-10-23)


### Bug Fixes

* allow shared native rubric defaults ([#122](https://github.com/allagentsdev/oh-my-promptfoo/issues/122)) ([3700f9a](https://github.com/allagentsdev/oh-my-promptfoo/commit/3700f9af1f235ecb6f41b8e4e8b6cfefe5d9b071))

## [1.20.4](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.20.3...v1.20.4) (2026-10-23)


### Bug Fixes

* **copilot:** preserve session and judge usage accounting ([#116](https://github.com/allagentsdev/oh-my-promptfoo/issues/116)) ([752f9c6](https://github.com/allagentsdev/oh-my-promptfoo/commit/752f9c66b04ba53a1380b0af96b9c46e2f12134a))
* preserve nested accounting and remove obsolete diff types ([#121](https://github.com/allagentsdev/oh-my-promptfoo/issues/121)) ([3b183ce](https://github.com/allagentsdev/oh-my-promptfoo/commit/3b183ce5b62355378f1d73cbbd7cfe79d6672602))

## [1.20.3](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.20.2...v1.20.3) (2026-10-23)


### Bug Fixes

* **deps:** complete dependency upgrades and release safeguards ([#117](https://github.com/allagentsdev/oh-my-promptfoo/issues/117)) ([451a0e2](https://github.com/allagentsdev/oh-my-promptfoo/commit/451a0e2169baaf71371e470da2adc74dee768968))

## [1.20.2](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.20.1...v1.20.2) (2026-10-22)


### Bug Fixes

* **deps:** remediate audits and maintain bun dependencies ([#110](https://github.com/allagentsdev/oh-my-promptfoo/issues/110)) ([0f94061](https://github.com/allagentsdev/oh-my-promptfoo/commit/0f940614c4cfb256c4e864485902f1d120649ade))
* **deps:** resolve `ip-address` to `10.7.4` within existing ranges for [GHSA-rxp7-6hxx-x8q5](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5), retaining the reviewed FTP and Forge overrides ([#114](https://github.com/allagentsdev/oh-my-promptfoo/pull/114)).

## [1.20.1](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.20.0...v1.20.1) (2026-10-22)


### Bug Fixes

* **provider:** allow Promptfoo's native grader selection ([#108](https://github.com/allagentsdev/oh-my-promptfoo/issues/108)) ([99aba56](https://github.com/allagentsdev/oh-my-promptfoo/commit/99aba564f35344e7ae3063a4990a79b468811fb6))

## [1.20.0](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.19.0...v1.20.0) (2026-10-22)


### Features

* **assertions:** take a per-assertion llmAssert judge from config.provider ([#105](https://github.com/allagentsdev/oh-my-promptfoo/issues/105)) ([bc01b6e](https://github.com/allagentsdev/oh-my-promptfoo/commit/bc01b6eaea9ef2574a926b57f9eb1485dcbcae92))

## [1.19.0](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.18.0...v1.19.0) (2026-10-22)


### ⚠ BREAKING CHANGES

* **assertions:** llmAssert no longer reads OPENAI_MODEL, OPENAI_API_KEY or OPENAI_BASE_URL, and no longer rewrites an Azure resource root to /openai/v1 or sends an api-key header. Name the judge with defaultTest.options.provider, a test's options.provider or --grader (for example --grader openai:chat:<model>); Promptfoo's OpenAI provider reads OPENAI_API_KEY and OPENAI_BASE_URL as given, so Azure users set OPENAI_BASE_URL=https://<resource>.openai.azure.com/openai/v1. Judge outages are now FAIL rows with graderError instead of ERROR rows, so --retry-errors no longer re-runs them; use --filter-failing <evalId>.

### Features

* **assertions:** take llmAssert's judge from Promptfoo's grading provider ([#103](https://github.com/allagentsdev/oh-my-promptfoo/issues/103)) ([b56ca83](https://github.com/allagentsdev/oh-my-promptfoo/commit/b56ca83d8cf5ce419c88089a68e68ac136e74179))

## [1.18.0](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.17.0...v1.18.0) (2026-10-22)


### Features

* **assertions:** add per-component threshold to llmAssert and agentAssert ([#100](https://github.com/allagentsdev/oh-my-promptfoo/issues/100)) ([ac212bd](https://github.com/allagentsdev/oh-my-promptfoo/commit/ac212bd34fd1c994bb66f047f67f6260742e3fcb)), closes [#98](https://github.com/allagentsdev/oh-my-promptfoo/issues/98)

## [1.17.0](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.16.0...v1.17.0) (2026-10-22)


### Features

* **provider:** run skill-gated evaluations with Pi ([#90](https://github.com/allagentsdev/oh-my-promptfoo/issues/90)) ([536c1d2](https://github.com/allagentsdev/oh-my-promptfoo/commit/536c1d289a0ebfbb9a6034ae7f9f7e4c2d2f2b7b))


### Bug Fixes

* **assertions:** frame llmAssert's answer in &lt;Output&gt; like llm-rubric ([#96](https://github.com/allagentsdev/oh-my-promptfoo/issues/96)) ([84e1e40](https://github.com/allagentsdev/oh-my-promptfoo/commit/84e1e401118553bf2e5771f45ba5584ea33f005c)), closes [#93](https://github.com/allagentsdev/oh-my-promptfoo/issues/93)
* **workspace:** remove half-made runtime roots and name unmarked leftovers ([#97](https://github.com/allagentsdev/oh-my-promptfoo/issues/97)) ([f08e1e1](https://github.com/allagentsdev/oh-my-promptfoo/commit/f08e1e1831693ad136bf09f27b888a75a30f18fb))

## [1.16.0](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.15.0...v1.16.0) (2026-10-21)


### Features

* **assertions:** grade live workspaces with read-only agent delegates ([#80](https://github.com/allagentsdev/oh-my-promptfoo/issues/80)) ([8da0f0c](https://github.com/allagentsdev/oh-my-promptfoo/commit/8da0f0c245998dbc8ed9e29aaf3409981c0670ab)), closes [#76](https://github.com/allagentsdev/oh-my-promptfoo/issues/76)
* **assertions:** remove llmAssert candidate in favour of rubricPrompt ([#87](https://github.com/allagentsdev/oh-my-promptfoo/issues/87)) ([c0ae8c7](https://github.com/allagentsdev/oh-my-promptfoo/commit/c0ae8c74848f5b318ceb374ef82607082941b085))
* **provider:** resolve source paths against the eval config directory ([#88](https://github.com/allagentsdev/oh-my-promptfoo/issues/88)) ([92eaecb](https://github.com/allagentsdev/oh-my-promptfoo/commit/92eaecbe89ae5c46ff58934d6312502bb3c2e0d7)), closes [#86](https://github.com/allagentsdev/oh-my-promptfoo/issues/86)

## [1.15.0](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.14.0...v1.15.0) (2026-10-21)


### Features

* **provider:** rename fileChanges.generatedFiles to changedFiles ([#83](https://github.com/allagentsdev/oh-my-promptfoo/issues/83)) ([5fd0c83](https://github.com/allagentsdev/oh-my-promptfoo/commit/5fd0c8342c05c6508efc18b2893b26047c2dddb3))

## [1.14.0](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.13.0...v1.14.0) (2026-10-21)


### Features

* **assertions:** match llm-rubric template features ([#79](https://github.com/allagentsdev/oh-my-promptfoo/issues/79)) ([98f25f7](https://github.com/allagentsdev/oh-my-promptfoo/commit/98f25f7370246c675ce2b9503819fa40a0eef5dc)), closes [#78](https://github.com/allagentsdev/oh-my-promptfoo/issues/78)
* **assertions:** tighten the llmAssert grader prompt and treat claimed edits, builds and tests as unverified ([#81](https://github.com/allagentsdev/oh-my-promptfoo/issues/81)) ([0fe9463](https://github.com/allagentsdev/oh-my-promptfoo/commit/0fe946382d411ade2c35ea41ac348f064cc44ea8))

## [1.13.0](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.12.0...v1.13.0) (2026-10-21)


### Features

* **assertions:** take llmAssert suite instructions as rubricPrompt and render test variables ([#75](https://github.com/allagentsdev/oh-my-promptfoo/issues/75)) ([6d9acef](https://github.com/allagentsdev/oh-my-promptfoo/commit/6d9acefa323da1200e11322b540242ee46d2add6))

## [1.12.0](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.11.0...v1.12.0) (2026-10-21)


### Features

* **workspace:** let local sources share a destination ([#72](https://github.com/allagentsdev/oh-my-promptfoo/issues/72)) ([536976c](https://github.com/allagentsdev/oh-my-promptfoo/commit/536976cb2b63dad9a5313378975d056ea66298e2))

## [1.11.0](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.10.0...v1.11.0) (2026-10-21)


### Features

* **assertions:** add a binary scoring mode to llmAssert ([#69](https://github.com/allagentsdev/oh-my-promptfoo/issues/69)) ([0487ee3](https://github.com/allagentsdev/oh-my-promptfoo/commit/0487ee39211a86599e19b8236eebcac18cd24e74))

## [1.10.0](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.9.1...v1.10.0) (2026-10-16)


### Features

* **assertions:** report grader token usage from llmAssert ([#67](https://github.com/allagentsdev/oh-my-promptfoo/issues/67)) ([f3ba075](https://github.com/allagentsdev/oh-my-promptfoo/commit/f3ba075c73f56f0690cdcbc01b21fe47a4853f4f))

## [1.9.1](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.9.0...v1.9.1) (2026-10-07)


### Bug Fixes

* **assertions:** require judge pass and score floor for each rubric ([#65](https://github.com/allagentsdev/oh-my-promptfoo/issues/65)) ([e6f5428](https://github.com/allagentsdev/oh-my-promptfoo/commit/e6f5428a70c1b94307177e33d5fdb47480e89340))

## [1.9.0](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.8.0...v1.9.0) (2026-10-07)


### Features

* **workspace:** stage trusted local sources and upgrade Copilot SDK ([#63](https://github.com/allagentsdev/oh-my-promptfoo/issues/63)) ([caf4fb9](https://github.com/allagentsdev/oh-my-promptfoo/commit/caf4fb9cbdafe8d7b64e9c3da8ae2ae718b9e158))

## [1.8.0](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.7.2...v1.8.0) (2026-10-07)


### Features

* **provider:** configure workspace preparation timeout independently ([#60](https://github.com/allagentsdev/oh-my-promptfoo/issues/60)) ([fa2642b](https://github.com/allagentsdev/oh-my-promptfoo/commit/fa2642bb17acf4c880c31fb9b71add7cd9d88cca))

**Breaking configuration change:** `workspace.limits.timeoutMs` is rejected.
Move it to `config.workspaceTimeoutMs` or set
`ALLAGENTS_WORKSPACE_TIMEOUT_MS`. `config.timeoutMs` still limits the agent call.

## [1.7.2](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.7.1...v1.7.2) (2026-10-07)


### Bug Fixes

* **promptfoo:** support 0.124 alongside 0.122 ([#58](https://github.com/allagentsdev/oh-my-promptfoo/issues/58)) ([cd1a4ee](https://github.com/allagentsdev/oh-my-promptfoo/commit/cd1a4ee6c1bb33a7ac1cb74ae094a4f1bf8085fa))

## [1.7.1](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.7.0...v1.7.1) (2026-10-06)


### Bug Fixes

* **copilot:** load and attest scoped workspace skills ([#56](https://github.com/allagentsdev/oh-my-promptfoo/issues/56)) ([a3f7298](https://github.com/allagentsdev/oh-my-promptfoo/commit/a3f72984a632ed8646105a29e9ea6659e24ada63))

## [1.7.0](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.6.0...v1.7.0) (2026-10-06)


### Features

* **assertions:** publish batched rubric grader ([#54](https://github.com/allagentsdev/oh-my-promptfoo/issues/54)) ([f70a48a](https://github.com/allagentsdev/oh-my-promptfoo/commit/f70a48ad8d3ab4a4b09a4506aa8f36186dc5fa68))

## 1.6.0 (2026-10-03)

- Publish the package as `oh-my-promptfoo`.
- Preserve provider behavior and existing workspace cache ownership markers.

## [1.5.2](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.5.1...v1.5.2) (2026-10-02)


### Performance Improvements

* verify independent protected sources in parallel ([#47](https://github.com/allagentsdev/oh-my-promptfoo/issues/47)) ([6db1694](https://github.com/allagentsdev/oh-my-promptfoo/commit/6db169430ea82e756aa5df1eb05d758d685803a0))

## [1.5.1](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.5.0...v1.5.1) (2026-10-02)


### Performance Improvements

* measure protected Git and stamp checks by ordinal ([#45](https://github.com/allagentsdev/oh-my-promptfoo/issues/45)) ([b35e060](https://github.com/allagentsdev/oh-my-promptfoo/commit/b35e06062240e286945ea0e8ec10d60cdfeadb1e))

## 1.5.0 (2026-10-02)

- Publish the package under the intermediate scoped name.
- Expose the workspace provider through its `:default` Promptfoo export.
- Keep existing cache ownership markers compatible with earlier installations.

## [1.4.2](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.4.1...v1.4.2) (2026-10-02)

### Bug Fixes

* expose workspace case ordinal for graded rows ([#40](https://github.com/allagentsdev/oh-my-promptfoo/issues/40)) ([d73ce95](https://github.com/allagentsdev/oh-my-promptfoo/commit/d73ce958069508c46812ea03080aaec6d140faba))

## [1.4.1](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.4.0...v1.4.1) (2026-10-01)


### Performance Improvements

* parallelize protected tree stamp metadata reads ([#38](https://github.com/allagentsdev/oh-my-promptfoo/issues/38)) ([ef83c71](https://github.com/allagentsdev/oh-my-promptfoo/commit/ef83c71e58280d5171bee30e12c5f8e59a504c3d))

## [1.4.0](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.3.4...v1.4.0) (2026-10-01)


### Features

* consume trusted pinned Git views without rebuilding seed ([#36](https://github.com/allagentsdev/oh-my-promptfoo/issues/36)) ([35d4210](https://github.com/allagentsdev/oh-my-promptfoo/commit/35d42104344e8fa3f272ccf9e5ca9b4f8fd9297c))

## [1.3.4](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.3.3...v1.3.4) (2026-10-01)


### Performance Improvements

* avoid repeated full-cache admission walks ([#34](https://github.com/allagentsdev/oh-my-promptfoo/issues/34)) ([fc066f2](https://github.com/allagentsdev/oh-my-promptfoo/commit/fc066f20234ecdefd1e4a41900a017e25d587bf3))

## [1.3.3](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.3.2...v1.3.3) (2026-10-01)


### Performance Improvements

* measure protected checkout preparation phases ([#32](https://github.com/allagentsdev/oh-my-promptfoo/issues/32)) ([401062b](https://github.com/allagentsdev/oh-my-promptfoo/commit/401062b2a17a5bfed0c49d6de802beea8a0d17f9))

## [1.3.2](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.3.1...v1.3.2) (2026-10-01)


### Performance Improvements

* fetch only pinned HTTPS Git commit ([#30](https://github.com/allagentsdev/oh-my-promptfoo/issues/30)) ([48ce619](https://github.com/allagentsdev/oh-my-promptfoo/commit/48ce619f1c158bb5270700d2b9f0799880241033))

## [1.3.1](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.3.0...v1.3.1) (2026-10-01)


### Bug Fixes

* verify protected checkout after agent completion ([#28](https://github.com/allagentsdev/oh-my-promptfoo/issues/28)) ([e331589](https://github.com/allagentsdev/oh-my-promptfoo/commit/e331589466618652d11197e612f612551cf76ced))

## [1.3.0](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.2.1...v1.3.0) (2026-10-01)


### Features

* emit privacy-safe workspace eval progress milestones ([#26](https://github.com/allagentsdev/oh-my-promptfoo/issues/26)) ([1588641](https://github.com/allagentsdev/oh-my-promptfoo/commit/1588641349cab57c595c6c3711c66cc0a33375a1))

## [1.2.1](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.2.0...v1.2.1) (2026-10-01)


### Bug Fixes

* **workspace:** reuse bounded tmpfs across Git sources ([#24](https://github.com/allagentsdev/oh-my-promptfoo/issues/24)) ([da1faa1](https://github.com/allagentsdev/oh-my-promptfoo/commit/da1faa1242246d09d843c7fcee91189a67116b53))

## [1.2.0](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.1.0...v1.2.0) (2026-10-01)


### Features

* **workspace:** remove OverlayFS and add copy-only mode ([#22](https://github.com/allagentsdev/oh-my-promptfoo/issues/22)) ([fc1f8e0](https://github.com/allagentsdev/oh-my-promptfoo/commit/fc1f8e0c36e3e8ef815d763da6fffac94294fb0f))

Linux workspaces no longer mount OverlayFS. The default tries unprivileged
reflinks, then admits a full copy only when disk space suffices; a large
writable workspace that previously required OverlayFS may now fail admission.
`copy-only` always uses independent copies and may increase peak disk use.

## [1.1.0](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.0.1...v1.1.0) (2026-09-30)


### Features

* **copilot:** report observed skill reads to Promptfoo ([#19](https://github.com/allagentsdev/oh-my-promptfoo/issues/19)) ([a4e6f90](https://github.com/allagentsdev/oh-my-promptfoo/commit/a4e6f9095233ada25f103c90d359311e39ab72d5))


### Bug Fixes

* support native Windows workspace isolation ([#17](https://github.com/allagentsdev/oh-my-promptfoo/issues/17)) ([3d18b5d](https://github.com/allagentsdev/oh-my-promptfoo/commit/3d18b5dc8824690a9f2d3913b4311a2cb9494ca0))
* **workspace:** preserve Git modes with restrictive umask ([#18](https://github.com/allagentsdev/oh-my-promptfoo/issues/18)) ([2e507af](https://github.com/allagentsdev/oh-my-promptfoo/commit/2e507af2aabeff81c763ba5378562eaefc0774fd))

## [1.0.1](https://github.com/allagentsdev/oh-my-promptfoo/compare/v1.0.0...v1.0.1) (2026-09-30)


### Bug Fixes

* resolve new Release Please PR before list indexing ([#14](https://github.com/allagentsdev/oh-my-promptfoo/issues/14)) ([52822fc](https://github.com/allagentsdev/oh-my-promptfoo/commit/52822fc0990145461cc311a8c4201b1475e024cd))
* wait for npm registry indexing after publication ([#12](https://github.com/allagentsdev/oh-my-promptfoo/issues/12)) ([98fa55a](https://github.com/allagentsdev/oh-my-promptfoo/commit/98fa55ac1d511df5e4e5bdce1fae721e0f14676d))
