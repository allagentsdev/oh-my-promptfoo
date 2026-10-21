# ADR 0009: Remove the llmAssert candidate switch in favour of rubricPrompt

- Status: Accepted
- Date: 2026-10-22
- Supersedes: the `candidate` field and its agent rule in [ADR 0004](0004-llm-assert-scoring-mode.md)

## Context

`llmAssert` accepted `config.candidate: "text" | "agent"`. With `agent`, the package appended a sentence to the judge's system prompt telling it to credit only what the answer states and never an unverified claim of a tool call, command, file inspection or change, build or test run, or external query. That sentence never appeared in the suite's config: a reader of `promptfooconfig.yaml` saw `candidate: agent` and had to know the package source to learn what the judge was told.

Making the rule unconditional is no better. `llmAssert` is a general Promptfoo assertion, and many suites grade text that describes actions on purpose: a support bot replying "I've cancelled your order" is a correct answer, not an unverified claim. An always-on rule would fail those suites.

The maintainer confirmed there are no external users.

## Decision

Remove `candidate` from `llmAssert` with no alias or compatibility shim. The system prompt now contains only the base text, the `scoring: binary` text when set, the suite's `rubricPrompt` section and the criteria. A config that still sets `candidate`, with any value, fails before a judge request with: "LLM assertion config.candidate was removed; state the grading rule in config.rubricPrompt".

A suite grading an agent's answer states the rule in its own `rubricPrompt`, where it is visible and editable. The README and skill document the recommended text and point readers who need to grade real edits to `agentAssert` or a JavaScript assertion on the workspace.

`agentAssert` keeps its built-in workspace verification rule. It only ever grades a live agent workspace, so the rule is its contract rather than a hidden mode, and it rejects `candidate` the same way.

Three reasons drive this:

- **Transparency.** Every instruction the judge receives beyond the fixed reply contract is in the suite's config.
- **A neutral default for all Promptfoo users.** The base prompt says nothing about what kind of answer is graded, so text that narrates actions is judged on the criteria alone.
- **No hidden switches.** A field whose effect is invisible prompt text is replaced by the prompt text itself.

## Consequences

This is a breaking config removal, shipped without a major release because there are no external users. Suites that set `candidate: agent` must move the rule into `rubricPrompt`; suites that set `candidate: text` delete the field. Agent-answer suites repeat one documented sentence in `rubricPrompt`, sharing it with a YAML anchor where several assertions need it. ADR 0004 previously preferred the built-in rule to avoid that repetition; visibility now outweighs it.
