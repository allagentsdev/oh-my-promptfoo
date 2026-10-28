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
npm install --save-dev promptfoo@0.124.1 oh-my-promptfoo
npm install --save-dev @github/copilot-sdk@1.0.22               # only if you use Copilot
npm install --save-dev @earendil-works/pi-coding-agent@1.3.0    # only if you use Pi
```

Add a `promptfooconfig.yaml` next to your `skills` folder:

```yaml
prompts: ["{{task}}"]
providers:
  - id: package:oh-my-promptfoo/providers:Agent
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
covers per-test and per-assertion judges and falling back to another judge
during an outage.

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
  one shows up as its own score. Both rubric assertions default to binary
  scoring; set `config.scoring: graded` for partial credit or thresholds below 1.
- **Grade what the agent did, not what it says it did.** `agentAssert` sends a
  read-only agent into the workspace to check the changes. Turn on
  `fileChanges` to read them in your own JavaScript assertions.
- **Run Copilot in a folder you already have.** `CopilotSdk` runs
  Copilot where you point it, without creating a workspace.
- **Use a Copilot model as a candidate or a judge.** `CopilotModel`
  calls a Copilot model directly, with your `GH_TOKEN` and no API key.

## Providers

Every provider comes from the `oh-my-promptfoo/providers` entry:

| Provider id | What it does |
| --- | --- |
| `package:oh-my-promptfoo/providers:Agent` | Prepares a private workspace per test and runs a coding agent (`delegate`) in it |
| `package:oh-my-promptfoo/providers:CopilotSdk` | Runs Copilot in an existing `working_dir` |
| `package:oh-my-promptfoo/providers:CopilotModel` | Calls a Copilot model over the API Copilot serves it on, as a candidate or a judge |
| `package:oh-my-promptfoo/providers:Fallback` | Tries judges in order and fails over on rate limits and outages |

The assertions are `package:oh-my-promptfoo/assertions:llmAssert` and
`package:oh-my-promptfoo/assertions:agentAssert`. Version 1.22.0 moved the
providers here and dropped their `Provider` suffix; the ids of earlier versions
no longer resolve (see the
[changelog](https://github.com/allagentsdev/oh-my-promptfoo/blob/main/CHANGELOG.md)).

## Copilot conversations

Use Promptfoo's ordinary chat templates with either `CopilotSdk` or `Agent`
delegating to `copilot-sdk`: `{{ messages | dump }}` supplies fixed history,
and a template loop over `_conversation` replays generated turns.
`metadata.conversationId` groups turns; normal assertions grade each new reply.
The provider reads only the rendered prompt, never appending history itself.

One optional leading system message is appended to Copilot's core system
instructions through the public SDK. Other messages retain their labels,
order and strings in a delimited **user-channel JSON transcript**, not native
assistant/tool roles; the delimiters are not a security boundary. Each row
uses a fresh session and, with `Agent`, a fresh workspace. History is supplied
input, not tool-use evidence or persistent filesystem state.

See the [two-provider example](examples/copilot-conversations/promptfooconfig.yaml)
and [supported messages and limitations](docs/provider-guide.md#promptfoo-conversations-with-copilot).

## Local MCP fixtures

Copilot and Claude candidates can call suite-authored Node MCP servers staged in
their workspace. Configure `delegate.config.mcpServers` (stdio only):

```yaml
delegate:
  id: copilot-sdk # or anthropic:claude-agent-sdk
  config:
    mcpServers:
      github:
        path: .eval-mocks/github-mcp.mjs
        args: ["--fixture", "canned"]
        env: { MOCK_MODE: canned }
        tools: [search_code]
        timeoutMs: 30000
workspace:
  sources:
    - type: local
      path: ./mocks
      destination: .eval-mocks
      permissions: read-only
```

Only normalized workspace-relative files are accepted; symlink escapes and host
executables are rejected. The server receives **only** its literal `env`, never
host/delegate credentials, `HOME`, or `PATH`. Tools default to all; `[]` permits
none. Timeouts terminate the server, and abort/completion tears down its Node
child and private configuration. Contained MCP tools use explicit server config;
graders cannot configure servers. Claude candidates can opt into native settings
and plugin discovery through `delegate.config`. This is not an OS or network
sandbox: the trusted Node fixture itself can access the host and network.

See the [runnable two-delegate example](examples/mcp/promptfooconfig.yaml) and
[configuration details](docs/provider-guide.md#local-mcp-servers).

Codex and Claude candidate `delegate.config` options pass through to Promptfoo,
except workspace, session-reuse and CLI-environment keys owned by this provider.
Copilot, Pi and read-only graders keep closed option lists. See the
[native config rules](docs/provider-guide.md#workspace-provider-configuration).

## Copilot models without an agent

`package:oh-my-promptfoo/providers:CopilotModel` sends a prompt
straight to a Copilot model: no workspace, tools or
agent loop. Use it as an LLM candidate, or as the judge for `llmAssert` and
`llm-rubric`. It needs `@github/copilot-sdk@1.0.22` installed and `GH_TOKEN`
exported, and it does not run on Windows.

```yaml
providers:
  - id: package:oh-my-promptfoo/providers:CopilotModel
    label: gpt-5.6-sol
    config:
      model: gpt-5.6-sol           # required, exactly as Copilot lists it
      reasoning_effort: medium     # optional: low, medium or high
      max_tokens: 32000            # optional; defaults to the model's output limit
defaultTest:
  options:
    provider:
      id: package:oh-my-promptfoo/providers:CopilotModel
      config:
        model: gpt-6-sol
        reasoning_effort: low
        response_format: { type: json_object }   # optional; the only accepted format
```

Those four keys are the whole config. The endpoint and credentials always come
from Copilot: a private Copilot SDK process signs in with `GH_TOKEN` (never your
stored logins or `OPENAI_*`, `ANTHROPIC_*` or `AZURE_*` settings), asks Copilot for
the model's endpoint and short-lived credentials, and refreshes them before they
expire. Promptfoo's own provider for the API Copilot serves the model on then
makes the request, so usage counting and cancellation work as usual:

| Copilot serves the model over | Promptfoo provider | Request path | `metadata.copilotEndpoint` |
| --- | --- | --- | --- |
| OpenAI Responses (GPT, Codex, Grok, MAI) | `openai:responses` | `/responses` | `responses` |
| OpenAI Chat Completions (kimi-k3) | `openai:chat` | `/chat/completions` | `chat/completions` |
| Anthropic Messages (Claude) | `anthropic:messages` | `/v1/messages` | `messages` |

Any other endpoint Copilot reports, such as another API or a WebSocket
transport, fails the call with an error that names it. The settings reach each
API in its own shape:

- `reasoning_effort` is the Responses `reasoning.effort` and the Chat Completions
  `reasoning_effort`. For Claude it turns on adaptive thinking at that effort, but
  only when Copilot's model list says the model takes a reasoning effort (and
  that level, when it lists levels); otherwise the call fails and names the model.
- `response_format: { type: json_object }` works on Responses and Chat
  Completions. The Anthropic Messages API has no JSON-object mode, so a Claude
  model with `response_format` fails and names the model.
- `max_tokens` caps each reply's output tokens: the Responses
  `max_output_tokens`, the Chat Completions `max_tokens` (or
  `max_completion_tokens` for models Promptfoo treats as reasoning models) and
  the Messages `max_tokens`. Without it, the cap is the model's
  `capabilities.limits.max_output_tokens` from Copilot's model list, so long
  answers are not cut off at Promptfoo's default of 1024 (2048 for Claude
  thinking models). When the list reports no limit, Promptfoo's default
  applies. The cap in force is in `metadata.copilotMaxOutputTokens`.
  `OPENAI_MAX_TOKENS`, `OPENAI_MAX_COMPLETION_TOKENS` and
  `ANTHROPIC_MAX_TOKENS` never override it.
- No request carries a `temperature`, so each model uses its own default.
  Promptfoo's default of 0 and `OPENAI_TEMPERATURE` or `ANTHROPIC_TEMPERATURE`
  are not sent; some models, such as Claude Opus 4.7 and later, reject them.
- Messages requests stream, because the Anthropic SDK refuses a
  non-streaming request with a large `max_tokens`.
- Claude replies contain only the answer, not its thinking.

Every instance in a run shares that one SDK process. The provider id is
`copilot:<model>` on every API (before 1.22.0 it also named the Responses API),
and an unlabeled judge appears under that id in `llmAssert`'s `metadata.judge`.
Neither the id nor the serialized provider contains credentials.

Replies have no `cost`, because Promptfoo would price them at OpenAI's or
Anthropic's list rates, which is not what Copilot bills. Each reply names the
API that served it in `metadata.copilotEndpoint`, and when Copilot's model list
reports prices for the model, carries them in `metadata.copilotTokenPrices`:

```json
{
  "model": "gpt-6-sol",
  "batchSize": 1000000,
  "default": { "inputPrice": 200, "cacheReadPrice": 20, "cacheWritePrice": 250, "outputPrice": 1000, "maxPromptTokens": 272000 },
  "longContext": { "inputPrice": 400, "cacheReadPrice": 40, "cacheWritePrice": 500, "outputPrice": 1500, "maxPromptTokens": 872000 }
}
```

These are the model's `billing.tokenPrices` from the SDK's `listModels()`,
copied as reported: prices per `batchSize` tokens, with `default` from the top
level and `longContext` from its long-context tier when there is one. Only
numeric fields are copied, and nothing is converted or summed into a cost. When
Copilot reports no prices, or the model list can't be read, replies still
succeed without the field.

`tokenUsage.prompt` counts every input token, cache reads and writes included,
on all three APIs. Prompt-cache reads and writes are in
`tokenUsage.completionDetails.cacheReadInputTokens` and `cacheCreationInputTokens`
when the API reports them; `tokenUsage.cached` instead counts a reply served from
Promptfoo's own response cache. To turn these prices and token counts, or
Copilot's reported session usage, into dollars, see the
[Copilot cost methodology](https://github.com/allagentsdev/oh-my-promptfoo/blob/main/docs/copilot-cost-methodology.md).

To read Copilot's model list or endpoint yourself, `createCopilotEndpointClient()`
from `oh-my-promptfoo/providers` starts the same private SDK process and returns
`models()`, `endpoint(model)` and `close()`.

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
- [Copilot cost methodology](https://github.com/allagentsdev/oh-my-promptfoo/blob/main/docs/copilot-cost-methodology.md): how
  Copilot's reported session usage and token prices become US dollars, and how to
  total them
- [Examples](https://github.com/allagentsdev/oh-my-promptfoo/tree/main/examples): complete Promptfoo configs
- [Architecture decisions](https://github.com/allagentsdev/oh-my-promptfoo/tree/main/docs/adr): why things work the way they do
- [Changelog](https://github.com/allagentsdev/oh-my-promptfoo/blob/main/CHANGELOG.md)
