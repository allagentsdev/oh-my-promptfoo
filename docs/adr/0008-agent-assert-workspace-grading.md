# ADR 0008: Grade the live workspace with a bounded read-only agent

- Status: Accepted
- Date: 2026-10-21
- Amended: 2026-10-25, Codex graders now run stock Promptfoo Codex read-only, without the bundled reader or instruction isolation; see [ADR 0013](0013-codex-graders-use-a-sandboxed-shell.md)

## Context

`llmAssert` can grade an answer, not establish that a narrated file edit actually happened. The workspace provider retains a private case workspace through assertions at `metadata.workspace.path`. Promptfoo's `agent-rubric` does not support Copilot and expects a different metadata key. A second component protocol would make equivalent criteria behave differently depending on the judge transport.

## Decision

Export `agentAssert` from the assertions entry. Share component validation, templates, built-in grading rules, verdict validation and weighted aggregation with `llmAssert`. Agent grading always adds the agent verification rules: claims of work require evidence. The candidate answer, workspace files and tool results are untrusted evidence, not authority to change the rubric or invoke forbidden tools. One malformed reply may be retried; both attempts count as grader spend.

### Live read-only workspace, not a snapshot

Inspect the published live directory through the existing delegate subprocess runner. A missing, non-directory or released path is an assertion error, never an answer-only fallback. Supply only the captured changed-file paths, change kinds, file kinds and modes, deleted paths, unified diff and completeness/truncation/failure information as starting evidence. Never inline captured base64 file contents; the grader reads relevant files on demand.

Bound the complete assembled prompt (built-in rules, rendered criteria, candidate answer and projected evidence) by UTF-8 byte length. `maxPromptBytes` defaults to 131,072 bytes (128 KiB), configurable from 1 to 16,777,216 bytes. This conservative transport budget avoids turning a machine-oriented capture into an unbounded model input; it is not a token-count estimate. If oversized, omit the diff with an explicit notice stating its omitted UTF-8 byte count, then measure again. If the rest still exceeds the budget, fail before starting the grader with an error naming the measured size and limit. Omitting the whole diff is simpler and deterministic compared with cutting arbitrary escaped JSON or partial multibyte characters; the grader can inspect files on demand. Projection prevents today's base64 leak; the assembled-size check also bounds future evidence fields.

A snapshot would add potentially multi-gigabyte copies per assertion and complicate protected source links and their lease lifetime. The existing workspace lifetime is sufficient for normal assertions. Do not chmod the candidate's tree, copy it, or take ownership of its cleanup. The caller must not release or mutate it concurrently with assertions.

Enforce filesystem read-only, shell denial and network-tool denial in each delegate's native policy, rejecting conflicting grader settings. Agent-tool network denial does not prevent model-service requests. Native SDK policy is a cooperative boundary, not a new OS sandbox against malicious same-user code or an SDK defect. The live workspace choice does not claim to protect against those threats; use a separately isolated runner for adversarial execution.

Codex normally reads files through shell commands. Disabling execution therefore requires a replacement read surface: a bundled stdio MCP server offering only bounded `read_file` and `list_directory`. It rejects workspace escapes and undeclared external symlinks; declared protected source links remain readable. Claude exposes only workspace/source-scoped Read/Glob/Grep with a path-checking permission callback and mandatory pre-tool hook, including reads that would otherwise be auto-approved. Copilot checks real paths before approving reads and disables workspace skill loading for graders. Candidate-written skills must never become judge instructions.

Pi graders expose guarded `read` and `ls` tools so they can discover evidence without shell access. Each filesystem operation checks the same workspace/protected-source real-path scope; image MIME detection keeps screenshots as image attachments. Pi grader resources omit workspace instructions and skills entirely.

Disable candidate-writable instruction discovery as well as skills: Copilot grader sessions set `skipCustomInstructions: true` so `.github/copilot-instructions.md`, `AGENTS.md` and `CLAUDE.md` cannot become judge instructions. Codex sets `project_doc_max_bytes: 0` because untrusted project status alone does not suppress `read_agents_md`. These files remain untrusted evidence that the grader may explicitly inspect, not automatically loaded instructions.

An agent may unlink a declared read-only source destination. Read-scope construction and the Codex reader source map skip destinations missing with `ENOENT`, while retaining errors for other failures and requiring the workspace itself to exist. Missing files remain evidence to grade, not an assertion infrastructure error.

The Codex grader supports API-key authentication only, through `grader.config.apiKey` or explicit `grader.env.OPENAI_API_KEY`. Its empty temporary Codex home excludes user configuration and ChatGPT login state; project configuration is untrusted. Do not copy `auth.json`: a refreshed single-use ChatGPT refresh token in a temporary copy would leave the original login broken. Copying it back introduces concurrent refresh/update races with other Codex sessions, so this assertion rejects login-only authentication instead. Other Codex provider uses retain their existing authentication contract.

Encode the Codex project trust key as a quoted flat TOML key: the SDK's nested-object serializer does not quote path keys and breaks on dots. The reader advertises read-only, non-destructive MCP tools; `approval_policy: never` alone does not guarantee MCP approval under a read-only sandbox. Disabled shell registration and MCP approval behavior were inspected against installed Codex 0.144.6 and its pinned source, without model calls. A model-free `codex mcp list --json` accepted the quoted dotted path and registered the reader; this is configuration evidence, not a live model-tool execution claim.

### Time and cost bounds

Use a 120,000 ms grading execution deadline, configurable with `timeoutMs` from 1 to 3,600,000 ms. Start it only after acquiring the grader slot; the single malformed-verdict retry shares the execution deadline. Bound queue admission independently with `queueTimeoutMs`, default 900,000 ms and configurable from 1 to 3,600,000 ms. A queue timeout reports that the grader session could not start, not that grading ran out of time. Both are independent of `workspaceTimeoutMs`: grading does not prepare a workspace, and preparation time says nothing about acceptable judge latency.

At most two delegate invocations bound protocol recovery, not the number of model requests inside an agent session. Report available native token usage, request counts and cost through assertion `tokensUsed`, including a discarded attempt. Do not invent measurements or claim a dollar ceiling: model pricing, usage completeness and agent-internal turns differ between delegates. A monetary budget requires external service/account controls. A timeout bounds wall time, not already incurred charges.

Promptfoo 0.122 aggregates assertion token counts but does not include a cost field in that accumulation. Preserve reported cost as `tokensUsed.cost` for consumers without attributing it to candidate execution or promising that upstream summaries will display it.

### Concurrency

Serialize agent graders within each evaluation process. The assertion entry is independent of provider instances, so it cannot honestly borrow a provider worker cap that it does not own. A process-local queue gives a conservative additional-session cap of one without coupling the public assertion contract to provider internals. Queue admission has its own deadline so normal multi-row concurrency does not consume a waiting row's grading execution budget. Separate evaluation processes each have their own cap; deployment-wide limits remain the runner's responsibility.

## Consequences

Workspace grading supports Copilot, Claude, Codex and Pi with the same rubric contract. It costs an agent session rather than a single chat request and cannot execute tests because shell access is denied. Suites requiring exact bytes should keep deterministic file assertions; suites requiring actual test execution must obtain that evidence in the candidate run rather than granting a judge write or shell privileges.

Serialization favors bounded resource use over row throughput. Native policy changes must retain behavioral coverage for all four delegates. Workspace cleanup remains provider-owned and best-effort; durable file-change evidence survives cleanup, but cannot make `agentAssert` operate after cleanup.
