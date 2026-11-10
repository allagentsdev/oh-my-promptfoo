---

name: review-change
description: Review an invoice access function for authorization regressions and write structured findings.
---

Read the complete requested source file. Invoice access requires both the same
tenant and the billing role. Establish a concrete unauthorized-access example
before reporting a bug. A correct implementation has no findings.

Write the requested JSON artifact with a `findings` array. Each finding contains
`line`, `severity`, `summary`, `reproduction` and `fix`. Use a one-based source
line and explain the behavior, a reproducer and the smallest corrective change.
Keep the source unchanged; use file reads and the artifact write only.
