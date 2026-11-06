# Native Promptfoo CI and local reporting

The reusable root-level Action lives in
[`allagentsdev/oh-my-promptfoo-action`](https://github.com/allagentsdev/oh-my-promptfoo-action).
This package owns its public local `eval`/`report` CLI, providers, graders and
reporting/accounting helpers. The Action evaluates **one authored config per
invocation**; use separate named jobs or a matrix for separate suites. Promptfoo
loads native resources, selects cases, invokes providers and evaluates assertions.
Cases and thresholds stay in the caller's checked-in config.

The Action pins an immutable public package source commit and its frozen pnpm
lockfile, including **Promptfoo 0.125.1**. Dependency scripts are disabled. The
source build is explicit because the published npm package does not yet include
the new CLI/reporting exports. Node, pnpm and nested setup Actions are pinned in
the Action repository. Pin the Action itself to a reviewed commit. Action releases
are independent of this package's [release process](releasing.md); no Action tag
has been published yet. There is no floating-toolchain fallback.

This repository's root `action.yml` remains a compatibility entry that forwards
all existing inputs and outputs to the pinned standalone Action. New callers
should reference `allagentsdev/oh-my-promptfoo-action` directly.

## Suite cards and test links

Use **one suite per job**, with the job's `name` set to `Run Evals - <suite name>`. GitHub
groups step summaries into job cards, so two Action invocations in the same job
share a card. Separate named jobs or matrix entries produce separate cards.
The report heading is `Evals — ✅ PASS` (or the native failure/error status);
suite numbers are not displayed.

Each summary starts with a metrics table and a results table containing
latency, tokens, cost, status, assertions passed and **Score vs threshold**. Results-table tokens and cost
include candidate and grader only when both are reported. Each test has
an expandable section containing its assertion outcomes and measured accounting.
Scores are displayed as rounded percentages and native candidate latency in seconds or minutes;
the native values remain unchanged in `report.json`. `—` means no assertion
threshold was authored; it is not a missing measurement.
The results table always shows each native score alongside its authored overall
test `threshold`, or `—` when none was authored. The displayed score never determines
the verdict. Costs use four decimal places, with extra precision when a positive
amount would otherwise round to zero. Native cost precision stays in `report.json`.

### Live console progress

The Action and local `eval` CLI print a line as each native `afterEach` hook
completes, while other tests can still be running:

```text
Evaluation started
Completed 1 · native test 3, column 1 · PASS · 9.4 s
```

Concurrent cases can finish out of order. `Completed` counts completion events;
native test/result-column references are `testIdx + 1` and `promptIdx + 1`. They are
not the final export's `Test N` row numbers. Final console output uses the same
`Test N` references as the Markdown report, with per-assertion outcomes and separate
candidate/grader usage and cost. Missing measurements remain unknown.

Progress is numeric only: no answers, reasons, labels or generated content are
streamed. Final console labels follow the same `public-labels` consent and
credential redaction as the summary. Terminal controls and workflow-command
markers are neutralized. Native stdout/stderr stays in the private log, including
when debug logging is enabled.

The runner adds its own [public Promptfoo extension hook](https://www.promptfoo.dev/docs/configuration/reference/#extension-hooks)
alongside authored config/CLI hooks; it does not replace them or modify results.
Native comparison assertions (`select-best` and `max-score`) run after individual
rows, so those live events say `COMPARISON PENDING`. The final native export owns
their verdicts. A saved-run preview prints its final console report and explicitly
labels it as recorded; it does not replay fabricated live-completion events.

Tests restart at **1** in each suite card: **Test 6** is that
suite's sixth evaluated result row. The same number appears in the results table
and its expandable details. Checks use
their authored metric names; only unnamed or duplicate metrics need a numbered
fallback within that test. Separate candidates and repeats each get their own
result number. The JSON retains the native row/test/column mapping. These are
report references, not case IDs or a selection language.

GitHub orders job cards by completion time. When order matters, make the later
job depend on the earlier job with `needs`, and use `if: ${{ always() }}` on the
later job so it still publishes after an earlier failure. Both jobs keep their
own status. Parallel matrix cards keep their completion-based ordering.

With public labels enabled, the Action links test names in the results table and
expandable details to their checked-in definitions. Links use the caller
checkout's commit, including when native filters, samples, providers or repeats
change result order. Static YAML and JSON definitions, inline tests, scenarios
and local test-file references/globs get line ranges covering the entire test block when a unique definition
is found. Duplicate descriptions can be disambiguated by literal test variables.
CSV, generated tests and ambiguous definitions get a source-file link explicitly
labelled as having no exact test location. Unavailable Git history omits links;
it never changes the evaluation verdict. The lookup reads committed blobs and
does not run config code, providers or graders. No source text enters the report.
Suites mixing CSV, generated or remote resources with static cases use config-file
links when result ownership cannot be established safely.

The legacy `suite-number` input and JSON reference remain accepted for existing
callers. They do not control card titles or display numbering.

Readable authored labels are opt-in:

```yaml
- uses: allagentsdev/oh-my-promptfoo-action@<reviewed-commit>
  with:
    config: evals/release/promptfooconfig.yaml
    public-labels: "true"
```

`public-labels: 'true'` publishes the native config's `description`, each test's
`description`, provider `label`, assertion `metric` and assertion `type`. Enable
it only for labels approved for the summary's audience. Labels are bounded, escaped and redacted
using known config/environment credential values. The default is `false`; raw
answers, assertion values, grader reasons, generated files and provider IDs are
never used as labels.

For a formatting example before the live workflow is merged, the validation
workflow publishes the local release suite and a clearly labelled recorded
six-case agent run in separate named job cards. The recorded report comes from
[`examples/ci/live-report.json`](../examples/ci/live-report.json). It contains only
the sanitized report and provenance of an actual model run. Its displayed
failures are the recorded model results; previewing it makes no inference calls
and does not claim to evaluate the current commit. Render the same sample locally
after building with `node packages/oh-my-promptfoo/evals/live/preview.mjs`.

## Release regression

This runs the complete fixed required suite. No sample, range or first-N filter is
used. All four cases and their exact assertions live in
[`examples/ci/release/promptfooconfig.yaml`](../examples/ci/release/promptfooconfig.yaml). Test-name links open the full test block in that suite file. The local candidate needs no
credentials and explicitly reports zero model tokens, requests and cost because
it only normalizes text locally. Replace its provider with your checked-in application/agent config
for a production gate. Do not set `PROMPTFOO_PASS_RATE_THRESHOLD` if every native
row must pass.

After checking out this repository, this workflow is runnable as written:

```yaml
name: Release regression
on: [pull_request, workflow_dispatch]
permissions:
  contents: read
jobs:
  required:
    name: Run Evals - Required name-normalization release regression
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v7
      - uses: allagentsdev/oh-my-promptfoo-action@26de8c8bd12948f9ad9b06335fc1fbe4d5b1fe04
        id: eval
        with:
          config: examples/ci/release/promptfooconfig.yaml
          args-json: '["--filter-metadata", "suite=required", "--no-cache", "--max-concurrency", "2"]'
```

In another repository, use `allagentsdev/oh-my-promptfoo-action@<reviewed-commit>`
and a path to **that repository's** authored config. If it references
`package:oh-my-promptfoo/...` or other npm packages, install the caller's pinned
dependencies using its checked-in lockfile and build any local workspace packages
before invoking the Action. Package
and `file://` references resolve normally from the config directory; the Action
does not inject packages or rewrite the caller's `node_modules`. Install any
required coding-agent runtimes and workspace helper as described in the
[provider guide](provider-guide.md). The package's release build is available in
the Action's private toolchain directory, but it is not automatically a dependency
of the caller.

## Manually triggered live dogfood

The **Live agent dogfood** workflow runs only through `workflow_dispatch`.
After the workflow lands on the default branch, choose **Actions → Live agent
dogfood → Run workflow** and select the reviewed ref to evaluate. It uses this
checkout's built provider/grader package through the pinned standalone Action,
so the live suite evaluates the reviewed implementation instead of an older
registry release. The workflow explicitly builds the caller after installing its
locked dependencies; the Action builds its own toolchain separately.

The fixed suite in `packages/oh-my-promptfoo/evals/live/promptfooconfig.yaml`
runs the real Pi SDK through OpenRouter. Both the candidate and read-only
`agentAssert` grader use the repository variable **`OPENROUTER_MODEL`**. Set it to
`deepseek/deepseek-v4.1-flash`, or another tool-capable model supported by the
pinned SDK. The selected model may incur charges. Changing the variable affects
the next manual run without changing the authored tasks or scoring. The report
labels include the selected model. The suite stages the selected Git commit as a
protected source, loads the repository's `oh-my-promptfoo` skill,
and asks the candidate to author configs and commands for real repository tasks:
an exact-match smoke config, package provider/grader IDs, repeated metadata
filters, candidate/grader permissions, seeded comparison arguments and required
skill/JSON checks. Captured files must exactly match the checked-in
expected data; stock `skill-used` and the live workspace grader must pass too.
The full six-case suite runs without sampling or response caching. Candidate and
grader calls each have a 45-second deadline. This workflow disables Promptfoo's
adaptive scheduler so rate limits become reported errors without retrying whole
agent tasks and exhausting the 15-minute job budget. Its public
descriptions and assertion metrics are included in the numbered report.

Set the model variable and store the key in the repository secret
**`OPENROUTER_API_KEY`** under **Settings → Secrets and variables → Actions**:

```sh
gh variable set OPENROUTER_MODEL --body deepseek/deepseek-v4.1-flash --repo allagentsdev/oh-my-promptfoo
gh secret set OPENROUTER_API_KEY --repo allagentsdev/oh-my-promptfoo
```

The secret command prompts locally; do not put the key in workflow inputs or committed YAML.
The preflight checks both model declarations against the current OpenRouter
catalog and pinned SDK. Missing settings, a removed/unsupported model, unavailable
catalog or model-call failures fail the job. There is no automatic model fallback.
Service rate limits and capacity can still make a run fail. A shared model
for candidate and grader is a smoke test of the integration, not an independent
assessment of model quality.

Results appear in the job summary, with candidate/grader accounting handled by
the same reporter. Raw results, generated files and model reasons are not uploaded.
GitHub-hosted runner files are temporary; use approved private storage if they need
to survive the job. The suite's config lives inside the public package directory
so native package references resolve to the current build through its exports.
The eval fixtures are excluded from npm publication by the existing `files` list.

To run the same authored suite locally, supply the key through your environment,
then run from a trusted checkout:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
export DOGFOOD_REPOSITORY="file://$PWD"
export DOGFOOD_REF="$(git rev-parse HEAD)"
export PROMPTFOO_CACHE_ENABLED=false
export PROMPTFOO_DISABLE_ADAPTIVE_SCHEDULER=true
export OPENROUTER_MODEL=deepseek/deepseek-v4.1-flash
node scripts/check-live-agent-eval.mjs
node packages/oh-my-promptfoo/dist/cli.js eval \
  --config packages/oh-my-promptfoo/evals/live/promptfooconfig.yaml \
  --public-labels true -- \
  --no-cache --max-concurrency 1
```

## Offline model comparison

[`comparison.yaml`](../examples/ci/comparison.yaml) has two native model providers
and uses exactly the same dataset, prompt and assertions for both. It requires
the caller's `OPENAI_API_KEY`. This compares responses on an offline dataset;
model calls still use their configured service.

```yaml
name: Offline comparison
on: [workflow_dispatch]
permissions:
  contents: read
jobs:
  compare:
    name: Run Evals - Offline model comparison · ${{ matrix.candidate }}
    runs-on: ubuntu-latest
    timeout-minutes: 15
    strategy:
      fail-fast: false
      matrix:
        candidate: [baseline, candidate]
    steps:
      - uses: actions/checkout@v7
      - uses: allagentsdev/oh-my-promptfoo-action@26de8c8bd12948f9ad9b06335fc1fbe4d5b1fe04
        id: eval
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        with:
          config: examples/ci/comparison.yaml
          public-labels: "true"
          args-json: >-
            ["--filter-providers", "^${{ matrix.candidate }}$",
             "--filter-metadata", "suite=required", "--filter-metadata", "language=latin",
             "--filter-sample", "3", "--filter-sample-seed", "42", "--no-cache"]
```

For another repository, change the `uses` and config path as above. Pin the dataset
revision and ordering, the provider/model versions available to you, the prompt,
the selected cases and the scoring configuration for **every** candidate. Native
`--filter-sample` plus `--filter-sample-seed` makes sampling repeatable for the
same dataset and ordering; a seed does **not** pin a changing dataset/order or a
mutable model alias. Store the commit and private native results with the
comparison. This is not live traffic A/B assignment and does not route users or
sessions into experimental groups.

## Inputs and argument ownership

| Input               | Meaning                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `config`            | Required single local file, relative to `working-directory`. No config glob or list.                                                   |
| `working-directory` | Caller directory; default `.`.                                                                                                         |
| `output-directory`  | Artifact parent relative to the working directory; default `.promptfoo-ci`. A new `run-*` child prevents stale results.                |
| `args-json`         | JSON array of native `promptfoo eval` argument strings; default `[]`. No shell splitting or evaluation.                                |
| `args-file`         | JSON argument-array file, relative to the working directory (absolute paths also work). Use instead of `args-json` for private values. |

Examples of native arguments include repeated `--filter-metadata key=value`
(AND), native comma-separated values (OR), `--filter-pattern` (description regex),
`--filter-providers`/`--filter-targets` (regex), `--filter-range 0:10`,
`--filter-sample 3`, `--filter-sample-seed 42`, `--repeat 2`, `--grader`,
`--max-concurrency`, `--no-cache`, `--var` and `--env-file`. They retain Promptfoo's
meaning and argument boundaries, including values with spaces. The installed
`promptfoo eval --help` is authoritative. Unsupported arguments fail through the
native parser. Required values that look like flags remain values; option arities
come from the installed CLI's public help, without importing its parser.

**GitHub can print literal Action inputs and step environment values before the
Action executes.** Treat `args-json`, config paths and directory names as public
configuration. Pass credentials through masked secrets/environment. Every other
sensitive literal value also needs masking **before** invoking the Action, or use
`args-file` so its contents never enter Action inputs or the runner's environment
preamble. The runner's preamble is outside the native-child log redirection.
Do not supply both argument sources (leave `args-json` at `[]` for `args-file`).

For example, prepare a private native argument array without printing its contents:

```yaml
- name: Prepare private arguments
  env:
    PRIVATE_VALUE: ${{ secrets.EVAL_PRIVATE_VALUE }}
  run: |
    node --input-type=module <<'NODE'
    import { writeFileSync } from 'node:fs';
    writeFileSync(`${process.env.RUNNER_TEMP}/native-args.json`,
      JSON.stringify(['--var', `private_value=${process.env.PRIVATE_VALUE}`, '--no-cache']),
      { mode: 0o600 });
    NODE
- uses: allagentsdev/oh-my-promptfoo-action@26de8c8bd12948f9ad9b06335fc1fbe4d5b1fe04
  with:
    config: examples/ci/release/promptfooconfig.yaml
    args-file: ${{ runner.temp }}/native-args.json
```

Config/output switches and aliases are reserved, as are sharing, database-write,
watch/resume/retry, help/version and prompt-generation switches. These cannot
replace the fresh invocation or bypass reporting. The runner supplies `--no-share`,
`--no-write`, `--no-table` and `--no-progress-bar` after caller arguments. CLI output
overrides config `outputPath`. Keep cases, expected outcomes, rubrics and thresholds
in checked-in native resources; this interface adds no selection or scoring DSL.

## Gates, outputs and private storage

The step fails for a native assertion-failure exit, any other native nonzero exit,
provider/transport errors, recorded grader errors, missing/malformed/incomplete
results or zero evaluated rows. It always attempts reporting after the CLI stops,
including nonzero exits. It preserves native row and assertion scores/verdicts;
it does not introduce a default aggregate score or a repeat-majority gate.
An explicitly authored `PROMPTFOO_PASS_RATE_THRESHOLD` still controls native
assertion-failure tolerance, but never suppresses errors or missing/zero coverage.
The runner fixes `PROMPTFOO_FAILED_TEST_EXIT_CODE=100` to distinguish assertion
failures from execution errors. A failed required assertion must be enforced by
the authored scoring policy; see [required assertions](grading-guide.md).

| Output                        | Meaning                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `evaluation-status`           | `pass`, `fail` or `error`; also represented in `report.json`.                     |
| `evaluation-exit-code`        | Native exit code, or `unknown` if execution could not finish.                     |
| `result-path`                 | Absolute native JSON path, retained on assertion failures and errors if produced. |
| `results-available`           | `true` if native JSON was produced and parsed; its coverage may still be invalid. |
| `artifact-directory`          | Absolute private run directory containing results, raw logs and reports.          |
| `log-path`                    | Native stdout/stderr, **potentially sensitive**.                                  |
| `report-path`, `summary-path` | Sanitized JSON and Markdown reports.                                              |

The GitHub step summary contains counts, numbered test references, assertion
outcomes, native scores/thresholds, latency and measured usage and cost. Test
numbers restart at 1 within each suite and use the one-based result row. Native
row 1 is `results.results[0]`; the detailed test/column references are
`testIdx + 1`/`promptIdx + 1`. Authored labels are omitted unless `public-labels`
is enabled as described above. Other metadata, assertion values, answers, grader
reasons, generated files, provider IDs and credentials are omitted.
Long summaries are bounded; `report.json` retains all sanitized outcomes. No public
share, comment or artifact upload occurs by default. Only numeric progress and the sanitized
final report are printed publicly; native stdout/stderr stays in the private log.

### Downloading scored results

Enable uploads only when GitHub artifact storage is approved for the suite's
answers, judge reasons and generated content. The reusable Action leaves uploads
off by default. To enable them:

```yaml
- uses: allagentsdev/oh-my-promptfoo-action@<reviewed-commit>
  id: eval
  with:
    config: promptfooconfig.yaml
    upload-results: "true"
    artifact-retention-days: "0"
```

`0` uses the **calling repository's** default retention. Repository/organization
settings still apply; an explicit positive number can shorten retention. The
Action does not change those settings. For example, callers can use `14` for a
14-day artifact instead. See GitHub's [retention inputs](https://github.com/actions/upload-artifact#inputs).

After a successful upload, the suite card includes:

> Agent output and judge reasons: download the scored result (expires in 14 days).

The actual text uses the configured effective retention, including the runner's
repository limit; it never assumes 14 days. If retention is unavailable locally,
the helper says it follows repository settings. No download link is printed when
an upload is disabled, skipped or fails. `result-artifact-url` and
`result-artifact-id` expose the successful upload to later workflow steps.
An optional `artifact-name` replaces the generated unique invocation name; use
distinct names for matrix jobs and multiple invocations.

The artifact contains **scored-results.json**, a native export retaining answers,
judge reasons, scores and usage with known credential values redacted using the
package's existing redaction helpers. Private original JSON and logs stay on the
runner. Logs are not uploaded. Redaction does not make business data public-safe:
GitHub artifacts follow the calling repository's access rules, and logged-in
readers of a public repository can download them. The caller owns storage approval.
Assertion/provider failures still fail the Action and retain/upload available
results. Missing, unparseable or zero-row results never create a scored artifact.

The fixed release example and manual live workflow explicitly enable uploads.
The recorded agent preview has only a sanitized report, so it does not claim to
offer original answers or judge reasons. A fresh manual live run produces them.

Local callers can prepare the same redacted native export for their approved
storage and render the link after upload:

```js
import { prepareResultArtifact, renderResultArtifactLink } from "oh-my-promptfoo/reporting";
await prepareResultArtifact("results.json", "scored-results.json");
// Upload scored-results.json using your approved storage, then use its real URL.
console.log(renderResultArtifactLink(artifactUrl, 14));
```

Raw JSON/logs can contain confidential data and credentials. The caller owns
storage approval, access controls and retention. Add `.promptfoo-ci/` to the
caller's `.gitignore` and formatter/linter exclusions, so their diagnostics cannot quote raw
artifact contents. This repository excludes the default `.promptfoo-ci` directory.
To retain data after failure, use an `if: always()` step and
`${{ steps.eval.outputs.artifact-directory }}` with your repository's **approved
private** storage. If GitHub artifact storage is approved, for example:

```yaml
- uses: actions/upload-artifact@v6
  if: ${{ always() && steps.eval.outputs.artifact-directory != '' }}
  with:
    name: private-eval-results
    path: ${{ steps.eval.outputs.artifact-directory }}
    retention-days: 7
    include-hidden-files: true
```

Decide whether that storage is suitable before adding this step, especially in a
public repository. Do not rely on `continue-on-error` for the gate. Cancellation,
host loss or toolchain setup failure can prevent outputs/reporting; an absent
output never establishes success. The Action does not request tokens, recover
stored logins/PATs, grant job permissions or escalate access. Configure credentials
and minimal job permissions in the calling workflow. Run untrusted configs only
under your repository's existing trust policy: native providers and assertions
can execute code.

## Accounting and local use

Candidate tokens come from original `response.tokenUsage`, not zero-filled row
statistics. Grader tokens come from native grading usage. Costs use original
provider-reported native USD, complete Copilot session/attempt ledgers through the
existing package accounting helpers, or recorded Copilot model prices and the
[documented token-price methodology](copilot-cost-methodology.md). Batched criteria
do not own extra spend. Grader errors have unknown usage/cost, including synthetic
zero-token failure records. Absent costs, incomplete/mixed ledgers and unmeasured
calls make totals unknown.

The local artifact checker explicitly reports zero model calls and cost because
it only parses and compares captured content. Known native local checks, including
skill-use and exact matching, establish zero grader usage/cost without model calls.
Neither masks the live workspace
grader's reported usage or cost; arbitrary unmeasured JavaScript stays unknown.
Missing grading results and unmeasured custom wrappers also stay unknown.

Incomplete result coverage or execution also makes run totals unknown; individual
measured rows remain visible. Promptfoo response cache hits add no new cost; cache
read tokens billed by a model remain usage. Estimates are marked `~`; no list-price
savings, premium-request multiplier conversions or invoices are fabricated.

With Node 22.22+ and pinned `oh-my-promptfoo` and `promptfoo@0.125.1` installed from
your lockfile, the same runner and reporter work locally:

```sh
allagents-promptfoo eval --config examples/ci/release/promptfooconfig.yaml --output-dir .promptfoo-ci -- \
  --filter-metadata suite=required --filter-metadata language=latin --no-cache
allagents-promptfoo report --results .promptfoo-ci/run-ABC123/results.json --output-dir .promptfoo-ci
allagents-promptfoo report --results .promptfoo-ci/run-ABC123/results.json --public-labels true
allagents-promptfoo eval --config examples/ci/release/promptfooconfig.yaml --args-file /private/native-args.json
```

Use the actual path printed by `eval` in the second command. To run from this
source checkout, run `pnpm install --frozen-lockfile`, `pnpm build`, then replace
`allagents-promptfoo` with `node packages/oh-my-promptfoo/dist/cli.js`.
`report` also accepts native JSON from a direct `promptfoo eval --output FILE`
invocation; without a process exit code it conservatively gates on native row
outcomes. Programmatic consumers can import `summarizeEvaluation`, `renderSummary`
and `estimateCopilotCost` from `oh-my-promptfoo/reporting`.
`summarizeEvaluation(document, exitCode, { publicLabels: true })`
opts into the same numbered public labels; programmatic callers can supply
additional `sensitiveValues` for redaction. The CLI also uses known credential
values from its environment. These reporting options belong before the `--`
separator; arguments after it still go unchanged to Promptfoo.

Source links are also available locally through the same helper. Run this in the
checkout containing the config and the native result export:

```js
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { addSourceLinks, renderSummary, summarizeEvaluation } from "oh-my-promptfoo/reporting";

const native = JSON.parse(readFileSync(".promptfoo-ci/run-ABC123/results.json", "utf8"));
const report = summarizeEvaluation(native, undefined, { publicLabels: true });
const linked = await addSourceLinks(
  report,
  {
    configPath: "examples/ci/release/promptfooconfig.yaml",
    repositoryRoot: process.cwd(),
    repositoryUrl: "https://github.com/allagentsdev/oh-my-promptfoo",
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  },
  native,
);
console.log(renderSummary(linked));
```

Use your repository URL, config and actual result path. `addSourceLinks` also
accepts an existing sanitized report without the optional native document. Supply
the evaluated revision, rather than a later checkout, for a historical report.
The recorded live preview stores its verified source URLs with the sanitized
report, so rendering it needs neither Git history nor another model call.

The [official Action's inputs](https://github.com/promptfoo/promptfoo-action/blob/main/action.yml)
and [implementation](https://github.com/promptfoo/promptfoo-action/blob/main/src/main.ts)
were inspected for this integration. They expose specific switches rather than an
arbitrary native argument array, and remove the per-run JSON after their reporting.
This Action therefore uses the public native CLI/JSON boundary directly; it
does not import Promptfoo's evaluator, server or database internals.
