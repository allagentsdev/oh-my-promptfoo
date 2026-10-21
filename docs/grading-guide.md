# Grading guide

oh-my-promptfoo ships two Promptfoo assertions. `llmAssert` is Promptfoo's
`llm-rubric` batched: one judge request scores many named criteria, and each
criterion gets its own score in the results. `agentAssert` uses the same
criteria format, but a read-only agent judge inspects the test's workspace,
so it can grade what the agent changed rather than what it said.

Both are referenced as JavaScript assertions:
`package:oh-my-promptfoo/assertions:llmAssert` and
`package:oh-my-promptfoo/assertions:agentAssert`. `llmAssert` needs
`OPENAI_API_KEY` and `OPENAI_MODEL` (and `OPENAI_BASE_URL` for a non-OpenAI
endpoint) in the environment that runs Promptfoo.

## llmAssert

`llmAssert` batches named criteria into one judge request. A component passes
when its judge verdict is not false, and `config.threshold` adds a numeric bar
on top of that verdict when you state one — the same contract as Promptfoo's
own `llm-rubric`, which applies a threshold only when the assertion carries
one. There is no default bar. When batching equally weighted rubrics alongside
other assertions, set the outer Promptfoo `weight` to the number of components
to preserve the test's weighted score.

Set `config.scoring: binary` for a checklist, where a criterion is either met or
not. The judge is told to score 1 if the answer fully meets a criterion and 0
otherwise, to keep its subject, condition, polarity and scope rather than accept
a weaker promise, and to treat a criterion whose condition the answer never
reaches as met if the answer does nothing it forbids. The pass mark
becomes a full score, so a `threshold` beside the mode that is not 1
contradicts it and is rejected. Stating the mode replaces writing those rules
into every rubric by hand.

The default, `graded`, trusts the judge's verdict, adds no bar unless you state
one, and says nothing about how to score. Partial credit for a near miss is
what graded is for, so none of the checklist rules apply to it.

Put what only the suite knows, such as which claims its domain counts as
unverified, in `config.rubricPrompt`. Unlike `llm-rubric`, it cannot replace the
system prompt: one request scores every criterion only because the reply format
is fixed, so the suite's text is added beneath the built-in rules. The answer is
always sent to the judge on its own, and the criteria come from `components`, so
a template that uses `{{ output }}` or `{{ rubric }}` is rejected.

Both `rubricPrompt` and component `value` templates receive test variables,
`{{ env.NAME }}` from the permitted process environment, and the `load` filter
(`JSON.parse`, not a file loader). Component values keep structured variables.
In `rubricPrompt` only, objects become JSON strings; arrays remain arrays with
object elements JSON-stringified and primitives unchanged, matching Promptfoo's
grader-prompt conversion. Set `PROMPTFOO_DISABLE_OBJECT_STRINGIFY=true` or `1` to
keep structured variables there too, or use `load` to parse a JSON string before
property access. Unset variables fail rather than render empty.
`PROMPTFOO_DISABLE_TEMPLATING=true` or `1` leaves both text fields literal.

`llmAssert`'s own `env` global honors process-level
`PROMPTFOO_DISABLE_TEMPLATE_ENV_VARS`, defaulting to disabled with
`PROMPTFOO_SELF_HOSTED` (an empty disable flag also uses that default).
It does not read private config-level or async environment overrides or custom
`nunjucksFilters`. Separately, Promptfoo's config-load pass can already render
`{{ env.NAME }}` using merged config `env:` before this assertion receives it;
these pre-rendered values are not controlled by `llmAssert`'s rendering flags.
Only assertion `config.rubricPrompt` is read, never `options.rubricPrompt`.
Share inline guidance with YAML anchors (`rubricPrompt: &guidance |` at its
first definition, `rubricPrompt: *guidance` on later assertions). A `file://`
reference that reaches `llmAssert` fails with a missing-config-directory error:
script contexts expose no config directory, and it never guesses from `cwd`.
For tests loaded through `tests: file://*.yaml` (also JSON/JSONL), Promptfoo can
inline nested `config.rubricPrompt` and component `value` file references from
its base path before the assertion runs. Loaded strings follow normal template
checks; parsed JSON/YAML objects or arrays are not string templates and fail
type validation. The assertion cannot identify their original file path.
See [ADR 0006](adr/0006-llm-assert-rubric-prompt.md) for upstream sources
and deliberate differences from Promptfoo's grader defaults.

It reports the judge call's token usage back to Promptfoo, which records it under
`tokenUsage.assertions` — grader spend, separate from the agent under test. A
grader that returns no usage reports nothing rather than zero, so an unmeasured
call is never summed into a run total as a free one.

## Grading an agent's answer

`llmAssert` sees only the final answer, never the agent's tool calls, commands
or workspace, and it adds no rule of its own about narrated work. When the
answer comes from an agent, state that rule in the suite's `rubricPrompt`,
where anyone reading the config can see it:

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

Leave the rule out when narrated actions are the expected output, such as a
support bot replying "I've cancelled your order". To grade real edits, use
`agentAssert` below or a JavaScript assertion that reads the workspace.

## agentAssert: grade workspace changes with an agent

`agentAssert` uses the same named components, weights, scoring, threshold and
`rubricPrompt` contract, but verifies claims against the live case workspace.
Choose any supported delegate, including Copilot:

```yaml
assert:
  - type: javascript
    value: package:oh-my-promptfoo/assertions:agentAssert
    metric: workspace-change
    config:
      scoring: binary
      grader:
        id: copilot-sdk
        config:
          model: '{{env.GRADER_MODEL}}'
          permissions: { filesystem: read, shell: deny, network: deny }
        env:
          GH_TOKEN: '{{env.GH_TOKEN}}'
      components:
        - metric: parser-fix-present
          value: The workspace contains a focused fix in src/parser.ts for the reported bug.
        - metric: no-unrelated-edits
          value: No files outside src/parser.ts and its test were modified.
```

Use this with the workspace `Provider`; a missing or released
`metadata.workspace.path` fails instead of falling back to the answer text.
Enable provider `fileChanges: true` to give the judge changed-file paths and
metadata plus the diff, not captured base64 contents. Files and the answer remain untrusted;
claims earn credit only when verified. Graders cannot write, run shell commands
or access the network through agent tools. They therefore cannot execute tests.
Model-service requests still require the delegate's credentials and network.

`maxPromptBytes` bounds the full assembled grader prompt in UTF-8 bytes,
including rules, criteria and evidence. The default is 131,072 bytes (128 KiB);
it accepts integers from 1 to 16,777,216. If the prompt is too large, the diff
is omitted with an explicit notice recording the omitted byte count. If the
remaining prompt still exceeds the budget, grading fails before a delegate
starts, naming both the measured size and budget. Files remain available for
on-demand inspection; increasing the budget never sends captured base64 bytes.

The grader has a 120-second execution timeout, configurable with assertion
`timeoutMs`, including one retry for a malformed verdict. It starts after the
grader session slot is acquired. A separate `queueTimeoutMs` bounds waiting
for that slot (default 15 minutes); both settings accept 1–3,600,000 ms.
Sessions serialize per process, independently of provider workers. Tokens are
accounted as assertion usage even when a billed attempt fails; reported cost is
preserved in `tokensUsed.cost`, although Promptfoo versions may not aggregate it.

Codex graders require API-key auth via `grader.config.apiKey` or explicit
`grader.env.OPENAI_API_KEY`. They do not load or copy ChatGPT `auth.json`, avoiding
single-use refresh-token corruption. See [ADR 0008](adr/0008-agent-assert-workspace-grading.md)
for the live-workspace and resource-bound tradeoffs.
