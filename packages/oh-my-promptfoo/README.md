# oh-my-promptfoo

Run coding-agent evaluations with stock Promptfoo. The package owns a private
workspace per test, can run Copilot in an existing directory, and provides an
independent assertion for named semantic criteria.

| Use case | Promptfoo reference |
| --- | --- |
| Isolated workspace with pinned Git, OCI artifact, or trusted local-directory sources | `package:oh-my-promptfoo:Provider` |
| Copilot in a directory managed by the caller | `package:oh-my-promptfoo:CopilotSdkProvider` |
| One judge request for named rubric criteria | `package:oh-my-promptfoo/assertions:llmAssert` |

## Install

Node 22.22+ and Promptfoo 0.122.x or 0.124.x are required. The Copilot SDK is
an optional peer; install it when using either Copilot provider.

```sh
npm install --save-dev promptfoo@0.124.0 oh-my-promptfoo
npm install --save-dev @github/copilot-sdk@1.0.17 # Copilot only
```

Set the agent credential through `delegate.env` in authored evals. Set
`OPENAI_API_KEY` and `OPENAI_MODEL` separately when using `llmAssert`. OCI inputs
require ORAS 1.x through `ALLAGENTS_ORAS_PATH`. A trusted runner must provide
`ALLAGENTS_LOCAL_SOURCE_ROOT` before acquiring `type: local` sources.

Several `type: local` sources may name the same `destination` and merge into one
tree, so N plugins can stage their skills into a single `.agents/skills`. They
must agree on `permissions`, and no two of them may contribute the same relative
path; a collision names both sources and fails. Git and OCI sources keep
exclusive destinations, and nested destinations remain rejected.

`llmAssert` batches named criteria into one judge request. A component passes
when its judge verdict is not false, and `config.threshold` adds a numeric bar
on top of that verdict when you state one — the same contract as Promptfoo's
own `llm-rubric`, which applies a threshold only when the assertion carries
one. There is no default bar. When batching equally weighted rubrics alongside
other assertions, set the outer Promptfoo `weight` to the number of components
to preserve the test's weighted score.

Set `config.scoring: binary` for a checklist, where a criterion is either met or
not. The judge is told to score exactly 1 or 0 and never award partial credit,
to preserve each criterion's subject, condition, polarity and scope rather than
accept an easier promise, and to treat a criterion whose condition the output
never enters as satisfied so long as nothing it forbids occurs. The pass mark
becomes a full score, so a `threshold` beside the mode that is not 1
contradicts it and is rejected. Stating the mode replaces writing those rules
into every rubric by hand.

The default, `graded`, trusts the judge's verdict, adds no bar unless you state
one, and says nothing about how to score. Partial credit for a near miss is
what graded is for, so none of the checklist rules apply to it.

Set `config.candidate: agent` when the output is an agent's answer, and the
judge is also told to credit only what the answer states — never a claimed tool
call, command, file or query — and that skill retrieval is gated elsewhere.

Put what only the suite knows, such as which claims its domain counts as
unverified, in `config.rubricPrompt`. Unlike `llm-rubric`, it cannot replace the
system prompt: one request scores every criterion only because the reply format
is fixed, so the suite's text is added beneath the built-in rules. The answer is
always sent to the judge on its own, and the criteria come from `components`, so
a template that uses `{{ output }}` or `{{ rubric }}` is rejected. Test
variables render in `rubricPrompt` and in each component's `value` as they do in
an `llm-rubric` value, and an unset variable fails the assertion instead of
rendering empty. `PROMPTFOO_DISABLE_TEMPLATING` leaves both literal.

It reports the judge call's token usage back to Promptfoo, which records it under
`tokenUsage.assertions` — grader spend, separate from the agent under test. A
grader that returns no usage reports nothing rather than zero, so an unmeasured
call is never summed into a run total as a free one.

## Author and run an eval

Start with the [agent-facing usage skill](https://github.com/allagentsdev/oh-my-promptfoo/blob/main/skills/oh-my-promptfoo/SKILL.md)
for concrete workspace, Copilot, file-assertion, and grading examples. The
[examples](https://github.com/allagentsdev/oh-my-promptfoo/tree/main/examples)
contain full Promptfoo configs; the [provider guide](https://github.com/allagentsdev/oh-my-promptfoo/blob/main/docs/provider-guide.md)
covers limits, permissions, source provenance, cleanup, and cache behavior.

```sh
npx promptfoo validate config -c promptfooconfig.yaml
npx promptfoo eval -c promptfooconfig.yaml
```

`Provider` starts the agent at its private workspace root unless `workingDir`
selects a prepared subdirectory. The optional `agent-workspace/` sibling layout
is documented in the provider guide; the root layout remains the default.
