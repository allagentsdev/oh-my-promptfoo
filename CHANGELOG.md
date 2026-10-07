# Changelog

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
