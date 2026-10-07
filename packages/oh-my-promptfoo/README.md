# oh-my-promptfoo

Run coding-agent evaluations with stock Promptfoo. This package provides two providers and an optional reusable JavaScript assertion:

Existing workspace caches remain compatible with earlier releases.

| Use case | Promptfoo provider |
| --- | --- |
| Create a private writable workspace, optionally seeded from Git or OCI, then run Codex, Claude, or Copilot in it | `package:oh-my-promptfoo:Provider` |
| Run Copilot in an existing directory that you manage | `package:oh-my-promptfoo:CopilotSdkProvider` |

`Provider` owns the workspace for each evaluation row. `CopilotSdkProvider` uses your existing directory. Neither scores agent output; the independent `llmAssert` export below can grade named rubric criteria.

## Install

Requires Node 22.22+, Linux, macOS, or Windows, and Promptfoo 0.122.x or 0.124.x. On Windows, workspace cache locks and process identity require the system Windows PowerShell executable.

```sh
npm install --save-dev promptfoo@0.124.0 oh-my-promptfoo
# Add this only if you use Copilot, directly or as a workspace delegate:
npm install --save-dev @github/copilot-sdk@1.0.6
```

Set the credential for the agent you select before running an evaluation. OCI sources also require an ORAS 1.x executable supplied through `ALLAGENTS_ORAS_PATH`.


## Grade named criteria with one judge request

Use the public `package:oh-my-promptfoo/assertions:llmAssert` reference in a stock Promptfoo JavaScript assertion. The assertion works with any provider; it does not require a workspace provider.

```yaml
tests:
  - assert:
      - type: javascript
        value: package:oh-my-promptfoo/assertions:llmAssert
        config:
          threshold: 0.7
          components:
            - metric: accuracy
              value: Grounds every factual claim in the provided material
              weight: 2
            - metric: clarity
              value: Explains the result clearly
```

Set `OPENAI_MODEL` and `OPENAI_API_KEY` for the judge; `OPENAI_BASE_URL`
optionally points to an OpenAI-compatible or Azure OpenAI v1 endpoint. One
request grades all uniquely named components; names inherited from
`Object.prototype` are rejected because Promptfoo aggregates named scores into
plain objects. Weights default to 1. The weighted mean must reach
`threshold` (default 0.7), and every component must pass: an explicit judge
`pass` flag takes precedence over its score; otherwise the component score
must reach the threshold. Missing, duplicate, malformed, or unknown grades
fail the assertion. Promptfoo receives `componentResults`, `namedScores`,
and `namedScoreWeights`. Grading instructions and criteria use the system
message; the candidate output is passed separately as untrusted user content.
The judge request has a 120-second deadline.

This is a package-supplied JavaScript assertion, not Promptfoo's proposed
native [`llm-rubric.value.components` feature](https://github.com/promptfoo/promptfoo/issues/10069).

## Prepare a workspace and run an agent

`Provider` creates a separate writable workspace for each test. `delegate.id` selects the agent; `workspace.sources` places Git or OCI content in that workspace. Use `sources: []` when the agent needs an empty workspace.

```yaml
# promptfooconfig.yaml
prompts: ["{{task}}"]
providers:
  - id: package:oh-my-promptfoo:Provider
    config:
      delegate:
        id: openai:codex-sdk
        config:
          model: gpt-5.3-codex
          sandbox_mode: workspace-write
        env:
          OPENAI_API_KEY: "{{env.OPENAI_API_KEY}}"
      workspace:
        sources:
          - type: git
            repository: https://github.com/allagentsdev/oh-my-promptfoo.git
            ref: main
            destination: project
      workingDir: project
tests:
  - vars:
      task: Read README.md and write a summary to summary.txt in this repository.
    assert:
      - type: javascript
        value: |
          return import('node:fs').then(fs => {
            const root = context.providerResponse.metadata.workspace.path;
            return fs.readFileSync(root + '/project/summary.txt', 'utf8').length > 0;
          });
```

```sh
npx promptfoo eval --config promptfooconfig.yaml
```

The workspace stays available while Promptfoo runs assertions. `metadata.workspace.path` is a transient local path, not a durable artifact. For Codex, Claude, and Copilot variants, see the [workspace examples](https://github.com/allagentsdev/oh-my-promptfoo/tree/main/examples).

## Run Copilot in an existing directory

`CopilotSdkProvider` runs Copilot in an existing `working_dir`. Set `COPILOT_WORKING_DIR` to an absolute path. This provider does not prepare Git or OCI sources.

```yaml
# promptfooconfig.yaml
prompts: ["{{task}}"]
providers:
  - id: package:oh-my-promptfoo:CopilotSdkProvider
    config:
      working_dir: "{{env.COPILOT_WORKING_DIR}}"
      env:
        COPILOT_GITHUB_TOKEN: "{{env.COPILOT_GITHUB_TOKEN}}"
tests:
  - vars:
      task: Explain the purpose of this repository.
    assert:
      - type: regex
        value: .+
```

Copilot's default permissions deny writes, shell, and network. Set `config.permissions` explicitly when a test needs them. The [direct Copilot example](https://github.com/allagentsdev/oh-my-promptfoo/blob/main/examples/copilot/promptfooconfig.yaml) shows write permission.

Run this configuration with `npx promptfoo eval --config promptfooconfig.yaml` after setting `COPILOT_WORKING_DIR` and `COPILOT_GITHUB_TOKEN`.

## Configuration at a glance

| Field | Applies to | Meaning |
| --- | --- | --- |
| `config.delegate.id` | `Provider` | Required: `openai:codex-sdk`, `anthropic:claude-agent-sdk`, or `copilot-sdk` |
| `config.delegate.config` | `Provider` | Agent-specific settings, such as model and sandbox mode |
| `config.delegate.env` | `Provider` | Explicit credentials passed to the delegated agent |
| `config.workspace.sources` | `Provider` | Required array of Git or OCI sources; `[]` creates an empty workspace |
| `config.workspaceTimeoutMs` | `Provider` | Optional workspace-preparation deadline; falls back to `ALLAGENTS_WORKSPACE_TIMEOUT_MS`, then 120,000 ms |
| `config.workingDir` | `Provider` | Optional relative directory inside the prepared workspace; defaults to its root |
| `config.fileChanges` | `Provider` | Optional bounded file-change evidence; defaults to `false` |
| `config.timeoutMs` | `Provider` | Agent-call deadline; independent of preparation and defaults to 900,000 ms |
| `config.working_dir` | `CopilotSdkProvider` | Required existing directory |
| `config.env`, `config.permissions` | `CopilotSdkProvider` | Explicit Copilot credentials and permissions |

Promptfoo's `package:` reference needs the exported class suffix shown above; the npm package name alone is not a provider ID. See the [provider guide](https://github.com/allagentsdev/oh-my-promptfoo/blob/main/docs/provider-guide.md) for source permissions, response metadata, cleanup, caching, and full configuration details.
