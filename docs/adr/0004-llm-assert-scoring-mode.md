# ADR 0004: Name the llmAssert scoring mode rather than count its steps

- Status: Accepted
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

`scoring` and `candidate` remain orthogonal. `candidate: agent` states what is being graded — an answer that narrates work the judge cannot verify — and is useful under either scoring mode, so collapsing both into one `mode` would conflate the two questions.

The default stays `graded` with its existing `0.7` threshold and no added instructions, so upgrading cannot move an existing caller's scores.
