# Grading guide

oh-my-promptfoo ships two Promptfoo assertions. `llmAssert` is Promptfoo's
`llm-rubric` batched: one judge request scores many named criteria, and each
criterion gets its own score in the results. `agentAssert` uses the same
criteria format, but a read-only agent judge inspects the test's workspace,
so it can grade what the agent changed rather than what it said.

Both are referenced as JavaScript assertions:
`package:oh-my-promptfoo/assertions:llmAssert` and
`package:oh-my-promptfoo/assertions:agentAssert`. `llmAssert` grades with the
judge you name in Promptfoo's provider config, the same settings `llm-rubric`
reads; [Choosing llmAssert's judge](#choosing-llmasserts-judge) shows how.

## Choosing llmAssert's judge

### No judge configured

```yaml
assert:
  - type: javascript
    value: package:oh-my-promptfoo/assertions:llmAssert
    config:
      components:
        - metric: names-the-file
          value: The answer names the file to change.
```

With no judge set anywhere, `llmAssert` stops before it sends any request, and
the row is an ERROR:

> llmAssert has no judge. Set defaultTest.options.provider for the suite, a
> test's options.provider, or pass --grader.

`llm-rubric` instead picks a default grader from whatever credentials are
present. Promptfoo doesn't export that choice to packages yet. If it does,
`llmAssert` can use it in a later minor release with no config change.

### One judge for the suite

Write it where `llm-rubric` reads it. Every `llmAssert` and every model-graded
Promptfoo assertion in the suite uses it:

```yaml
defaultTest:
  options:
    provider:
      id: openai:chat:gpt-6-sol
      config:
        temperature: 0
        response_format: { type: json_object }
```

### One judge for a test

A test's own `options.provider` replaces the suite's judge for that test, as it
does in Promptfoo:

```yaml
tests:
  - vars: { task: Explain the failing build. }
    options:
      provider: anthropic:messages:claude-sonnet-5
```

### One assertion, different judge

Name the judge for the suite, the test or the run, as above: one judge per
suite keeps it in a single place a reader can find. When one assertion really
needs its own judge, for example a second opinion beside the suite's judge in
the same test, put it in that assertion's `config.provider`:

```yaml
- type: javascript
  value: package:oh-my-promptfoo/assertions:llmAssert
  config:
    provider: anthropic:messages:claude-sonnet-5
    components: [...]
```

It takes an id, a provider object or a `{ text: … }` map, including a
`FallbackProvider` chain, and it beats the test's `options.provider`,
`--grader` and `defaultTest.options.provider`, the way an assertion's
`provider:` does for `llm-rubric`. An empty value (`provider:` with nothing
after it, or `""`) counts as unset, as it does for `llm-rubric`. A provider
instance works only when you call `llmAssert` yourself: Promptfoo copies an
assertion's `config` with `structuredClone` before a package function sees it,
which drops the instance's methods. It lives in `config` because Promptfoo
doesn't pass an assertion's own `provider:` to package functions. Writing
`provider:` beside `config:` on an `llmAssert` assertion is a configuration
error, and the row is an ERROR:

> llmAssert does not see provider: beside config: (Promptfoo does not pass it
> to package assertions): move it into this assertion's config.provider, or
> set the judge for the suite in defaultTest.options.provider, for a test in
> its options.provider, or for the run with --grader

### A fallback chain

`FallbackProvider` tries judges in order and moves to the next one only after a
retryable failure such as a rate limit or an outage. It is an ordinary provider,
so it goes anywhere a judge goes, and native `llm-rubric` in the same suite uses
it too:

```yaml
defaultTest:
  options:
    provider:
      id: package:oh-my-promptfoo/providers:FallbackProvider
      config:
        providers:                      # tried in order
          - id: openai:chat:gpt-6-sol
            label: primary
            config:
              maxRetries: 1             # fail over fast instead of backing off
          - id: azure:chat:my-deployment
            config: { maxRetries: 1 }
          - anthropic:messages:claude-sonnet-5
        cooldownMs: 30000               # optional, the default
```

Each entry in `providers` is written the way you'd write a single judge: an id,
a provider object, or a `{ text: … }` map. Promptfoo's OpenAI provider already
retries a 429 or a timeout with exponential backoff (`maxRetries`, default 4,
starting from `PROMPTFOO_REQUEST_BACKOFF_MS`, 5 seconds), which can hold a row
for over a minute before the chain moves on. `maxRetries: 1` on the judges in a
chain fails over in seconds.

### From the command line

```sh
promptfoo eval -c suite.yaml --grader openai:chat:gpt-6-sol
```

`--grader` replaces `defaultTest.options.provider`, including a fallback chain.
It does not replace a test's `options.provider` or an assertion's
`config.provider`, which is how it behaves for `llm-rubric`. It takes only an
id, so a chain has to go in `defaultTest`.

### Where the judge comes from

The first match wins:

| # | Where | Same as `llm-rubric`? |
| --- | --- | --- |
| 1 | the assertion's `config.provider` | Yes, but in `config`: `llm-rubric` reads the assertion's `provider:` |
| 2 | the test's `options.provider` | Yes |
| 3 | `--grader` | Yes |
| 4 | `defaultTest.options.provider` | Yes |
| — | nothing set: configuration error | No: `llm-rubric` falls back to a credential-based default |

`metadata.judge` in the result names the judge that graded it: its label, or
its id.

A judge can be written in the shapes Promptfoo accepts for a grader:

- a provider id such as `openai:chat:gpt-6-sol`;
- a provider object with an `id`, plus `config`, `label` and `env` as needed;
- a provider instance, used as it is;
- a `{ text: … }` map, of which `llmAssert` uses `text`.

A list of judges is rejected with a message that points to `FallbackProvider`.
Promptfoo rejects lists here too, so a list would also break every
`llm-rubric` that shares the setting. Promptfoo renders `{{ env.NAME }}`
templates in the id and config before `llmAssert` sees them.
See [ADR 0012](adr/0012-llm-assert-judge-from-promptfoo-grading-provider.md)
for why the judge works this way.

### Fallback rules

- **When it moves on.** The judge returned an error with HTTP status 408, 429,
  any 5xx, or 0 (Promptfoo's code for network failures and timeouts). A 429
  counts whether it is a rate limit or an exhausted quota, because the next
  judge is usually a different account. For a provider that attaches no HTTP
  status, the error is classified the way Promptfoo classifies it: broken
  pipes and connection resets (by error code too), timeouts, refused
  connections, socket hang-ups, transient TLS errors (but not certificate or
  protocol-version failures, which are permanent), network errors,
  502/503/504, 429 and rate-limit or quota messages move on.
- **When it stops.** On a good reply, or on any other error (400, 401, 403,
  404, 422, a content filter), which it returns as the answer. A misconfigured
  primary should be visible, not quietly covered by the next judge. A judge
  that throws (missing credentials, unknown id) is re-thrown, unless its
  error is one of the transient errors above. A cancelled evaluation is
  re-thrown too: it never moves on to the next judge or cools a judge down.
- **Retries.** Each judge is called once per request and keeps its own
  retries, so attempts don't multiply. `FallbackProvider` declares
  `handlesOwnRetries`, so Promptfoo's scheduler doesn't re-run the whole chain
  either.
- **Cooldown.** A judge that failed retryably is skipped by later requests in
  the same process for `cooldownMs` (default 30,000 ms) or for the judge's
  `Retry-After`, whichever is longer, so `cooldownMs: 0` leaves only the
  `Retry-After`. Without this, every row in a rate-limit storm would wait
  through the primary's backoff first. A cooldown belongs to that judge as
  configured, including its environment, so the same provider id under another
  account or another provider instance is not skipped. If every judge is
  cooling down, it tries the one whose cooldown ends first. A success clears
  that judge's cooldown.
- **Result.** The answering judge's reply, with token usage and cost summed
  over every attempt, and `metadata.fallback`: `answeredBy` (the judge's label,
  or its id) and `attempts`, one `{ provider, status, error, cached,
  latencyMs }` per judge tried. `llmAssert` copies it into its result
  metadata. If every judge fails, the error lists each one, for example
  `All 3 judges failed: primary: …; …`, and says how many were skipped while
  cooling down.

### When the judge fails

`llmAssert` reports judge failures the way `llm-rubric` does:

| What happens | Result |
| --- | --- |
| The judge returns an error: an HTTP error, a 429 after its own retries, a timeout or a network failure | FAIL: score 0, the error as the reason, `metadata.graderError: true`. The row's other assertion results are kept |
| The judge returns an empty reply | FAIL with `graderError`, as above |
| Every judge in a `FallbackProvider` chain fails | FAIL with `graderError`; the reason lists each attempt |
| The verdict can't be parsed | One retry that bypasses the cache, then FAIL with `graderError` |
| The judge's provider throws, for example no API key or an unknown provider id | Row ERROR, as for `llm-rubric` |
| No judge configured, `provider:` beside `config:`, a list of judges, or invalid `llmAssert` config | Row ERROR |

A throw stays an ERROR on purpose: missing credentials affect every row and
should not pass for ordinary failed grades.

### Re-running after a judge outage

`--retry-errors` re-runs ERROR rows only. Judge outages (HTTP errors, 429s,
timeouts, empty replies) are now FAIL rows, so `--retry-errors` skips them.
Re-run them with `--filter-failing <evalId>`, which takes failures and errors.
Both re-run the target as well as the judge, as they do for `llm-rubric`.
Missing credentials and bad provider ids are still ERROR, so `--retry-errors`
still picks those up once the environment is fixed. CI that counts ERROR and
FAIL separately will see judge outages move from one count to the other.

### Token usage

`llmAssert` reports the judge's token usage back to Promptfoo, which records it
under `tokenUsage.assertions`: grader spend, separate from the agent under
test. `tokensUsed` adds up every judge call the assertion made, including each
`FallbackProvider` attempt and the malformed-verdict retry, and `cost` is the
sum of the costs the provider reported. `numRequests` counts the calls
`llmAssert` and `FallbackProvider` sent; a provider's own transport retries are
not visible, the same limit `llm-rubric` has. A failed grade always carries
`tokensUsed`, counting the requests made even when the judge measured nothing.
A graded result from a judge that reports no usage reports nothing rather than
zero, so an unmeasured call is never summed into a run total as a free one.
When the verdict came from the provider's cache, the cached reply counts no new
request and the result carries `metadata.cachedResponse: true`.

### Caching

`llmAssert` uses the judge provider's cache as it is and adds none of its own,
as `llm-rubric` does. Promptfoo's built-in providers cache successful replies,
so the same judge, prompt and answer replay the earlier verdict. Errors are not
cached, so after an outage the next run starts at the primary judge again. The
malformed-verdict retry passes `bustCache: true`, so it doesn't replay the bad
reply.

`--no-cache` does not reach package code yet
([promptfoo/promptfoo#11918](https://github.com/promptfoo/promptfoo/issues/11918)):
a package loaded during an eval gets its own copy of Promptfoo's cache state,
and the flag only turns off the CLI's copy. That includes the judges inside a
`FallbackProvider`. Set `PROMPTFOO_CACHE_ENABLED=false` in the environment
instead, which both copies read.

### Relative `file://` judges

`llmAssert` loads its judge itself, so a relative `file://` judge resolves from
the working directory, not the eval config's directory, for the same reason:
the config's base path doesn't reach package code. That includes the inner
judges of a `FallbackProvider` that `llmAssert` loads. When native
`llm-rubric` uses the same setting, Promptfoo loads it and passes the base
path, so there it resolves against the config. Use an absolute path, or run
`promptfoo` from the config's directory.

### Azure OpenAI

Promptfoo's OpenAI provider reads `OPENAI_BASE_URL` and `OPENAI_API_KEY` from
the environment and uses the address as given. For an Azure OpenAI v1
endpoint, set the full address and name the deployment as the model:

```sh
export OPENAI_BASE_URL=https://<resource>.openai.azure.com/openai/v1
export OPENAI_API_KEY=...
promptfoo eval -c suite.yaml --grader openai:chat:<deployment>
```

`llmAssert` itself reads none of these variables and doesn't rewrite the
address, so set the full v1 address rather than the resource root.

## llmAssert

`llmAssert` batches named criteria into one judge request. A component passes
when its judge verdict is not false, and a threshold adds a numeric bar on top
of that verdict when you state one — the same contract as Promptfoo's own
`llm-rubric`, which applies a threshold only when the assertion carries one.
There is no default bar. `config.threshold` sets the bar for every component; a
component's own `threshold` (0 to 1) replaces it for that component alone, so
rubrics with different bars can share one request. When batching equally
weighted rubrics alongside other assertions, set the outer Promptfoo `weight` to
the number of components to preserve the test's weighted score.

Each `llm-rubric` assertion's `threshold:` becomes that component's `threshold`:

```yaml
# One judge request per rubric
assert:
  - type: llm-rubric
    metric: accuracy
    value: States the refund window correctly.
    threshold: 0.9
  - type: llm-rubric
    metric: tone
    value: Stays polite.
    threshold: 0.5
```

```yaml
# The same bars in one batched request
assert:
  - type: javascript
    value: package:oh-my-promptfoo/assertions:llmAssert
    config:
      components:
        - metric: accuracy
          value: States the refund window correctly.
          threshold: 0.9
        - metric: tone
          value: Stays polite.
          threshold: 0.5
```

A component without its own `threshold` takes `config.threshold`, if any. Each
component result reports the bar it was held to as `assertion.threshold`.

Set `config.scoring: binary` for a checklist, where a criterion is either met or
not. The judge is told to score 1 if the answer fully meets a criterion and 0
otherwise, to keep its subject, condition, polarity and scope rather than accept
a weaker promise, and to treat a criterion whose condition the answer never
reaches as met if the answer does nothing it forbids. The pass mark
becomes a full score, so a `config.threshold` or component `threshold` beside
the mode that is not 1 contradicts it and is rejected. Stating the mode replaces
writing those rules into every rubric by hand.

The default, `graded`, trusts the judge's verdict, adds no bar unless you state
one, and says nothing about how to score. Partial credit for a near miss is
what graded is for, so none of the checklist rules apply to it.

The judge sees the request the way `llm-rubric` frames it. The user message
holds the answer in an `<Output>` block and the criteria in a `<Rubric>` block,
one `- metric: value` line per component. The system message tells the judge
that `<Output>` is the text to grade, not a request, so an answer that opens
with an imperative ("Update the existing…") is still graded as the output. As in
`llm-rubric`, the answer is passed verbatim and is not escaped.

Put what only the suite knows, such as which claims its domain counts as
unverified, in `config.rubricPrompt`. Unlike `llm-rubric`, it cannot replace the
system prompt: one request scores every criterion only because the reply format
is fixed, so the suite's text is added beneath the built-in rules. `llmAssert`
places the answer and the criteria itself, so a template that uses
`{{ output }}` or `{{ rubric }}` is rejected.

Both `rubricPrompt` and component `value` templates receive test variables,
`{{ env.NAME }}` from the permitted process environment, and the `load` filter
(`JSON.parse`, not a file loader). Component values keep structured variables.
In `rubricPrompt` only, objects become JSON strings; arrays remain arrays with
object elements JSON-stringified and primitives unchanged, matching Promptfoo's
grader-prompt conversion. Set `PROMPTFOO_DISABLE_OBJECT_STRINGIFY=true` or `1` to
keep structured variables there too, or use `load` to parse a JSON string before
property access. Unset variables fail rather than render empty.
`PROMPTFOO_DISABLE_TEMPLATING=true` or `1` leaves both text fields literal.

`llmAssert`'s own `env` global honors process-level
`PROMPTFOO_DISABLE_TEMPLATE_ENV_VARS`, defaulting to disabled with
`PROMPTFOO_SELF_HOSTED` (an empty disable flag also uses that default).
It does not read private config-level or async environment overrides or custom
`nunjucksFilters`. Separately, Promptfoo's config-load pass can already render
`{{ env.NAME }}` using merged config `env:` before this assertion receives it;
these pre-rendered values are not controlled by `llmAssert`'s rendering flags.
Only assertion `config.rubricPrompt` is read, never `options.rubricPrompt`.
Share inline guidance with YAML anchors (`rubricPrompt: &guidance |` at its
first definition, `rubricPrompt: *guidance` on later assertions). A `file://`
reference that reaches `llmAssert` fails with a missing-config-directory error:
script contexts expose no config directory, and it never guesses from `cwd`.
For tests loaded through `tests: file://*.yaml` (also JSON/JSONL), Promptfoo can
inline nested `config.rubricPrompt` and component `value` file references from
its base path before the assertion runs. Loaded strings follow normal template
checks; parsed JSON/YAML objects or arrays are not string templates and fail
type validation. The assertion cannot identify their original file path.
See [ADR 0006](adr/0006-llm-assert-rubric-prompt.md) for upstream sources
and deliberate differences from Promptfoo's grader defaults, and
[ADR 0011](adr/0011-llm-assert-is-batched-llm-rubric.md) for what parity with
`llm-rubric` means and why batching is the one intended difference.

Its token usage, caching and failure handling are described under
[Choosing llmAssert's judge](#choosing-llmasserts-judge).

As `llm-rubric` does, a graded result carries `metadata.renderedGradingPrompt`:
the messages exactly as the judge received them. Check it first when a grade
looks wrong, for example when the judge says the answer is missing. A judge
failure returned as a result is marked `metadata.graderError: true`.

## Grading an agent's answer

`llmAssert` sees only the final answer, never the agent's tool calls, commands
or workspace, and it adds no rule of its own about narrated work. When the
answer comes from an agent, state that rule in the suite's `rubricPrompt`,
where anyone reading the config can see it:

```yaml
assert:
  - type: javascript
    value: package:oh-my-promptfoo/assertions:llmAssert
    config:
      rubricPrompt: |
        Credit only what the answer shows, not claimed actions (tool calls, commands, file reads or edits, builds, tests, queries).
      components:
        - metric: root-cause
          value: The answer names the missing null check in parsePrice as the cause.
```

Leave the rule out when narrated actions are the expected output, such as a
support bot replying "I've cancelled your order". To grade real edits, use
`agentAssert` below or a JavaScript assertion that reads the workspace.

## agentAssert: grade workspace changes with an agent

`agentAssert` uses the same named components, weights, scoring, threshold and
`rubricPrompt` contract, but verifies claims against the live case workspace.
Choose any supported delegate, including Copilot:

```yaml
assert:
  - type: javascript
    value: package:oh-my-promptfoo/assertions:agentAssert
    metric: workspace-change
    config:
      scoring: binary
      grader:
        id: copilot-sdk
        config:
          model: '{{env.GRADER_MODEL}}'
          permissions: { filesystem: read, shell: deny, network: deny }
        env:
          GH_TOKEN: '{{env.GH_TOKEN}}'
      components:
        - metric: parser-fix-present
          value: The workspace contains a focused fix in src/parser.ts for the reported bug.
        - metric: no-unrelated-edits
          value: No files outside src/parser.ts and its test were modified.
```

Use this with the workspace `Provider`; a missing or released
`metadata.workspace.path` fails instead of falling back to the answer text.
Enable provider `fileChanges: true` to give the judge changed-file paths and
metadata plus the diff, not captured base64 contents. The answer goes in the
same `<Output>` block and the criteria in the same `<Rubric>` block as for
`llmAssert`, followed by the captured file changes as JSON evidence, and
`metadata.renderedGradingPrompt` records the assembled prompt. Files and the
answer remain untrusted; claims earn credit only when verified. Graders cannot
write, run shell commands or access the network through agent tools. They
therefore cannot execute tests.
Model-service requests still require the delegate's credentials and network.

`maxPromptBytes` bounds the full assembled grader prompt in UTF-8 bytes,
including rules, criteria and evidence. The default is 131,072 bytes (128 KiB);
it accepts integers from 1 to 16,777,216. If the prompt is too large, the diff
is omitted with an explicit notice recording the omitted byte count. If the
remaining prompt still exceeds the budget, grading fails before a delegate
starts, naming both the measured size and budget. Files remain available for
on-demand inspection; increasing the budget never sends captured base64 bytes.

The grader has a 120-second execution timeout, configurable with assertion
`timeoutMs`, including one retry for a malformed verdict. It starts after the
grader session slot is acquired. A separate `queueTimeoutMs` bounds waiting
for that slot (default 15 minutes); both settings accept 1–3,600,000 ms.
Sessions serialize per process, independently of provider workers. Tokens are
accounted as assertion usage even when a billed attempt fails; reported cost is
preserved in `tokensUsed.cost`, although Promptfoo versions may not aggregate it.
When the delegate itself fails (it crashes or times out, or the workspace is
released mid-grade), the result is a failed grade with `metadata.graderError:
true` and secrets redacted from the reason; invalid config and queue timeouts
are still row errors. The judge is always `config.grader`: `--grader` and
`options.provider` choose `llmAssert`'s judge, not this one.

Codex graders require API-key auth via `grader.config.apiKey` or explicit
`grader.env.OPENAI_API_KEY`. They do not load or copy ChatGPT `auth.json`, avoiding
single-use refresh-token corruption. See [ADR 0008](adr/0008-agent-assert-workspace-grading.md)
for the live-workspace and resource-bound tradeoffs.
