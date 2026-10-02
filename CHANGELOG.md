# Changelog

## 1.5.0 (2026-10-02)

- Publish the package under the new `@allagents/promptfoo-x` name.
- Expose the workspace provider as `package:@allagents/promptfoo-x:default`.
- Keep existing cache ownership markers compatible with earlier installations.

## [1.4.2](https://github.com/allagentsdev/promptfoo-x/compare/v1.4.1...v1.4.2) (2026-10-02)

### Bug Fixes

* expose workspace case ordinal for graded rows ([#40](https://github.com/allagentsdev/promptfoo-x/issues/40)) ([d73ce95](https://github.com/allagentsdev/promptfoo-x/commit/d73ce958069508c46812ea03080aaec6d140faba))

## [1.4.1](https://github.com/allagentsdev/promptfoo-x/compare/v1.4.0...v1.4.1) (2026-10-01)


### Performance Improvements

* parallelize protected tree stamp metadata reads ([#38](https://github.com/allagentsdev/promptfoo-x/issues/38)) ([ef83c71](https://github.com/allagentsdev/promptfoo-x/commit/ef83c71e58280d5171bee30e12c5f8e59a504c3d))

## [1.4.0](https://github.com/allagentsdev/promptfoo-x/compare/v1.3.4...v1.4.0) (2026-10-01)


### Features

* consume trusted pinned Git views without rebuilding seed ([#36](https://github.com/allagentsdev/promptfoo-x/issues/36)) ([35d4210](https://github.com/allagentsdev/promptfoo-x/commit/35d42104344e8fa3f272ccf9e5ca9b4f8fd9297c))

## [1.3.4](https://github.com/allagentsdev/promptfoo-x/compare/v1.3.3...v1.3.4) (2026-10-01)


### Performance Improvements

* avoid repeated full-cache admission walks ([#34](https://github.com/allagentsdev/promptfoo-x/issues/34)) ([fc066f2](https://github.com/allagentsdev/promptfoo-x/commit/fc066f20234ecdefd1e4a41900a017e25d587bf3))

## [1.3.3](https://github.com/allagentsdev/promptfoo-x/compare/v1.3.2...v1.3.3) (2026-10-01)


### Performance Improvements

* measure protected checkout preparation phases ([#32](https://github.com/allagentsdev/promptfoo-x/issues/32)) ([401062b](https://github.com/allagentsdev/promptfoo-x/commit/401062b2a17a5bfed0c49d6de802beea8a0d17f9))

## [1.3.2](https://github.com/allagentsdev/promptfoo-x/compare/v1.3.1...v1.3.2) (2026-10-01)


### Performance Improvements

* fetch only pinned HTTPS Git commit ([#30](https://github.com/allagentsdev/promptfoo-x/issues/30)) ([48ce619](https://github.com/allagentsdev/promptfoo-x/commit/48ce619f1c158bb5270700d2b9f0799880241033))

## [1.3.1](https://github.com/allagentsdev/promptfoo-x/compare/v1.3.0...v1.3.1) (2026-10-01)


### Bug Fixes

* verify protected checkout after agent completion ([#28](https://github.com/allagentsdev/promptfoo-x/issues/28)) ([e331589](https://github.com/allagentsdev/promptfoo-x/commit/e331589466618652d11197e612f612551cf76ced))

## [1.3.0](https://github.com/allagentsdev/promptfoo-x/compare/v1.2.1...v1.3.0) (2026-10-01)


### Features

* emit privacy-safe workspace eval progress milestones ([#26](https://github.com/allagentsdev/promptfoo-x/issues/26)) ([1588641](https://github.com/allagentsdev/promptfoo-x/commit/1588641349cab57c595c6c3711c66cc0a33375a1))

## [1.2.1](https://github.com/allagentsdev/promptfoo-x/compare/v1.2.0...v1.2.1) (2026-10-01)


### Bug Fixes

* **workspace:** reuse bounded tmpfs across Git sources ([#24](https://github.com/allagentsdev/promptfoo-x/issues/24)) ([da1faa1](https://github.com/allagentsdev/promptfoo-x/commit/da1faa1242246d09d843c7fcee91189a67116b53))

## [1.2.0](https://github.com/allagentsdev/promptfoo-x/compare/v1.1.0...v1.2.0) (2026-10-01)


### Features

* **workspace:** remove OverlayFS and add copy-only mode ([#22](https://github.com/allagentsdev/promptfoo-x/issues/22)) ([fc1f8e0](https://github.com/allagentsdev/promptfoo-x/commit/fc1f8e0c36e3e8ef815d763da6fffac94294fb0f))

Linux workspaces no longer mount OverlayFS. The default tries unprivileged
reflinks, then admits a full copy only when disk space suffices; a large
writable workspace that previously required OverlayFS may now fail admission.
`copy-only` always uses independent copies and may increase peak disk use.

## [1.1.0](https://github.com/allagentsdev/promptfoo-x/compare/v1.0.1...v1.1.0) (2026-09-30)


### Features

* **copilot:** report observed skill reads to Promptfoo ([#19](https://github.com/allagentsdev/promptfoo-x/issues/19)) ([a4e6f90](https://github.com/allagentsdev/promptfoo-x/commit/a4e6f9095233ada25f103c90d359311e39ab72d5))


### Bug Fixes

* support native Windows workspace isolation ([#17](https://github.com/allagentsdev/promptfoo-x/issues/17)) ([3d18b5d](https://github.com/allagentsdev/promptfoo-x/commit/3d18b5dc8824690a9f2d3913b4311a2cb9494ca0))
* **workspace:** preserve Git modes with restrictive umask ([#18](https://github.com/allagentsdev/promptfoo-x/issues/18)) ([2e507af](https://github.com/allagentsdev/promptfoo-x/commit/2e507af2aabeff81c763ba5378562eaefc0774fd))

## [1.0.1](https://github.com/allagentsdev/promptfoo-x/compare/v1.0.0...v1.0.1) (2026-09-30)


### Bug Fixes

* resolve new Release Please PR before list indexing ([#14](https://github.com/allagentsdev/promptfoo-x/issues/14)) ([52822fc](https://github.com/allagentsdev/promptfoo-x/commit/52822fc0990145461cc311a8c4201b1475e024cd))
* wait for npm registry indexing after publication ([#12](https://github.com/allagentsdev/promptfoo-x/issues/12)) ([98fa55a](https://github.com/allagentsdev/promptfoo-x/commit/98fa55ac1d511df5e4e5bdce1fae721e0f14676d))
