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
