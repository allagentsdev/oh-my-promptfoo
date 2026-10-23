# Copilot cost methodology

How to turn what oh-my-promptfoo records about Copilot calls into US dollars.
Copilot replies carry one of two kinds of cost evidence:

- **Reported session usage**: Copilot's own figure for an SDK session.
- **Token-price estimate**: tokens priced at the per-token rates Copilot reports for
  the model, used when no session exists.

A consumer can add both, together with native Promptfoo USD costs, into one
total. This page defines the units, both calculations and the rules for totals.

The package exports this evidence. It converts complete reported session usage to
USD (below) but never prices tokens or adds amounts across calls; the token-price
rule and the totals are consumer methodology.

## Units

Copilot bills in GitHub AI Credits.

| Unit | Value |
| --- | --- |
| 1 AI credit | $0.01 USD ([GitHub](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing)) |
| 1 AI credit | 1,000,000,000 nano-AIU |
| 1 USD | 100,000,000,000 nano-AIU |

Premium-request multipliers are not money. `totalPremiumRequestCost`,
`metadata.copilot.premiumRequestUsage` and the SDK model list's
`billing.multiplier` count requests weighted by model multipliers. They are never
converted to dollars or added to a cost.

## Reported session usage

These calls run in a Copilot SDK session:

- `CopilotSdk`
- the workspace `Agent` with the `copilot-sdk` delegate
- `agentAssert` with a Copilot grader
- `llmAssert` and `Fallback` whose judges are Copilot SDK sessions

After the session settles, the runner reads the session's
`session.rpc.usage.getMetrics` snapshot and records it at
`metadata.copilot.accounting`
([`delegate-runner.ts`](../packages/oh-my-promptfoo/src/delegate-runner.ts),
[`copilot-accounting.ts`](../packages/oh-my-promptfoo/src/copilot-accounting.ts)):

```json
{
  "version": 1,
  "source": "session.rpc.usage.getMetrics",
  "scope": "session",
  "unit": "nano-AIU",
  "status": "complete",
  "totalNanoAiu": 12890540000
}
```

Only a record with all five identifying fields and `status: "complete"` has a
dollar value:

$$\text{USD} = \frac{\texttt{totalNanoAiu}}{10^{11}}$$

The example is $0.1289054. The provider sets generic `response.cost` to this value
only for complete records. `partial` (a valid total from a failed, cancelled or
rejected execution) and `unavailable` (no valid total, with a `reason`) have no
dollar value: treat them as unavailable, never as zero. A reported zero is a real
zero. The full schema and its limits are in
[Copilot runtime accounting v1](provider-guide.md#copilot-runtime-accounting-v1).

### Judge ledgers

`llmAssert`, `agentAssert` and `Fallback` can call more than one judge, or
the same judge twice. They record every leaf call in `metadata.judgeAccounting`
([`judge-accounting.ts`](../packages/oh-my-promptfoo/src/judge-accounting.ts)):

```ts
type JudgeAccounting = {
  version: 1;
  attempts: Array<{ cached: boolean; accounting?: CopilotAccounting }>;
  copilotAccountingSeen?: true;
};
```

Rules for reading the ledger:

- It is authoritative. Do not also add the final reply's
  `metadata.copilot.accounting`; nested ledgers are flattened to their leaves.
- A `cached: true` leaf was served from Promptfoo's cache. It is evidence and
  adds nothing.
- The ledger has a Copilot total only when every uncached leaf has a complete
  record. The total is the sum of their `totalNanoAiu` divided by $10^{11}$.
- An uncached leaf with a missing, partial, unavailable or invalid record makes
  the total unavailable. So does a leaf with no Copilot accounting mixed in with
  Copilot leaves.
- `copilotAccountingSeen: true` means that Copilot leaves were discarded when the
  ledger reached its 1,024-leaf limit. The ledger is then a single unknown leaf,
  and its total is unavailable.

`llmAssert` and `agentAssert` report that total, when it exists, as
`tokensUsed.cost`; `Fallback` reports it as `cost`. A ledger with only
non-Copilot leaves reports the sum of their native costs instead, and only when
every uncached leaf reported one. See
[Judge accounting v1](grading-guide.md#judge-accounting-v1).

## Token-price estimate

`CopilotModel` calls a Copilot model directly, without a session, so there is no
reported usage. It sends the request through Promptfoo's native provider for the
API Copilot serves the model on, and names that API in `metadata.copilotEndpoint`:

| Copilot endpoint | `metadata.copilotEndpoint` | Promptfoo provider | Models (measured) |
| --- | --- | --- | --- |
| `type: openai`, `wireApi: responses` | `responses` | `openai:responses` | GPT, Codex, Grok, MAI |
| `type: openai`, `wireApi: completions` | `chat/completions` | `openai:chat` | kimi-k3 |
| `type: anthropic` | `messages` | `anthropic:messages` | Claude |

Those providers would price the reply at OpenAI or Anthropic list prices, which is
not Copilot billing. `CopilotModel` removes that `cost` on every API and instead
attaches the model's prices as `metadata.copilotTokenPrices`
([`copilot-model.ts`](../packages/oh-my-promptfoo/src/copilot-model.ts)):

```json
{
  "model": "gpt-6-sol",
  "batchSize": 1000000,
  "default": { "inputPrice": 200, "cacheReadPrice": 20, "cacheWritePrice": 250, "outputPrice": 1000, "maxPromptTokens": 272000 },
  "longContext": { "inputPrice": 400, "cacheReadPrice": 40, "cacheWritePrice": 500, "outputPrice": 1500, "maxPromptTokens": 872000 }
}
```

The prices are copied from `billing.tokenPrices` in the Copilot SDK's model list:
AI credits per `batchSize` tokens. The field is experimental in
`@github/copilot-sdk` 1.0.22. Only numeric fields are copied, and the field is
absent when Copilot reports no prices. The example matches GitHub's
[published prices](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing)
for GPT-6 Sol: $2.00 input, $0.20 cached input, $2.50 cache write and $10.00
output per 1M tokens.

When `llmAssert` uses this provider as its judge, the reply's metadata, including
`copilotTokenPrices`, is copied to the assertion's metadata. The judge ledger
records a leaf without Copilot accounting, so the assertion has no scalar cost.

### Token usage per endpoint

On every endpoint, `tokenUsage.prompt` counts all input tokens, cache reads and
writes included, and `tokenUsage.completion` the output tokens. Prompt-cache reads
and writes are in `tokenUsage.completionDetails` when the API reports them:

| `copilotEndpoint` | `prompt` | `cacheReadInputTokens` | `cacheCreationInputTokens` |
| --- | --- | --- | --- |
| `responses` | `input_tokens` | `input_tokens_details.cached_tokens`, zero included | `input_tokens_details.cache_write_tokens` |
| `chat/completions` | `prompt_tokens` | `prompt_tokens_details.cached_tokens` when non-zero | `prompt_tokens_details.cache_write_tokens` or `cache_write_input_tokens` |
| `messages` | `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens` | `cache_read_input_tokens` | `cache_creation_input_tokens` |

Promptfoo 0.124.1 maps these itself, except that it omits a zero Responses cache
read; `CopilotModel` copies the reported count from
`response.raw.usage.input_tokens_details.cached_tokens`. The Anthropic Messages
API reports uncached input separately (`input_tokens`), and Promptfoo adds both
cache counts into `prompt` so that `prompt` means the same on every endpoint; when
either is reported, `completionDetails` has both. A count that is absent was not
reported, or (Chat Completions reads) was zero.

`tokenUsage.cached` means something else: the reply was served from Promptfoo's
response cache, and `cached` equals its total tokens. Such a reply
(`response.cached: true`) is not a new request and adds no cost.

### Formula

For one reply, or one assertion's summed judge usage, take `prompt` and
`completion`, the cache reads $R$ (`cacheReadInputTokens`, 0 when absent) and, when
reported, the cache writes $W$ (`cacheCreationInputTokens`). When the API reports
cache writes:

$$\text{credits} = \frac{W \times \texttt{cacheWritePrice} + R \times \texttt{cacheReadPrice} + (\text{prompt} - R - W) \times \texttt{inputPrice} + \text{completion} \times \texttt{outputPrice}}{\texttt{batchSize}}$$

When it reports no cache writes, every uncached prompt token is priced as a cache
write:

$$\text{credits} = \frac{(\text{prompt} - R) \times \texttt{cacheWritePrice} + R \times \texttt{cacheReadPrice} + \text{completion} \times \texttt{outputPrice}}{\texttt{batchSize}}$$

$$\text{USD} = \text{credits} \times 0.01$$

Copilot reports nearly all uncached input as cache creation, so with reported
writes the remainder priced at `inputPrice` is small, and without them pricing
the uncached input at `cacheWritePrice`, not `inputPrice`, is the calibrated rule.
That rule comes from calibration against Copilot SDK sessions (Copilot CLI 1.0.98,
`@github/copilot-sdk` 1.0.22) measured in a downstream consumer's CI. Session
usage reports cache reads, so each session's token breakdown can be priced and
compared with its reported `totalNanoAiu` / $10^{11}$. The rule reproduced every
reported figure to within $0.00001; pricing uncached input at `inputPrice`
undercounted by 16–17%.

| Model | Prompt | Cached | Uncached | Completion | Reported USD | Formula USD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| claude-opus-5.5 | 38,875 | 18,117 | 20,758 | 1,075 | 0.1289054 | 0.1289134 |
| claude-opus-5.5 | 79,135 | 43,003 | 36,132 | 1,131 | 0.2118726 | 0.2118806 |
| claude-opus-5.5 | 38,920 | 18,121 | 20,799 | 922 | 0.1260512 | 0.1260592 |
| gpt-6-sol | 38,238 | 23,617 | 14,621 | 411 | 0.0453814 | 0.0453859 |

Prompt is total input tokens, cached is prompt-cache reads, and uncached is
prompt − cached. The prices are AI credits per 1,000,000 tokens: Copilot's reported
read, write and output prices, and `inputPrice` from GitHub's published table
(used only for the undercount comparison):

| Model | `inputPrice` | `cacheReadPrice` | `cacheWritePrice` | `outputPrice` |
| --- | ---: | ---: | ---: | ---: |
| claude-opus-5.5 | 400 | 20 | 500 | 2000 |
| gpt-6-sol | 200 | 20 | 250 | 1000 |

The estimate is unavailable when the recorded `model` differs from the model that
answered, `batchSize` is not a positive integer, or the chosen tier lacks
`cacheReadPrice`, `cacheWritePrice`, `outputPrice` or `maxPromptTokens`, or lacks
`inputPrice` while reported writes leave uncached input over.

### Pricing tier

- **Default**: the prompt tokens are at most `default.maxPromptTokens`. If a
  summed usage is within the limit, so is every request in it.
- **Long context**: the usage is a single request (`numRequests` is 1) and its
  prompt tokens are at most `longContext.maxPromptTokens`. A summed usage above
  the default limit can't be split between tiers.
- Otherwise the estimate is unavailable.

## Totals

A consumer may add three kinds of USD into one total, such as a candidate or
grader cost per run:

| Basis | Source | Nature |
| --- | --- | --- |
| Reported session usage | `metadata.copilot.accounting`, `metadata.judgeAccounting` | Copilot's own figure |
| Token-price estimate | `metadata.copilotTokenPrices` × token usage | Reconstructs billing from published prices |
| Native Promptfoo cost | `cost` from non-Copilot providers | Provider-defined USD |

Totals follow these rules:

- Every summand is USD. Multipliers and premium-request counts are never added.
- Each call counts once. Use the judge ledger rather than the final reply's
  accounting, and count Promptfoo cache hits as zero.
- A missing amount, an amount in an unknown unit, or an unavailable record makes
  the total unavailable, not zero.
- A total that includes token-price estimates is itself an estimate.

Neither basis is an invoice. Reported usage is not net spending or an allowance
allocation, and estimates use the prices Copilot listed when the reply was
recorded.
