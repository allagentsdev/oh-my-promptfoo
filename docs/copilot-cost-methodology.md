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

- `CopilotSdkProvider`
- the workspace `Provider` with the `copilot-sdk` delegate
- `agentAssert` with a Copilot grader
- `llmAssert` and `FallbackProvider` whose judges are Copilot SDK sessions

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

`llmAssert`, `agentAssert` and `FallbackProvider` can call more than one judge, or
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
`tokensUsed.cost`; `FallbackProvider` reports it as `cost`. A ledger with only
non-Copilot leaves reports the sum of their native costs instead, and only when
every uncached leaf reported one. See
[Judge accounting v1](grading-guide.md#judge-accounting-v1).

## Token-price estimate

`CopilotResponsesProvider` calls a Copilot model over the Responses API without a
session, so there is no reported usage. Promptfoo's `openai:responses` provider
would price the reply at OpenAI list prices, which is not Copilot billing. The
provider removes that `cost` and instead attaches the model's prices as
`metadata.copilotTokenPrices`
([`copilot-responses.ts`](../packages/oh-my-promptfoo/src/copilot-responses.ts)):

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

### Formula

For one reply, or one assertion's summed judge usage, with `prompt`, `completion`
and `cached` (prompt-cache read) token counts:

$$\text{credits} = \frac{(\text{prompt} - \text{cached}) \times \texttt{cacheWritePrice} + \text{cached} \times \texttt{cacheReadPrice} + \text{completion} \times \texttt{outputPrice}}{\texttt{batchSize}}$$

$$\text{USD} = \text{credits} \times 0.01$$

Uncached prompt tokens are priced at `cacheWritePrice`, not `inputPrice`. This
rule comes from calibration. Applied to the token breakdowns of Copilot SDK agent
sessions, which do report cache reads, it reproduced each session's reported
usage to within $0.00001. Pricing uncached input at `inputPrice` undercounted by
about 16%.

| Model | Run | Reported | Formula |
| --- | --- | ---: | ---: |
| claude-opus-5.5 | [39934137325](https://github.com/WiseTechGlobal/WTG.AI.Prompts/actions/runs/39934137325) | $0.1289054 | $0.1289130 |
| claude-opus-5.5 | [39922534386](https://github.com/WiseTechGlobal/WTG.AI.Prompts/actions/runs/39922534386) | $0.2118726 | $0.2118810 |
| claude-opus-5.5 | [39903956512](https://github.com/WiseTechGlobal/WTG.AI.Prompts/actions/runs/39903956512) | $0.1260512 | $0.1260590 |
| gpt-6-sol | [39936401678](https://github.com/WiseTechGlobal/WTG.AI.Prompts/actions/runs/39936401678) | $0.0453814 | $0.0453859 |

The estimate is unavailable when the recorded `model` differs from the model that
answered, `batchSize` is not a positive integer, or the chosen tier lacks
`cacheReadPrice`, `cacheWritePrice`, `outputPrice` or `maxPromptTokens`.

### Pricing tier

- **Default**: the prompt tokens are at most `default.maxPromptTokens`. If a
  summed usage is within the limit, so is every request in it.
- **Long context**: the usage is a single request (`numRequests` is 1) and its
  prompt tokens are at most `longContext.maxPromptTokens`. A summed usage above
  the default limit can't be split between tiers.
- Otherwise the estimate is unavailable.

### Cached tokens

In Promptfoo 0.124.1, a live `openai:responses` reply's `tokenUsage` has
`prompt`, `completion`, `total` and `numRequests`, but no prompt-cache reads. The
count exists only in `response.raw.usage.input_tokens_details.cached_tokens`, and
`CopilotResponsesProvider` does not currently copy it into `tokenUsage`. A
consumer pricing from `tokenUsage` therefore uses `cached = 0` and prices every
prompt token at `cacheWritePrice`. The result is exact when Copilot served no
prompt-cache reads, and an upper bound when it did.

`tokenUsage.cached` on a Responses reply means something else: the reply was
served from Promptfoo's response cache, and `cached` equals its total tokens. Such
a reply (`response.cached: true`) is not a new request and adds no cost.

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
