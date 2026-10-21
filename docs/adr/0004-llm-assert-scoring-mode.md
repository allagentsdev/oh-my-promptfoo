# ADR 0004: Name the llmAssert scoring mode rather than count its steps

- Status: Accepted; Superseded for the `candidate` field by [ADR 0009](0009-remove-llm-assert-candidate.md)
- Date: 2026-10-21

## Context

`llmAssert` batches named criteria into one judge request. Callers grading a checklist were all writing the same instructions into `config.rubric` by hand and pairing them with `threshold: 1`. Measured across one consumer's eleven migrated suites, roughly 500 of every rubric's ~800 characters said the same thing in slightly different words, and none of it was domain knowledge.

`config.scoring: "graded" | "binary"` removes that duplication. The obvious alternative is a numeric scalar — a step count, where `2` means binary, `5` a Likert rubric, `11` the 0–10 integers AgentV's `score_ranges` used — which generalises instead of enumerating.

## Decision

Keep the named mode.

A step count describes a mechanism; the mode carries semantics that do not follow from the count:

- **The pass mark.** `binary` fixes the per-component bar at a full score, because a criterion that is either met or not has no other coherent bar. `granularity: 2` would leave the caller to pair it with `threshold: 1` again, which is the duplication the change exists to remove.
- **How the judge reads a criterion.** `binary` also tells the judge to preserve a criterion's subject, condition, polarity and scope, to refuse an easier promise, and to treat a criterion whose condition the output never enters as satisfied. Those are checklist semantics, not a consequence of having two buckets. Under `graded` they are wrong: credit for a near miss is what that mode is for.

A number also invites values nobody has defined behaviour for. `3` and `7` would have to mean something, and the prompt text would become a generated list of permitted scores rather than one crisp sentence.

The enum does not block the generalisation. A future scale rubric is `scoring: "scale"` with its own `steps`, which keeps the intent named and the parameter numeric. Adding that is backwards compatible; replacing a published enum with a number is not.

## Consequences

Each new scoring style costs an enum value and its prompt text, rather than falling out of arithmetic. That is accepted: a style worth supporting is worth describing, and the set is expected to stay small.

> Superseded by [ADR 0009](0009-remove-llm-assert-candidate.md): `candidate` was removed, and a suite grading an agent's answer states that rule in `rubricPrompt`. The two paragraphs below are kept as history.

`scoring` and `candidate` remain orthogonal. `candidate: agent` states what is being graded — an answer that narrates work the judge cannot verify — and is useful under either scoring mode, so collapsing both into one `mode` would conflate the two questions.

The agent rule explicitly includes claims of edited or deleted files and build or test runs. This makes `candidate: agent` slightly stricter for callers who relied on crediting edit/build/test claims. That is intended: these are narrated actions the judge cannot verify, just like tool calls and file creation, so generic coding-agent suites should not need a repeated `rubricPrompt` workaround.

The default stays `graded` with no added instructions. Its bar also follows Promptfoo rather than this package: `llm-rubric` gates on the judge's verdict and applies a numeric threshold only when the assertion states one, so `llmAssert` dropped the `0.7` default it had invented. A drop-in replacement that grades more strictly than the assertion it replaces is the kind of surprise that costs adoption, and the audience here is Promptfoo users rather than migrants from any one harness.

### Prompt wording revision

The base prompt now changes for every caller, including `graded`, revising the earlier choice to keep its wording stable. The base, binary and agent instructions consistently call the graded content an "answer", remove duplicate instructions, and state the evidence-only and no-restatement rules without ambiguous conjunctions. No rule was removed: the JSON reply contract, instruction isolation, evidence requirements, binary checklist semantics and separate skill check remain, as do the `rubricPrompt` heading and criteria block. Binary and agent additions still apply only to their respective modes. (The `candidate: agent` addition is superseded by [ADR 0009](0009-remove-llm-assert-candidate.md); `llmAssert` no longer adds it, and only `agentAssert` keeps an agent rule.)

Although the rewrite preserves those rules, graded and binary callers may see small score movement because judge models can respond differently to equivalent wording. This is an intentional clarity tradeoff, separate from the stricter treatment of unverified edit/build/test claims above.
