# ADR 0010: Resolve Provider file paths against the eval config

- Status: Accepted
- Date: 2026-10-22
- Supersedes: the absolute `type: local` `path` requirement and the mandatory `ALLAGENTS_LOCAL_SOURCE_ROOT` previously documented in the provider guide

## Context

Promptfoo resolves `file://prompts/x.txt`, `file://graders/x.mjs` and `providers: file://providers.yaml` against the eval config's directory. The workspace `Provider` did not. A `type: local` source `path` had to be absolute, and acquisition also required the runner to set `ALLAGENTS_LOCAL_SOURCE_ROOT`. Consumers worked around this with `path: '{{env.EVAL_SUITE_DIR}}/../../plugins/x/skills'` and a wrapper script that set both variables. The maintainer's rule is that oh-my-promptfoo file references behave the same way as the rest of Promptfoo. A Promptfoo config is already trusted code: it can run any `file://*.js` provider or assertion.

The rule depends on which directory Promptfoo's loader passes as `config.basePath`, and on whether a provider included from a separate file sees a different one.

## Observed loader behaviour

We checked both supported peers with a throwaway project outside this repository. It used stock `promptfoo@0.122.0` and `promptfoo@0.124.0` installed with npm, and a `package:probe-provider:Probe` provider that returned its `config.basePath` and a `payload: file://data.txt` config value. `data.txt` existed in both the config directory (`SUITE-DIR`) and the included file's `sub/` directory (`SUB-DIR`). The CLI ran from `/tmp/omp86` with `--config probe/pf-<version>/suite/<name>.yaml`, so its working directory was not the config's directory.

| Promptfoo | Provider declared | `config.basePath` received | `payload: file://data.txt` received |
| --- | --- | --- | --- |
| 0.122.0 | inline in the eval config | `probe/pf-0.122.0/suite`: the config directory, relative to the CLI cwd | `file://data.txt`, unchanged |
| 0.122.0 | `providers: file://sub/providers.yaml`, as a string or a list item | `probe/pf-0.122.0/suite`: the config directory, not `sub/` | `SUITE-DIR` |
| 0.124.0 | inline in the eval config | `/tmp/omp86/probe/pf-0.124.0/suite`: the config directory, absolute | `file://data.txt`, unchanged |
| 0.124.0 | `providers: file://sub/providers.yaml`, as a string or a list item | `/tmp/omp86/probe/pf-0.124.0/suite`: the config directory, not `sub/` | `SUITE-DIR` |

The sources agree:

- 0.122.0 sets `basePath = path.dirname(configPaths[0])` ([`util/config/load.ts#L817`](https://github.com/promptfoo/promptfoo/blob/0.122.0/src/util/config/load.ts#L817)), so it is relative when the config path is. `loadApiProvider` writes `config: { ...renderedConfig, basePath }`, so the loader value replaces any authored `config.basePath` ([`providers/index.ts#L83-L108`](https://github.com/promptfoo/promptfoo/blob/0.122.0/src/providers/index.ts#L83-L108)).
- 0.124.0 sets `basePath = path.resolve(fileConfig.basePath ?? defaultConfig.basePath ?? path.dirname(configPaths[0]))` ([`util/config/load.ts#L1014-L1018`](https://github.com/promptfoo/promptfoo/blob/0.124.0/src/util/config/load.ts#L1014-L1018)). `loadApiProvider` writes `config: { ...(basePath !== undefined && { basePath }), ...renderedConfig }`, so an authored `config.basePath` wins ([`providers/index.ts#L86-L128`](https://github.com/promptfoo/promptfoo/blob/0.124.0/src/providers/index.ts#L86-L128)).
- In both versions, `readProviderConfigFile` reads the included file and passes its content through `maybeLoadConfigFromExternalFile` ([0.122.0](https://github.com/promptfoo/promptfoo/blob/0.122.0/src/util/providerRef.ts#L139-L156), [0.124.0](https://github.com/promptfoo/promptfoo/blob/0.124.0/src/util/providerRef.ts#L139-L156)). That resolves each `file://` string against `cliState.basePath`, which is the eval config directory ([0.122.0](https://github.com/promptfoo/promptfoo/blob/0.122.0/src/util/file.ts#L130), [0.124.0](https://github.com/promptfoo/promptfoo/blob/0.124.0/src/util/file.ts#L182)). The included providers are then loaded with the same `basePath` ([0.122.0](https://github.com/promptfoo/promptfoo/blob/0.122.0/src/providers/index.ts#L165-L192), [0.124.0](https://github.com/promptfoo/promptfoo/blob/0.124.0/src/providers/index.ts#L186-L221)).

So the two cases do not differ. Promptfoo's own rule for an included provider file is that relative references resolve against the eval config's directory, not the included file's directory, and the loader `basePath` is that directory in both versions.

One further observation affects `file://` Git URLs. Promptfoo dereferences every `file://` string in an included provider file while loading the config. A value that names a directory, which a Git repository always does, fails on both versions with `EISDIR` before the provider is constructed. Inline provider configs are not dereferenced.

## Decision

1. Relative path-like Provider fields resolve against the loader `basePath`. When that value is relative, as on 0.122, it is resolved against the process working directory, which is the directory it was computed from. Without a loader value, the base is the process working directory, the same fallback already used to find peer packages. This gives the same answer as Promptfoo for both inline and included provider files.
2. The resolved fields are `type: local` `path` and a `type: git` `repository` written as `file://` followed by a relative path. Following Promptfoo's `file://` convention, everything after the scheme is a path. Absolute local paths, `file:///absolute` and `file://localhost/absolute` URLs are unchanged. We checked the other fields and changed none of them:
   - `workingDir` stays relative to the prepared workspace. It selects a materialized directory that exists only after acquisition.
   - OCI `repository` is a registry reference, and HTTPS Git URLs are not paths.
   - Delegate configs accept no path fields; delegate working directories are rejected.
   - `CopilotSdkProvider` `working_dir` has resolved relative values against the loader `basePath` since the first release. Its contract does not change; the documentation used to say only "use an absolute path" and now describes the existing behaviour.
3. `ALLAGENTS_LOCAL_SOURCE_ROOT` becomes optional. When it is unset, the containment boundary is the root of the Git repository containing the base: the nearest ancestor with a `.git` entry, which is a file in linked worktrees and submodules. Outside any repository, the boundary is the base itself. When the variable is set, it must be absolute and replaces the default rather than intersecting with it. Shared runners use it to narrow the boundary, and runners that already set a root outside the config's repository keep working.
4. Every existing check still applies to the resolved path and boundary: `..` is normalised before the containment check, Git metadata cannot be selected, symlink ancestors of the boundary and source are rejected, traversal stays descriptor-anchored, and symlinks, special files, hard links and byte budgets are enforced.

## Consequences

- Configs can write `path: ../plugins/x/skills` beside the rest of their `file://` references, and the wrapper scripts and `EVAL_SUITE_DIR` templates are no longer needed. Absolute paths and an explicit `ALLAGENTS_LOCAL_SOURCE_ROOT` behave as before.
- Without the variable, a config can read only local directories inside the repository it ships in, or inside its own directory when it is not in a repository. That is no wider than the trust Promptfoo already gives the config.
- Promptfoo computes `basePath` lexically, without `realpath`. A config reached through a symlinked directory therefore fails the symlink-ancestor check. This is the existing rule for `ALLAGENTS_LOCAL_SOURCE_ROOT`; address the config by its physical path.
- Sources are resolved to absolute paths before workspace validation, so a relative and an absolute spelling of one directory share cache identity and response metadata.
- `file://` Git repositories work in inline provider configs only. In an included provider file, Promptfoo's config loader fails on them before oh-my-promptfoo runs, on both supported versions. This is upstream behaviour, and oh-my-promptfoo cannot change it.
- On 0.124, an authored `config.basePath` overrides the loader's value and so moves the base and the default boundary. On 0.122, the loader overwrites it. Both follow Promptfoo's own precedence.
