# ADR 0012: llmAssert's judge comes from Promptfoo's grading provider

- Status: Accepted; the per-assertion judge amended below ([#102](https://github.com/allagentsdev/oh-my-promptfoo/issues/102))
- Date: 2026-10-22
- Resolves: the first two open differences from `llm-rubric` listed in [ADR 0011](0011-llm-assert-is-batched-llm-rubric.md)

## Context

[ADR 0011](0011-llm-assert-is-batched-llm-rubric.md) made batching the only intended difference between `llmAssert` and `llm-rubric`, and left four differences open. This ADR settles the first two:

- the judge came from the `OPENAI_MODEL`, `OPENAI_API_KEY` and `OPENAI_BASE_URL` environment, not Promptfoo's grading provider or its cache;
- a judge failure that reported no usage threw, so Promptfoo recorded an ERROR row instead of a failed assertion.

The two are linked. The `OPENAI_*` path was a hand-written `fetch` with no retries and no cache, and `fetch` throws on a non-2xx reply, so a single 429 or 500 lost the whole row, including the results of the row's other assertions. It also rewrote an Azure resource root to `/openai/v1` and sent an `api-key` header, so `OPENAI_BASE_URL` meant a different address to `llmAssert` than to Promptfoo's own OpenAI provider.

[#93](https://github.com/allagentsdev/oh-my-promptfoo/issues/93) raised both points. [#99](https://github.com/allagentsdev/oh-my-promptfoo/issues/99) holds the design, the research against Promptfoo 0.124.0 and the maintainer's decisions. The findings that shape the decision:

- `llm-rubric` takes its grader from the assertion's `provider`, then the test's `options.provider`, then `--grader`, then `defaultTest.options.provider`, then a default chosen from the credentials present. `--grader` is written into `defaultTest.options.provider`, and each test's options are merged over it, so a `package:` assertion sees the test, `--grader` and `defaultTest` values already merged in `context.test.options.provider`.
- Promptfoo calls a `package:` assertion function before it merges the assertion's own `provider:`, and does not pass the assertion object. A `provider:` written on an `llmAssert` assertion is invisible to it.
- The default-grader choice (`getDefaultProviders`) and `getGradingProvider` are not exported. `loadApiProvider` is.
- Promptfoo's grading-provider slot rejects arrays, and Promptfoo has no failover between graders.
- When the judge provider returns an error or no output, `llm-rubric` returns a failed result with `metadata.graderError: true` and keeps the row's other results. When the provider throws (no API key, unknown id), it re-throws on purpose, and the row is ERROR.
- A package loaded during an eval gets its own copy of Promptfoo's stateful modules, so `--no-cache` and the config's base path don't reach it ([promptfoo/promptfoo#11918](https://github.com/promptfoo/promptfoo/issues/11918)). `PROMPTFOO_CACHE_ENABLED=false` does, because both copies read it at load.

## Decision

### Precedence

`llmAssert`'s judge is `context.test.options.provider`, which Promptfoo has already resolved, first match wins, from:

1. the test's `options.provider`;
2. `--grader`;
3. `defaultTest.options.provider`;

and with none of them set, a configuration error.

The value is unpacked the way `getGradingProvider` unpacks a text grader: a provider id, a provider object with an `id`, a provider instance, or a `{ text: … }` map. Ids and objects load through the consumer's `promptfoo` peer with its public `loadApiProvider`, the way the delegate runner already loads delegates. An array is rejected with a message that points to `Fallback`.

### No per-assertion judge

`llmAssert` has no per-assertion judge. A `config.provider` on the assertion, or a `provider:` beside its `config:`, throws `llmAssert takes no per-assertion judge: remove provider from this assertion and set the judge in defaultTest.options.provider for the suite, in a test's options.provider, or with --grader for the run`.

This is a deliberate difference from `llm-rubric`, which reads an assertion's `provider:` first. The reasons:

- **One place to read the judge.** Every judge `llmAssert` uses is the value Promptfoo already resolved for the test, the same setting every other model-graded assertion in the suite reads. A reader of the config finds the judge in one of three known places.
- **Promptfoo can't pass `provider:` to package functions.** It calls a `package:` assertion before merging the assertion's `provider:` and does not pass the assertion object. Reading the key from `context.test.assert` doesn't work either: two `llmAssert` entries with the same config can't be told apart, and `defaultTest.assert` entries are merged in.
- **A second spelling would diverge.** A `config.provider` would be an `llmAssert`-only way to name a judge, with its own precedence, that native assertions and `--grader` don't know about.

Both spellings are detected only to reject them, because silently grading with a different judge than the author wrote is worse than failing. A suite that needs a different judge for some criteria puts them in a test with its own `options.provider`.

### `Fallback` is a provider, not a list

oh-my-promptfoo ships `Fallback` (`package:oh-my-promptfoo/providers:Fallback`). Its `config.providers` lists judges in the usual shapes. It calls each one once, in order, and moves to the next only after a retryable failure: HTTP 0, 408, 429 or 5xx, or, without a status, an error message that matches Promptfoo's transient and rate-limit patterns. Any other error stops the chain and is returned, and a thrown error that doesn't match those patterns is re-thrown, so a misconfigured primary stays visible. Each judge keeps its own retries, and the wrapper declares `handlesOwnRetries` so Promptfoo's scheduler doesn't retry the whole chain; one 429 already cost 20 requests under plain `llm-rubric`. A judge that failed retryably is skipped for `max(cooldownMs, Retry-After)` in the same process, with `cooldownMs` defaulting to 30 seconds; `cooldownMs: 0` leaves only the judge's `Retry-After`. The reply carries usage and cost summed over attempts and `metadata.fallback` with the answering judge and every attempt.

A provider goes in the slot Promptfoo already has. It works in `defaultTest.options.provider` and a test's `options.provider` alike, and native `llm-rubric` in the same suite fails over too. A list format would break those `llm-rubric` assertions, which reject arrays, and a list only in `llmAssert`'s config would leave them without failover.

### `OPENAI_*` removed

`llmAssert` no longer reads `OPENAI_MODEL`, `OPENAI_API_KEY` or `OPENAI_BASE_URL`, and the Azure `/openai/v1` rewrite and `api-key` header are gone. Promptfoo's OpenAI provider still reads `OPENAI_BASE_URL` and `OPENAI_API_KEY` as given, so `OPENAI_BASE_URL` now means the same address everywhere. Azure users set the full address, `https://<resource>.openai.azure.com/openai/v1`, and name the deployment as the model, for example `openai:chat:<deployment>`.

### No judge is an error

With nothing configured, `llmAssert` throws `llmAssert has no judge. Set defaultTest.options.provider for the suite, a test's options.provider, or pass --grader.` before any request. Matching `llm-rubric`'s credential-based default would mean copying Promptfoo's rules or importing private files. If Promptfoo exports its default grader, a later minor release can use it with no config change.

### Failures match `llm-rubric`

A judge reply with an error (HTTP errors, a 429 after the provider's retries, timeouts, network failures), an empty reply, or every `Fallback` judge failing becomes a failed result: score 0, the error as the reason, `metadata.graderError: true`, and `tokensUsed` always present, counting at least the requests made. The row's other assertion results are kept. A provider that throws is not caught: the row stays ERROR, as `llm-rubric` re-throws, so misconfiguration is not hidden as FAIL rows and `--retry-errors` still picks it up.

A malformed verdict is retried once, as before, with `bustCache: true` in the call context so the retry doesn't replay the cached bad reply. It then fails with `graderError`.

### Cache unchanged

`llmAssert` uses the judge provider's cache as it is and adds no cache or workaround of its own, the same as `llm-rubric`. Until [promptfoo/promptfoo#11918](https://github.com/promptfoo/promptfoo/issues/11918) is fixed, `--no-cache` doesn't reach the judges `llmAssert` or `Fallback` load, and the docs tell users to set `PROMPTFOO_CACHE_ENABLED=false`. Detecting `--no-cache` from `process.argv` was rejected: it misses programmatic `evaluate({ cache: false })` and wrapper scripts. For the same upstream reason, Promptfoo's `cliState.basePath` doesn't reach the judges `llmAssert` loads. They resolve relative `file://` and `package:` ids from the first of: a caller's explicit base path, such as a `Fallback`'s `config.basePath`; the provider under test's `config.basePath`, which Promptfoo 0.124's `createApiProvider` sets to the eval config's directory on every provider it loads; the project the Promptfoo peer is installed in, the parent of its outermost `node_modules`; and, for a peer linked from outside any `node_modules`, Promptfoo's own default, the working directory. Promptfoo can therefore run from a repository root above the eval project that installed it.

### `agentAssert`

`agentAssert` is out of scope for selection and fallback. Its judge is an explicit agent delegate with workspace access in `config.grader`, and Promptfoo has no grading slot for that. It shares the failure handling: a delegate execution failure (crash, timeout, workspace released mid-grade) is returned as a `graderError` result with secrets redacted from the reason, while config errors and queue timeouts still throw.

## Consequences

- This is breaking for anyone who relied on `OPENAI_*`: a suite with no grading provider now stops with the no-judge error. Name the judge with `defaultTest.options.provider` or `--grader`. Azure users who set a bare resource root must set the full v1 address.
- Judge outages move from ERROR to FAIL. `--retry-errors`, which re-runs ERROR rows only, no longer re-runs them; `--filter-failing <evalId>` does. Missing credentials and bad provider ids stay ERROR. CI that counts ERROR and FAIL separately sees outages move between the counts. The row's other assertion results now survive an outage.
- Judges get Promptfoo's retries, response cache and provider options (temperature, `response_format`, headers, gateways), and token usage and cost come from the provider's response.
- WTG.AI.Prompts migrates in one step after this release ships. It pins the release, and its runner passes `--grader openai:chat:${OPENAI_MODEL}`, so no suite needs a `defaultTest.options.provider` block; a suite that needs a different judge for some tests sets those tests' `options.provider`, and a fallback chain, if ever wanted, goes in `defaultTest` because `--grader` takes only an id. CI sets `OPENAI_BASE_URL` to the full v1 address, which Promptfoo's OpenAI provider reads along with `OPENAI_API_KEY`; the old `llmAssert` adds `/openai/v1` only when the address has no path, so the full address works with both versions. The runner also sets `PROMPTFOO_CACHE_ENABLED=false`, next to its `--no-cache`.

## Alternatives rejected

- **A list in `options.provider`.** Promptfoo throws on arrays, so every native `llm-rubric` sharing that `defaultTest` would break, and `--grader` couldn't express it.
- **A fallback list only in `llmAssert`'s config.** Native model-graded assertions in the same suite would not fail over, and it would have no suite-wide home.
- **Our own same-provider retry loop.** It multiplies the provider's retries.
- **Reading the assertion's `provider:` from `context.test.assert`.** Identical entries can't be told apart, and `defaultTest.assert` entries are merged in.
- **A per-assertion judge in `config.provider`.** It would be a second, `llmAssert`-only spelling with its own precedence that native assertions and `--grader` don't know about, and it would split where a reader looks for the judge.
- **Importing Promptfoo's private `getDefaultProviders` or `getGradingProvider`, or copying their rules.** They are not exported, their chunk names change every release, and copied model ids and credential checks would drift.
- **Reusing `assertions.matchesLlmRubric` with a batched prompt.** It keeps only one `pass`, `score` and `reason`, so the per-component verdicts are lost.
- **Keeping `OPENAI_*` as the no-config default, or deprecating it for a release.** That keeps a second, uncached judge path with no retries, the root cause of the ERROR rows.
- **Turning provider throws into `graderError` as well.** It drifts from upstream and hides misconfiguration as FAIL rows that `--retry-errors` skips.

## Amendment: a per-assertion judge in `config.provider` (2026-10-22)

[#102](https://github.com/allagentsdev/oh-my-promptfoo/issues/102) reverses "No per-assertion judge". Some suites need two judges in one test, for example a second opinion next to the suite's judge, and splitting the test to give each its own `options.provider` duplicates the target call. `llmAssert` now takes an optional `config.provider`, unpacked by the same loader as a suite judge, `Fallback` included.

- **Precedence** is `llm-rubric`'s: the assertion's `config.provider`, then the test's `options.provider`, then `--grader`, then `defaultTest.options.provider`, then the no-judge error. Promptfoo 0.124.0 reads an assertion's `provider:` first (`getFinalTest`: `assertion.provider || test?.options?.provider`), so the assertion beats `--grader` as it does there. For the same reason an empty `config.provider` (`null`, `""`) counts as unset.
- **It lives in `config`** because that is the only part of the assertion Promptfoo passes to a `package:` function; the reasons under "No per-assertion judge" for not reading `provider:` from `context.test.assert` still hold. `provider:` beside `config:` stays a configuration error, and the message now points to `config.provider`.
- **Instances don't survive the trip.** Promptfoo passes `structuredClone(assertion.config)` (`assertions/index.ts` in 0.124.0), which drops a provider instance's methods. Through Promptfoo, `config.provider` is an id, a provider object or a `{ text: … }` map; an instance works only when `llmAssert` is called directly.
- **The judge stays visible.** The result's `metadata.judge` names the judge that graded it (its label, or its id), so a judge set on an assertion shows in the results. The docs keep the suite, test or run as the normal place to name the judge.
- `agentAssert` is unchanged: its judge is the explicit `config.grader` delegate.
