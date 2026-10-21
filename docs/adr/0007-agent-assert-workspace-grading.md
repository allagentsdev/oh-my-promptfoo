# ADR 0007: Grade the live workspace with a bounded read-only agent

- Status: Accepted
- Date: 2026-10-21

## Context

`llmAssert` can grade an answer, not establish that a narrated file edit actually happened. The workspace provider retains a private case workspace through assertions at `metadata.workspace.path`. Promptfoo's `agent-rubric` does not support Copilot and expects a different metadata key. A second component protocol would make equivalent criteria behave differently depending on the judge transport.

## Decision

Export `agentAssert` from the assertions entry. Share component validation, templates, built-in grading rules, verdict validation and weighted aggregation with `llmAssert`. Agent grading always adds the agent verification rules: claims of work require evidence. The candidate answer, workspace files and tool results are untrusted evidence, not authority to change the rubric or invoke forbidden tools. One malformed reply may be retried; both attempts count as grader spend.

### Live read-only workspace, not a snapshot

Inspect the published live directory through the existing delegate subprocess runner. A missing, non-directory or released path is an assertion error, never an answer-only fallback. Supply `metadata.fileChanges` when present, including its completeness status, as starting evidence rather than a substitute for inspection.

A snapshot would add potentially multi-gigabyte copies per assertion and complicate protected source links and their lease lifetime. The existing workspace lifetime is sufficient for normal assertions. Do not chmod the candidate's tree, copy it, or take ownership of its cleanup. The caller must not release or mutate it concurrently with assertions.

Enforce filesystem read-only, shell denial and network-tool denial in each delegate's native policy, rejecting conflicting grader settings. Agent-tool network denial does not prevent model-service requests. Native SDK policy is a cooperative boundary, not a new OS sandbox against malicious same-user code or an SDK defect. The live workspace choice does not claim to protect against those threats; use a separately isolated runner for adversarial execution.

Codex normally reads files through shell commands. Disabling execution therefore requires a replacement read surface: a bundled stdio MCP server offering only bounded `read_file` and `list_directory`. It rejects workspace escapes and undeclared external symlinks; declared protected source links remain readable. An authentication-only temporary Codex home excludes user configuration, and project configuration is untrusted. Claude exposes only Read/Glob/Grep with a denial callback; Copilot uses its existing permission callback. These policies prevent a grader from quietly regaining execution through discovered configuration.

### Time and cost bounds

Use a 120,000 ms total assertion deadline, configurable via `timeoutMs` within the existing bounded timeout range. Queue wait and the single malformed-verdict retry consume that same deadline. This is independent of `workspaceTimeoutMs`: grading does not prepare a workspace, and preparation time says nothing about acceptable judge latency.

At most two delegate invocations bound protocol recovery, not the number of model requests inside an agent session. Report available native token usage, request counts and cost through assertion `tokensUsed`, including a discarded attempt. Do not invent measurements or claim a dollar ceiling: model pricing, usage completeness and agent-internal turns differ between delegates. A monetary budget requires external service/account controls. A timeout bounds wall time, not already incurred charges.

Promptfoo 0.122 aggregates assertion token counts but does not include a cost field in that accumulation. Preserve reported cost as `tokensUsed.cost` for consumers without attributing it to candidate execution or promising that upstream summaries will display it.

### Concurrency

Serialize agent graders within each evaluation process. The assertion entry is independent of provider instances, so it cannot honestly borrow a provider worker cap that it does not own. A process-local queue gives a conservative additional-session cap of one without coupling the public assertion contract to provider internals. Queue waits are bounded by the assertion deadline. Separate evaluation processes each have their own cap; deployment-wide limits remain the runner's responsibility.

## Consequences

Workspace grading supports Copilot, Claude and Codex with the same rubric contract. It costs an agent session rather than a single chat request and cannot execute tests because shell access is denied. Suites requiring exact bytes should keep deterministic file assertions; suites requiring actual test execution must obtain that evidence in the candidate run rather than granting a judge write or shell privileges.

Serialization favors bounded resource use over row throughput. Native policy changes must retain behavioral coverage for all three delegates. Workspace cleanup remains provider-owned and best-effort; durable file-change evidence survives cleanup, but cannot make `agentAssert` operate after cleanup.
