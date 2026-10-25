# ADR 0014: Pass native delegate config through to Promptfoo

- Status: Accepted
- Date: 2026-10-25
- Supersedes: the Codex/Claude candidate field-allowlist part of [ADR 0001](0001-publish-workspace-owning-agent-providers.md)

## Context

The workspace `Agent` delegates Codex and Claude calls to the consumer's stock Promptfoo providers through `loadApiProvider`. Its closed `delegate.config` lists duplicate native configuration validation and prevent suites from using stock options until this package adds each one. Promptfoo's Codex provider already strictly validates top-level configuration.

Copilot and Pi are different: this package runs their runtime code, so its own schemas define the supported options. Read-only `agentAssert` graders also require a closed schema so native options cannot override their forced permissions or instruction isolation.

## Decision

For candidate `openai:codex-sdk` and `anthropic:claude-agent-sdk` delegates, pass `delegate.config` to Promptfoo without filtering, rewriting or validating native option values. Promptfoo owns native validation. This applies equally to provider configuration and the merged prompt-level `delegate.config` override. Authors and configuration are trusted: allow `cli_config`, `additional_directories`, `codex_path_override`, plugins, settings and settings discovery.

Reject only the native keys that conflict with wrapper ownership:

| Delegate | Workspace | Per-row session isolation | CLI environment |
| --- | --- | --- | --- |
| Codex | `working_dir`, `copy_working_dir`, `skip_git_repo_check` | `thread_id`, `persist_threads`, `thread_pool_size` | `inherit_process_env`, `cli_env` |
| Claude | `working_dir` | `resume`, `fork_session`, `resume_session_at`, `continue`, `session_id`, `persist_session` | `env` |

These Claude keys come from Promptfoo 0.124.1's Claude Agent SDK provider configuration and its SDK option mapping. It accepts `working_dir` (mapped to SDK `cwd`), the session keys above, and `env`; it has no separate process-environment inheritance option. The native provider inherits the already-minimal runner environment, not the host's unrestricted environment.

The same ownership rule applies to Claude `extra_args`, which Promptfoo passes to the SDK's CLI flags. Reject session flags `resume`/`r`, `continue`/`c`, `fork-session`, `session-id`, `resume-session-at`, `resume-drops-turn`, `no-session-persistence`, `from-pr`, `teleport` and `cloud`. Also reject `worktree`/`w`, which changes the execution workspace. Match flag names case-insensitively after removing leading dashes and any `=value` suffix; errors retain the authored key. These names and aliases are documented by the installed Claude Code 2.1.283 `--help` and the Claude SDK argument mapping. `add-dir` remains allowed, like top-level `additional_directories`; other native flags pass through.

Codex has no corresponding nested session route in this integration: Promptfoo passes `cli_config` as the SDK's structured TOML configuration overrides, while its separate thread-selection code calls `resumeThread` only for top-level `thread_id`. Codex CLI `exec resume` and `exec fork` are subcommands, not TOML configuration keys. Do not add speculative `cli_config` restrictions.

Errors identify the authored key and explain the provider's ownership. Use provider-level `workingDir` for a contained working directory and `delegate.env` for CLI environment values. The existing environment validator rejects reserved `ALLAGENTS_*` names case-insensitively.

Keep structural validation needed by the runner: a plain config object, contained stdio `mcpServers` via `validateMcpServers`, and Claude `tools` and `claudeMcpOptions` handling. The runner still sets `working_dir` last, sets Codex `skip_git_repo_check` and explicit `cli_env` last, forces fresh execution and rejects cached responses. Existing constructor-only timeout handling is unchanged.

Keep today's explicit closed Codex and Claude lists for graders, separately selected by `graderConfig`; the candidate validation path cannot widen them. In particular graders reject `cli_config`, `sandbox_workspace_write`, `additional_directories`, `codex_path_override`, plugins and settings discovery. Copilot and Pi closed lists are unchanged.

## Consequences

- Suites can use new stock Promptfoo native options without a package release adding a duplicate allowlist entry.
- Invalid native options are diagnosed by the consumer's Promptfoo version, not by a second wrapper schema. New native ownership-conflicting options may require additions to the small deny lists.
- Trusted configuration can widen native capabilities through CLI config, plugins, settings or additional directories. Candidate passthrough is not a security boundary against suite authors.
- The wrapper retains per-row workspace/session ownership and the explicit environment channel. Grader read-only guarantees do not depend on the candidate deny list.

## Alternatives rejected

- **Grow the candidate allowlists.** This retains duplicate schemas and repeated delays whenever Promptfoo adds native options.
- **Open every delegate and grader schema.** Copilot/Pi need schemas for code this package owns, and grader passthrough could weaken forced read-only policy.
- **Deny executable overrides, discovery or arbitrary native CLI settings.** These are trusted author choices, not provider-owned state.
