---
name: oh-my-promptfoo
description: Use when authoring, running, or debugging stock Promptfoo coding-agent evals with oh-my-promptfoo's workspace Provider, direct CopilotSdkProvider, or llmAssert assertion. Not for Promptfoo core changes or redteam scans.
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

## Review a pinned source with local skills

This example assumes the eval runs in a trusted checkout containing
`plugins/cargowise/skills`. The source checkout is protected; skills have a
private writable view for the case. The agent starts at the workspace root,
with `CargoWise/` and `.agents/skills/` as siblings.

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
            path: "{{env.EVAL_SKILLS_DIR}}"
            destination: .agents/skills
            permissions: all
tests:
  - vars:
      task: Read .agents/skills/cw-sql-schema-migration/SKILL.md and its mandatory references, then name one rule for reviewing online transformations.
    assert:
      - type: skill-used
        value: cw-sql-schema-migration
```

Supply `EVAL_SKILLS_DIR` as an absolute path within a trusted
`ALLAGENTS_LOCAL_SOURCE_ROOT`. A runner, not authored YAML, supplies that root.
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
not paste an `llm-rubric` template that uses `{{ output }}` or `{{ rubric }}`.
Only assertion `config.rubricPrompt` is read; `options.rubricPrompt` is ignored.
To share these instructions, define a YAML anchor as above and use
`rubricPrompt: *suiteGuidance` in another assertion's `config` in the same YAML
document. Do not use `file://`: supported Promptfoo script contexts provide no
config directory, so it fails clearly rather than resolving against `cwd`.

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
Process-level `PROMPTFOO_DISABLE_TEMPLATE_ENV_VARS` disables process access
through `env`, defaulting to disabled with `PROMPTFOO_SELF_HOSTED`. Config-level
`env`, async environment overrides, and custom `nunjucksFilters` are not exposed
to this assertion. Use test variables instead of depending on that private
Promptfoo state. See [ADR 0006](../../docs/adr/0006-llm-assert-rubric-prompt.md)
for versioned upstream sources and the strict-unset/literal-disable safeguards.

## Prove the run

1. Install the package and the chosen delegate peer; Copilot uses
   `@github/copilot-sdk@1.0.17`. Validate the authored config with
   `npx promptfoo validate config -c promptfooconfig.yaml`.
2. Run `npx promptfoo eval -c promptfooconfig.yaml` with the required agent
   and, when applicable, judge credentials. Inspect the actual scored row.
3. Check `metadata.workspace.sources` for resolved source commits/digests and
   `metadata.workspace.path` while assertions run. Enable `fileChanges: true`
   only when the result needs agent-produced after-bytes and diffs.

The default cwd is the private workspace root. An optional case-private
`agent-workspace/` directory can be staged and selected with
`workingDir: agent-workspace`; repositories then remain at sibling paths such
as `../CargoWise`. Delegate-specific directory access remains separate. See
[the optional layout](../../docs/provider-guide.md#optional-sibling-agent-workspace)
and [the deferred case-scoped asset issue](https://github.com/allagentsdev/oh-my-promptfoo/issues/62).
