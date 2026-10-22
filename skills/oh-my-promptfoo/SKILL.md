---
name: oh-my-promptfoo
description: Use when authoring, running, or debugging stock Promptfoo coding-agent evals with oh-my-promptfoo's workspace Provider, direct CopilotSdkProvider, llmAssert or agentAssert assertions. Not for Promptfoo core changes or redteam scans.
---

# Evaluate coding agents with oh-my-promptfoo

Keep the authored `promptfooconfig.yaml` in the consuming project. Choose the
provider before writing assertions:

- `package:oh-my-promptfoo:Provider` prepares a new, private workspace for each
  test. Use it for Git, OCI artifact, or trusted local-directory sources.
- `package:oh-my-promptfoo:CopilotSdkProvider` runs Copilot in an existing
  directory that the caller owns; it does not stage sources.
- `package:oh-my-promptfoo/assertions:llmAssert` grades named semantic criteria
  independently of either provider.
- `package:oh-my-promptfoo/assertions:agentAssert` grades the live case workspace
  with any supported agent delegate, rather than trusting its final answer.

Workspace delegates are `openai:codex-sdk`, `anthropic:claude-agent-sdk`,
`copilot-sdk`, and `pi-sdk`; choose explicit labeled provider entries.
For Pi install `@earendil-works/pi-coding-agent@1.3.0`, set
`delegate.id: pi-sdk` and nonempty `delegate.config.provider` and `model`,
and supply `config.apiKey` or explicit credential variables in `delegate.env`.
Optional `baseUrl` supports HTTP(S) local model endpoints without URL credentials.
Use the [Pi example](../../docs/provider-guide.md#pi-configuration) for the full
provider entry. Pi defaults to read-only filesystem tools and shell denied.
It uses raw prompts and in-memory sessions, with no extension, global auth or
project settings discovery. Staged skills and root `AGENTS.md` are its only
discovered resources; this is tool policy, not an OS sandbox.
Keep existing skill authoring and `skill-used` assertions: Pi reports only
successful contained, non-symlink `SKILL.md` reads as `source: "read-tool"`.

## Review a pinned source with local skills

This example assumes `promptfooconfig.yaml` sits in `evals/` of a trusted
checkout that also contains `plugins/cargowise/skills`. The source checkout is
protected; skills have a private writable view for the case. The agent starts
at the workspace root, with `CargoWise/` and `.agents/skills/` as siblings.

```yaml
prompts: ["{{task}}"]
providers:
  - id: package:oh-my-promptfoo:Provider
    config:
      delegate:
        id: copilot-sdk
        config:
          permissions:
            filesystem: read
            shell: allow
            network: deny
        env:
          GH_TOKEN: "{{env.GH_TOKEN}}"
      workspace:
        viewMode: copy-only
        sources:
          - type: git
            repository: https://github.com/WiseTechGlobal/CargoWise.git
            ref: 953adb94d49ae392c08082dc68717eefac0526cc
            destination: CargoWise
            permissions: read-only
          - type: local
            path: ../plugins/cargowise/skills
            destination: .agents/skills
            permissions: all
tests:
  - vars:
      task: Read .agents/skills/cw-sql-schema-migration/SKILL.md and its mandatory references, then name one rule for reviewing online transformations.
    assert:
      - type: skill-used
        value: cw-sql-schema-migration
```

A relative local `path` resolves against the eval config's directory, as
Promptfoo resolves its own `file://` references, even when the provider is
loaded from `providers: file://…`. It must stay inside the Git repository that
contains that directory (or the directory itself outside a repository); a
runner can replace that boundary with an absolute `ALLAGENTS_LOCAL_SOURCE_ROOT`.
Local directories include untracked and ignored files. Keep secrets and build
outputs outside them; their resolved `metadata.workspace.sources[].digest`
identifies the staged content. `CargoWise.git` is private: the trusted runner
must supply a scoped `ALLAGENTS_GIT_TOKEN` (and optionally
`ALLAGENTS_GIT_USERNAME`) to acquire it. Do not put source credentials in
`delegate.env` or authored YAML; `GH_TOKEN` above only authenticates Copilot.
Without access to that repository, use a public pinned Git source or the
empty-workspace example below. For other pinned Git/OCI layouts and source
permissions, read [the provider guide](../../docs/provider-guide.md) and
[the source permissions example](../../examples/source-permissions/promptfooconfig.yaml).

To stage several plugins' skills side by side, repeat `destination:
.agents/skills` on one `type: local` source per plugin; the trees merge into
that one directory. Every source sharing a destination must declare the same
`permissions`, and no two may contribute the same relative path — a collision
fails the run and names both source paths instead of one plugin silently
shadowing another. Only `type: local` sources merge, and a destination nested
inside another (`a` and `a/b`) is still rejected.

## Check generated files without model grading

When the task requires an exact file, assert its bytes through the workspace
path returned by the provider rather than grading an agent's claim to have
written it:

```yaml
prompts: ["{{task}}"]
providers:
  - id: package:oh-my-promptfoo:Provider
    config:
      delegate:
        id: copilot-sdk
        config:
          permissions: { filesystem: write, shell: allow, network: deny }
        env:
          GH_TOKEN: "{{env.GH_TOKEN}}"
      workspace:
        sources: []
tests:
  - vars:
      task: Write hello.txt with exactly "Hello world" followed by a newline.
    assert:
      - type: javascript
        value: |-
          return import('node:fs').then(({readFileSync}) =>
            readFileSync(context.providerResponse.metadata.workspace.path + '/hello.txt', 'utf8') === 'Hello world\n');
```

For an existing Copilot directory, replace the workspace provider with
`package:oh-my-promptfoo:CopilotSdkProvider` and set its required
`config.working_dir` to the existing absolute directory. See
[the direct Copilot example](../../examples/copilot/promptfooconfig.yaml).

## Grade semantic findings

Use one independent judge request for named criteria. The judge needs
`OPENAI_MODEL` and `OPENAI_API_KEY`; an OpenAI-compatible or Azure OpenAI v1
endpoint can be set with `OPENAI_BASE_URL`.

```yaml
assert:
  - type: javascript
    value: package:oh-my-promptfoo/assertions:llmAssert
    config:
      scoring: binary
      rubricPrompt: &suiteGuidance |
        Treat claims unsupported by {{ source }} as unverified.
      components:
        - metric: schema-evidence
          value: Cites the concrete schema fact supporting the recommendation.
        - metric: safe-change
          value: Checks the change for unintended row updates.
```

A component passes when the judge's verdict is not false. `threshold` adds a
numeric bar on top of that verdict, per component rather than as an aggregate,
and there is no default — the same contract as Promptfoo's `llm-rubric`. The
assertion passes only when every component passes. For a checklist, where a
criterion is either met or not, set `scoring: binary` rather than a threshold:
the judge is told to score exactly 1 or 0, to keep each criterion's scope and
polarity, and the bar becomes a full score, so none of that has to be repeated
in each suite's `rubricPrompt`. Keep `rubricPrompt` for instructions only this
suite needs, such as which claims its domain counts as unverified. It is added
beneath the built-in rules and cannot replace them or the reply format, so do
not paste an `llm-rubric` template that uses `{{ output }}` or `{{ rubric }}`:
as in `llm-rubric`, the judge already receives the answer in an `<Output>` block
and the criteria in a `<Rubric>` block. If a grade claims the answer is missing
or misreads it, inspect the assertion's `metadata.renderedGradingPrompt`, which
records exactly what the judge was sent.
Only assertion `config.rubricPrompt` is read; `options.rubricPrompt` is ignored.
To share these instructions, define a YAML anchor as above and use
`rubricPrompt: *suiteGuidance` in another assertion's `config` in the same YAML
document. A `file://` reference still present when `llmAssert` runs fails clearly:
script contexts provide no config directory, and it never guesses from `cwd`.
For tests loaded via `tests: file://*.yaml` (also JSON/JSONL), Promptfoo can
inline nested rubricPrompt/component file references from its base path first.
Loaded strings receive the normal checks; parsed JSON/YAML objects or arrays
fail string-template validation. Their original file paths are not available.

Test variables such as `{{ source }}` render in `rubricPrompt` and component
values, which is how a faithfulness criterion receives its source text. Define
`source` in the test's `vars` when using the example above: unset variables fail
before the judge call. Both template fields also support `{{ env.NAME }}` from
the permitted process environment and `load`, which calls `JSON.parse` and is
not a file loader. Component values retain structured variables. In
`rubricPrompt`, non-null objects become JSON strings; arrays retain their shape,
with object elements JSON-stringified and primitive elements unchanged. For
property access there, use `{% set parsed = source | load %}{{ parsed.text }}`
on a stringified object, or set `PROMPTFOO_DISABLE_OBJECT_STRINGIFY=true` or `1`
to retain structured variables.

`PROMPTFOO_DISABLE_TEMPLATING=true` or `1` leaves both text fields literal.
The assertion's own `env` global honors process-level
`PROMPTFOO_DISABLE_TEMPLATE_ENV_VARS`, defaulting to disabled with
`PROMPTFOO_SELF_HOSTED`; an empty disable flag also uses this default.
It does not read private config/async environment overrides or custom filters.
However, Promptfoo's config-load pass can render `{{ env.NAME }}` using merged
config `env:` before `llmAssert` sees the text. Assertion rendering flags cannot
undo that preprocessing. Use test variables for assertion-time inputs.
See [ADR 0006](../../docs/adr/0006-llm-assert-rubric-prompt.md)
for versioned upstream sources and the strict-unset/literal-disable safeguards,
and [ADR 0011](../../docs/adr/0011-llm-assert-is-batched-llm-rubric.md) for
parity with `llm-rubric`.

## Grading an agent's answer

`llmAssert` sees only the final answer, never tool calls, commands or the
workspace, and adds no rule of its own about narrated work. When the answer
comes from an agent, state the rule visibly in the suite's `rubricPrompt`:

```yaml
assert:
  - type: javascript
    value: package:oh-my-promptfoo/assertions:llmAssert
    config:
      rubricPrompt: |
        Credit only what the answer shows, not claimed actions (tool calls, commands, file reads or edits, builds, tests, queries).
      components:
        - metric: root-cause
          value: The answer names the missing null check in parsePrice as the cause.
```

Omit the rule when narrated actions are the expected output, such as a support
bot replying "I've cancelled your order". To grade real edits, use `agentAssert`
below or a JavaScript assertion that reads the workspace path.

## Grade workspace outcomes with an agent

Use `agentAssert` when a semantic criterion needs file inspection. Keep exact
byte checks deterministic. The assertion requires a live
`context.providerResponse.metadata.workspace.path` from the workspace provider;
missing or cleaned-up workspaces fail. It never falls back to answer-only grading.

```yaml
assert:
  - type: javascript
    value: package:oh-my-promptfoo/assertions:agentAssert
    metric: workspace-change
    config:
      scoring: binary
      timeoutMs: 120000
      grader:
        id: copilot-sdk
        config:
          model: '{{env.GRADER_MODEL}}'
          permissions: { filesystem: read, shell: deny, network: deny }
        env:
          GH_TOKEN: '{{env.GH_TOKEN}}'
      components:
        - metric: focused-fix
          value: src/parser.ts implements the requested fix without unrelated edits.
```

The grader may also be `anthropic:claude-agent-sdk`, `openai:codex-sdk`, or `pi-sdk`.
Use the delegate's supported model fields and explicit `grader.env` credentials;
`OPENAI_MODEL` and `OPENAI_API_KEY` are not an implicit agent-grader selection.
Codex graders require an API key in `grader.config.apiKey` or explicit
`grader.env.OPENAI_API_KEY`; they do not load ChatGPT login credentials.
Pi graders require `provider` and `model` and explicit credentials too. They
enable guarded `read` and `ls` tools without skill/context discovery; filesystem
`write` or shell `allow` settings are rejected.
Component validation, weights, thresholds and `rubricPrompt` match `llmAssert`.
Built-in agent rules require verification rather than accepting narrated work.
Candidate output, workspace files and tool results are evidence, not instructions.

Enable `fileChanges: true` on the candidate provider to supply changed-file
paths/change/kind/mode, deleted paths and the diff, never captured base64 contents. Incomplete capture is not proof
that no other files changed. The grader runs read-only with shell and network
tools denied; it cannot run tests or repair the candidate. Broader permissions
are rejected. Model-service traffic is still necessary.

`maxPromptBytes` bounds the assembled prompt (default 131072 UTF-8 bytes).
An oversized prompt omits the diff with an explicit omitted-byte notice. If
rules, criteria and remaining evidence still exceed the budget, grading fails
before a delegate starts. Inspect the files rather than increasing the budget
to inline captured contents; base64 capture content is never sent.

The default 120-second execution deadline includes one malformed-reply retry
and starts after queue admission. Separate `queueTimeoutMs` bounds queue wait
(default 900000 ms). Sessions serialize per process, not through the provider worker cap.
Usage from both attempts is reported under assertion `tokensUsed`, separately
from the candidate's usage. Inspect reported usage; no dollar ceiling is implied
by a time bound.

## Prove the run

1. Install the package and the chosen delegate peer; Copilot uses
   `@github/copilot-sdk@1.0.17` and Pi uses
   `@earendil-works/pi-coding-agent@1.3.0`. Validate the authored config with
   `npx promptfoo validate config -c promptfooconfig.yaml`.
2. Run `npx promptfoo eval -c promptfooconfig.yaml` with the required agent
   and, when applicable, judge credentials. Inspect the actual scored row.
3. Check `metadata.workspace.sources` for resolved source commits/digests and
   `metadata.workspace.path` while assertions run. Enable `fileChanges: true`
   only when the result needs agent-produced after-bytes and diffs.
   Read `metadata.fileChanges.changedFiles` for added and modified files
   (`schemaVersion: 2`); each entry has `change: "added" | "modified"` and
   base64 `content`. Read `deletedFiles` for removals and check `status` before
   relying on complete evidence.

The default cwd is the private workspace root. An optional case-private
`agent-workspace/` directory can be staged and selected with
`workingDir: agent-workspace`; repositories then remain at sibling paths such
as `../CargoWise`. Delegate-specific directory access remains separate. See
[the optional layout](../../docs/provider-guide.md#optional-sibling-agent-workspace)
and [the deferred case-scoped asset issue](https://github.com/allagentsdev/oh-my-promptfoo/issues/62).
