# ADR 0006: Name llmAssert's suite instructions rubricPrompt and keep the system prompt fixed

- Status: Accepted
- Date: 2026-10-21

## Context

`llmAssert` scored criteria from `config.components` and took extra suite text in `config.rubric`, added under an `Additional grading guidance` heading. Promptfoo uses "rubric" for the criteria themselves: `llm-rubric` passes its `value` into the template as `{{ rubric }}`. A Promptfoo user reading `rubric:` here expects criteria and gets instructions. One consumer's shared YAML anchor, named after binary scoring but holding scope notes, shows the confusion in practice.

`config.components` values and the suite text were also passed to the judge verbatim. Promptfoo renders an assertion's `value` with the test's variables but hands its `config` to a JavaScript assertion unrendered, so `{{ source }}` reached the judge as literal braces. Promptfoo's own guidance for faithfulness rubrics is to inline the source through a variable, which silently did nothing here.

## Decision

Rename `config.rubric` to `config.rubricPrompt`, and render test variables in it and in every component `value`.

- **One name for the knob Promptfoo users already know.** `rubricPrompt` is what they reach for to change how the grader judges. Its single difference from `llm-rubric` is that it never replaces the system prompt. One request can score every criterion only because the reply format is fixed, so the suite's text is added beneath the built-in rules under a heading that says it cannot change them. There is no full-replacement mode, so the name cannot later acquire a second meaning.
- **Reject what only makes sense in an `llm-rubric` template.** The answer is always sent to the judge on its own as the user message, and the criteria come from `components`. A `rubricPrompt` or component that uses `{{ output }}` or `{{ rubric }}`, or a `rubricPrompt` that is a chat array rather than a string, was written for `llm-rubric` and fails with a message saying so.
- **Render like Promptfoo.** Variables use the Nunjucks that Promptfoo itself depends on, resolved from the installed Promptfoo peer rather than bundled, so syntax and filters behave as they do in an `llm-rubric` value. An unset variable fails before any judge request instead of rendering empty, because an empty source turns a faithfulness criterion into one anything passes. `PROMPTFOO_DISABLE_TEMPLATING` leaves the text literal, as it does in Promptfoo.
- **Remove `rubric` outright.** There are no external users yet, so it is not kept as an alias. A config that still sets it fails with a message naming the new key.

## Consequences

`llmAssert` will never offer a Promptfoo-style whole-prompt replacement. A suite that needs one should use `llm-rubric` directly and accept one judge request per criterion.

Promptfoo's config-level `env` global and custom `nunjucksFilters` are not available in these templates; only the test's variables are.

Existing configs that set `rubric` must be renamed when they upgrade. The release is a minor version because the package has no users outside the maintainers' own suites.
