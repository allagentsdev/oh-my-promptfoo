# oh-my-promptfoo

**Test coding agents and their skills with Promptfoo.**

<p>
  <a href="https://www.npmjs.com/package/oh-my-promptfoo"><img src="https://img.shields.io/npm/v/oh-my-promptfoo" alt="npm"></a>
  <a href="https://github.com/allagentsdev/oh-my-promptfoo/blob/main/LICENSE"><img src="https://img.shields.io/github/license/allagentsdev/oh-my-promptfoo" alt="License"></a>
</p>

You've written a skill, an `AGENTS.md` or a prompt for a coding agent, and you
want to know whether it works, and whether it still works after the next
change. oh-my-promptfoo lets you test it like any other Promptfoo eval. Each
test gets a fresh workspace holding the repositories and skills you choose. A
real agent (Codex, Claude Code, GitHub Copilot or Pi) does the task there, and
you grade both its answer and the files it changed.

It's a plain Promptfoo package, not a fork or a wrapper. `promptfoo eval`,
`promptfoo view`, caching and CI work as they always do.

## Quick start

You need Node 22.22 or later and Promptfoo 0.122 or 0.124.

```sh
npm install --save-dev promptfoo@0.124.0 oh-my-promptfoo
npm install --save-dev @github/copilot-sdk@1.0.17               # only if you use Copilot
npm install --save-dev @earendil-works/pi-coding-agent@1.3.0    # only if you use Pi
```

Add a `promptfooconfig.yaml` next to your skills:

```yaml
prompts: ["{{task}}"]
providers:
  - id: package:oh-my-promptfoo:Provider
    config:
      delegate:
        id: copilot-sdk
        env:
          GH_TOKEN: "{{env.GH_TOKEN}}"   # the agent sees only what you pass here
      workspace:
        sources:
          - type: local
            path: ./skills               # relative to this file
            destination: .agents/skills
            permissions: all
tests:
  - vars:
      task: Our checkout page crashes when the price is empty. Explain the likely cause.
    assert:
      - type: skill-used
        value: debugging
      - type: javascript
        value: package:oh-my-promptfoo/assertions:llmAssert
        config:
          components:
            - metric: root-cause
              value: The answer points to the missing empty-price check.
```

Run it and open the results:

```sh
export GH_TOKEN=...            # for the agent
export OPENAI_API_KEY=...      # for the llmAssert judge
export OPENAI_MODEL=...        # the judge model
npx promptfoo eval
npx promptfoo view
```

The [examples](https://github.com/allagentsdev/oh-my-promptfoo/tree/main/examples) include configs for Codex, Claude Code, Copilot,
pinned Git and OCI sources, and larger runs.

## What you can do

- **Give every test a clean workspace.** Stage Git repositories at a pinned
  commit, OCI artifacts, or local directories. The agent never sees your own
  checkout, and one test's edits never leak into the next.
- **Swap the agent without rewriting tests.** Codex, Claude Code, Copilot and
  Pi run behind the same provider. Give each one a label to compare them side
  by side in one run.
- **Check that the agent used your skill.** Promptfoo's built-in `skill-used`
  assertion works with all four agents, with no tracing setup.
- **Grade many criteria in one judge call.** `llmAssert` works like
  `llm-rubric`, but scores a whole list of named criteria at once, and each
  one shows up as its own score.
- **Grade what the agent did, not what it says it did.** `agentAssert` sends a
  read-only agent into the workspace to check the changes. Turn on
  `fileChanges` to read them in your own JavaScript assertions.
- **Run Copilot in a directory you already have.** `CopilotSdkProvider` skips
  the workspace and runs Copilot where you point it.

## Writing evals with an AI agent

If an agent is writing your evals, point it at the
[oh-my-promptfoo skill](https://github.com/allagentsdev/oh-my-promptfoo/blob/main/skills/oh-my-promptfoo/SKILL.md). It covers workspace
layouts, source permissions, file assertions and grading, with worked
configs.

## Learn more

- [Provider guide](https://github.com/allagentsdev/oh-my-promptfoo/blob/main/docs/provider-guide.md): sources, permissions, each agent's
  settings, limits, cleanup and caching
- [Grading guide](https://github.com/allagentsdev/oh-my-promptfoo/blob/main/docs/grading-guide.md): `llmAssert` and `agentAssert` in
  full, including scoring modes, templates, token usage and judge budgets
- [Examples](https://github.com/allagentsdev/oh-my-promptfoo/tree/main/examples): complete Promptfoo configs
- [Architecture decisions](https://github.com/allagentsdev/oh-my-promptfoo/tree/main/docs/adr): why things work the way they do
- [Changelog](https://github.com/allagentsdev/oh-my-promptfoo/blob/main/CHANGELOG.md)
