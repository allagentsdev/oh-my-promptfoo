# @allagents/oh-my-promptfoo

Run coding-agent evaluations with stock Promptfoo. This package provides two entry points:

If you installed `@allagents/promptfoo-x` or `@allagents/promptfoo-integration`, switch the install name and `package:` provider IDs to `@allagents/oh-my-promptfoo`. Existing workspace caches remain compatible.

| Use case | Promptfoo provider |
| --- | --- |
| Create a private writable workspace, optionally seeded from Git or OCI, then run Codex, Claude, or Copilot in it | `package:@allagents/oh-my-promptfoo:Provider` |
| Run Copilot in an existing directory that you manage | `package:@allagents/oh-my-promptfoo:CopilotSdkProvider` |

`Provider` owns the workspace for each evaluation row. `CopilotSdkProvider` uses your existing directory. Both return results to ordinary Promptfoo assertions; the package does not grade responses.

## Install

Requires Node 22.22+, Linux, macOS, or Windows, and Promptfoo 0.122.x. On Windows, workspace cache locks and process identity require the system Windows PowerShell executable.

```sh
npm install --save-dev promptfoo@0.122.0 @allagents/oh-my-promptfoo
# Add this only if you use Copilot, directly or as a workspace delegate:
npm install --save-dev @github/copilot-sdk@1.0.6
```

Set the credential for the agent you select before running an evaluation. OCI sources also require an ORAS 1.x executable supplied through `ALLAGENTS_ORAS_PATH`.

## Prepare a workspace and run an agent

`Provider` creates a separate writable workspace for each test. `delegate.id` selects the agent; `workspace.sources` places Git or OCI content in that workspace. Use `sources: []` when the agent needs an empty workspace.

```yaml
# promptfooconfig.yaml
prompts: ["{{task}}"]
providers:
  - id: package:@allagents/oh-my-promptfoo:Provider
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
  - id: package:@allagents/oh-my-promptfoo:CopilotSdkProvider
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
| `config.workingDir` | `Provider` | Optional relative directory inside the prepared workspace; defaults to its root |
| `config.fileChanges` | `Provider` | Optional bounded file-change evidence; defaults to `false` |
| `config.working_dir` | `CopilotSdkProvider` | Required existing directory |
| `config.env`, `config.permissions` | `CopilotSdkProvider` | Explicit Copilot credentials and permissions |

Promptfoo's `package:` reference needs the exported class suffix shown above; the npm package name alone is not a provider ID. See the [provider guide](https://github.com/allagentsdev/oh-my-promptfoo/blob/main/docs/provider-guide.md) for source permissions, response metadata, cleanup, caching, and full configuration details.
