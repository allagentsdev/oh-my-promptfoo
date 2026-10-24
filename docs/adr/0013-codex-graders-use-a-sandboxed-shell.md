# ADR 0013: Codex graders use Promptfoo's read-only Codex sandbox

- Status: Accepted
- Date: 2026-10-25
- Supersedes: for Codex graders, the reader paragraph and the Codex instruction-isolation settings of [ADR 0008](0008-agent-assert-workspace-grading.md)
- Resolves: [#149](https://github.com/allagentsdev/oh-my-promptfoo/issues/149) as obsolete

## Context

[ADR 0008](0008-agent-assert-workspace-grading.md) disabled the Codex grader's shell and gave it a bundled stdio MCP server, `workspace-reader`, with bounded `read_file` and `list_directory` tools that refused paths outside the workspace and declared protected sources. Codex normally reads files through shell commands, so the reader was its only way to inspect evidence.

The reader is our own path-containment code. [#149](https://github.com/allagentsdev/oh-my-promptfoo/issues/149) found a race in it: it checks a `realpath` and then opens the path, and `O_NOFOLLOW` covers only the last component, so a parent directory swapped for a symlink between the two steps redirects the read. Closing that needs component-by-component opens that Node does not offer, or a native helper. The reader also differs from how Codex normally works: the grader cannot run `git diff`, `grep` or a read-only test command, and suites have to learn a second Codex behavior that stock Promptfoo does not have.

## Decision

A Codex grader runs stock Promptfoo `openai:codex-sdk`, with Promptfoo's own options forcing it read-only:

- `sandbox_mode: read-only`, `approval_policy: never`, `network_access_enabled: false`, `web_search_enabled: false` and `web_search_mode: disabled`. A grader config that sets any of them to another value is rejected, as before. `deep_tracing` and `mcpServers` stay rejected.
- The grader adds no `cli_config` of its own, so nothing disables the shell or adds an MCP server. A `cli_config` in the grader config is still rejected by the closed Codex grader schema, unlike stock Promptfoo, so authors cannot override the forced options through it.
- Promptfoo's default minimal `cli_env` applies (no `inherit_process_env`), so the host environment's tokens do not reach Codex. The Codex process, and therefore its commands, still receives the grader's own API key: Promptfoo sets `CODEX_API_KEY`, and the runner forwards each `grader.env` key, such as `OPENAI_API_KEY`, through `cli_env`. Codex's `shell_environment_policy` stays at its default, which keeps variables named like keys and tokens. The runner redacts these values from the grader's output and errors.

Delete `workspace-reader.ts`, its process entry, its packed-package smoke and its tests.

What the sandbox enforces is Codex's own: Seatbelt on macOS, bubblewrap and seccomp on Linux, and the Windows sandbox on Windows. The read-only sandbox blocks writes and command network access. It does not confine reads: a Codex grader can read any file the user can read, not only the workspace and declared protected sources. The Claude, Copilot and Pi graders keep their path-checked read tools and still have no shell.

The Codex instruction isolation from ADR 0008 is removed too: no untrusted project trust key, no `project_doc_max_bytes: 0`, no `skills.include_instructions: false` and no per-file skill disabling. As in stock Codex, the grader loads the workspace's `AGENTS.md` and skills, so a candidate that writes them can add instructions to the judge's context. The built-in grading rules still tell the grader that workspace content is evidence, not instructions. Claude, Copilot and Pi graders keep their instruction and skill isolation.

The built-in grading rules tell a Codex grader that it has shell commands in a read-only sandbox with writes and network denied. The other graders are still told that shell execution is denied.

## Consequences

- Codex graders can run read-only commands, such as `git diff`, `grep` or a test runner that writes nothing. Other graders still cannot execute tests.
- [#149](https://github.com/allagentsdev/oh-my-promptfoo/issues/149) no longer applies: there is no reader.
- A candidate can influence a Codex judge through `AGENTS.md` or skills it writes. Suites grading untrusted candidates that could exploit this should use another grader.
- A Codex grader's reads are not limited to the workspace. Suites that need judge reads confined to the workspace should use a Claude, Copilot or Pi grader, or run Codex in an isolated runner. As ADR 0008 says, none of these policies is a sandbox against malicious same-user processes.
- Codex grading inherits Promptfoo and Codex changes to the read-only sandbox, including platform differences in how Codex enforces it.

## Alternatives rejected

- **Fix the reader race.** Component-wise `O_NOFOLLOW` opens need `openat`, which Node lacks, so it needs a native helper per platform. That is more code of our own to keep the grader on a surface stock Codex does not use.
- **A Codex permission profile that reads only the workspace and declared sources.** Profiles are beta, need Codex 0.138.0 or later, are silently ignored when `sandbox_mode` is set, cannot be expressed through the SDK's `-c` overrides for paths containing dots, and need Codex's own executable granted explicitly on Linux ([openai/codex#29049](https://github.com/openai/codex/issues/29049)). The maintainer chose stock Promptfoo behavior over that machinery.
- **Keep Codex's instruction isolation.** It is configuration stock Promptfoo does not apply, and its project trust key went through the SDK's dotted `-c` serializer, which this repository could not verify Codex applies to paths. The maintainer chose stock behavior.
- **Strip the API key from commands with `shell_environment_policy`.** It is one more setting stock Promptfoo does not apply; the maintainer kept stock behavior and relies on output redaction.
