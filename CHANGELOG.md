# Changelog

## [1.3.3](https://github.com/allagentsdev/promptfoo-integration/compare/v1.3.2...v1.3.3) (2026-10-01)


### Performance Improvements

* measure protected checkout preparation phases ([#32](https://github.com/allagentsdev/promptfoo-integration/issues/32)) ([401062b](https://github.com/allagentsdev/promptfoo-integration/commit/401062b2a17a5bfed0c49d6de802beea8a0d17f9))

## [1.3.2](https://github.com/allagentsdev/promptfoo-integration/compare/v1.3.1...v1.3.2) (2026-10-01)


### Performance Improvements

* fetch only pinned HTTPS Git commit ([#30](https://github.com/allagentsdev/promptfoo-integration/issues/30)) ([48ce619](https://github.com/allagentsdev/promptfoo-integration/commit/48ce619f1c158bb5270700d2b9f0799880241033))

## [1.3.1](https://github.com/allagentsdev/promptfoo-integration/compare/v1.3.0...v1.3.1) (2026-10-01)


### Bug Fixes

* verify protected checkout after agent completion ([#28](https://github.com/allagentsdev/promptfoo-integration/issues/28)) ([e331589](https://github.com/allagentsdev/promptfoo-integration/commit/e331589466618652d11197e612f612551cf76ced))

## [1.3.0](https://github.com/allagentsdev/promptfoo-integration/compare/v1.2.1...v1.3.0) (2026-10-01)


### Features

* emit privacy-safe workspace eval progress milestones ([#26](https://github.com/allagentsdev/promptfoo-integration/issues/26)) ([1588641](https://github.com/allagentsdev/promptfoo-integration/commit/1588641349cab57c595c6c3711c66cc0a33375a1))

## [1.2.1](https://github.com/allagentsdev/promptfoo-integration/compare/v1.2.0...v1.2.1) (2026-10-01)


### Bug Fixes

* **workspace:** reuse bounded tmpfs across Git sources ([#24](https://github.com/allagentsdev/promptfoo-integration/issues/24)) ([da1faa1](https://github.com/allagentsdev/promptfoo-integration/commit/da1faa1242246d09d843c7fcee91189a67116b53))

## [1.2.0](https://github.com/allagentsdev/promptfoo-integration/compare/v1.1.0...v1.2.0) (2026-10-01)


### Features

* **workspace:** remove OverlayFS and add copy-only mode ([#22](https://github.com/allagentsdev/promptfoo-integration/issues/22)) ([fc1f8e0](https://github.com/allagentsdev/promptfoo-integration/commit/fc1f8e0c36e3e8ef815d763da6fffac94294fb0f))

Linux workspaces no longer mount OverlayFS. The default tries unprivileged
reflinks, then admits a full copy only when disk space suffices; a large
writable workspace that previously required OverlayFS may now fail admission.
`copy-only` always uses independent copies and may increase peak disk use.

## [1.1.0](https://github.com/allagentsdev/promptfoo-integration/compare/v1.0.1...v1.1.0) (2026-09-30)


### Features

* **copilot:** report observed skill reads to Promptfoo ([#19](https://github.com/allagentsdev/promptfoo-integration/issues/19)) ([a4e6f90](https://github.com/allagentsdev/promptfoo-integration/commit/a4e6f9095233ada25f103c90d359311e39ab72d5))


### Bug Fixes

* support native Windows workspace isolation ([#17](https://github.com/allagentsdev/promptfoo-integration/issues/17)) ([3d18b5d](https://github.com/allagentsdev/promptfoo-integration/commit/3d18b5dc8824690a9f2d3913b4311a2cb9494ca0))
* **workspace:** preserve Git modes with restrictive umask ([#18](https://github.com/allagentsdev/promptfoo-integration/issues/18)) ([2e507af](https://github.com/allagentsdev/promptfoo-integration/commit/2e507af2aabeff81c763ba5378562eaefc0774fd))

## [1.0.1](https://github.com/allagentsdev/promptfoo-integration/compare/v1.0.0...v1.0.1) (2026-09-30)


### Bug Fixes

* resolve new Release Please PR before list indexing ([#14](https://github.com/allagentsdev/promptfoo-integration/issues/14)) ([52822fc](https://github.com/allagentsdev/promptfoo-integration/commit/52822fc0990145461cc311a8c4201b1475e024cd))
* wait for npm registry indexing after publication ([#12](https://github.com/allagentsdev/promptfoo-integration/issues/12)) ([98fa55a](https://github.com/allagentsdev/promptfoo-integration/commit/98fa55ac1d511df5e4e5bdce1fae721e0f14676d))
