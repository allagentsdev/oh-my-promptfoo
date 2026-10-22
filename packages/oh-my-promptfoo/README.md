# oh-my-promptfoo

**An opinionated way to evaluate coding agents and their skills with Promptfoo.**

<p>
  <a href="https://www.npmjs.com/package/oh-my-promptfoo"><img src="https://img.shields.io/npm/v/oh-my-promptfoo" alt="npm"></a>
  <a href="https://github.com/allagentsdev/oh-my-promptfoo/blob/main/LICENSE"><img src="https://img.shields.io/github/license/allagentsdev/oh-my-promptfoo" alt="License"></a>
</p>

Promptfoo can already run coding agents such as Codex and Claude Code.
oh-my-promptfoo adds the parts you end up building yourself once you test
skills and agent instructions seriously: every test runs in its own isolated
workspace, one judge call grades a whole list of criteria, and GitHub Copilot
and Pi join Codex and Claude Code behind the same provider.

It's a plain Promptfoo package, not a fork or a wrapper. `promptfoo eval`,
`promptfoo view`, caching and CI work as they always do.

## Quick start

You need Node 22.22 or later and Promptfoo 0.122 or 0.124.

```sh
npm install --save-dev promptfoo@0.124.0 oh-my-promptfoo
npm install --save-dev @github/copilot-sdk@1.0.17               # only if you use Copilot
npm install --save-dev @earendil-works/pi-coding-agent@1.3.0    # only if you use Pi
```

Add a `promptfooconfig.yaml` next to your `skills` folder:

```yaml
prompts: ["{{task}}"]
providers:
  - id: package:oh-my-promptfoo:Provider
    config:
      delegate:
        id: copilot-sdk
        env:
          GH_TOKEN: "{{env.GH_TOKEN}}"   # pass the agent's credentials here
      workspace:
        sources:
          - type: local
            path: ./skills               # relative to this file
            destination: .agents/skills
            permissions: all
defaultTest:
  options:
    provider: openai:chat:gpt-6-sol      # the llmAssert judge
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
export OPENAI_API_KEY=...      # for the judge's OpenAI provider
npx promptfoo eval
npx promptfoo view
```

The judge is an ordinary Promptfoo provider, set the way `llm-rubric`'s is:
in `defaultTest.options.provider` as above, or with
`npx promptfoo eval --grader <provider-id>`. For Azure OpenAI, set
`OPENAI_BASE_URL` to the full `https://<resource>.openai.azure.com/openai/v1`
address and use `openai:chat:<deployment>`. The
[grading guide](https://github.com/allagentsdev/oh-my-promptfoo/blob/main/docs/grading-guide.md#choosing-llmasserts-judge)
covers per-test judges and falling back to another judge during an outage.

The [examples](https://github.com/allagentsdev/oh-my-promptfoo/tree/main/examples) include configs for Codex, Claude Code, Copilot,
pinned Git and OCI sources, and larger runs.

## What you can do

- **Start every test from a clean workspace.** List the Git repositories (at a
  pinned commit), OCI artifacts or local folders a test needs. The agent works
  on copies, so your checkout stays untouched and one test's edits never reach
  the next.
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
- **Run Copilot in a folder you already have.** `CopilotSdkProvider` runs
  Copilot where you point it, without creating a workspace.

## Writing evals with an AI agent

If an agent is writing your evals, point it at the
[oh-my-promptfoo skill](https://github.com/allagentsdev/oh-my-promptfoo/blob/main/skills/oh-my-promptfoo/SKILL.md). It covers workspace
layouts, source permissions, file assertions and grading, with complete
examples.

## Learn more

- [Provider guide](https://github.com/allagentsdev/oh-my-promptfoo/blob/main/docs/provider-guide.md): sources, permissions, each agent's
  settings, limits, cleanup and caching
- [Grading guide](https://github.com/allagentsdev/oh-my-promptfoo/blob/main/docs/grading-guide.md): `llmAssert` and `agentAssert` in
  full, including choosing the judge, fallback judges, scoring modes,
  templates, token usage and prompt size limits
- [Examples](https://github.com/allagentsdev/oh-my-promptfoo/tree/main/examples): complete Promptfoo configs
- [Architecture decisions](https://github.com/allagentsdev/oh-my-promptfoo/tree/main/docs/adr): why things work the way they do
- [Changelog](https://github.com/allagentsdev/oh-my-promptfoo/blob/main/CHANGELOG.md)
