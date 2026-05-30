# Session Metrics Reference

This document is the canonical reference for every data point the WorkRail engine
captures during a session. It covers the raw events written to the session store,
the `SessionMetricsV2` projection that aggregates them, and the authority level of
each field.

**Authority levels:**

| Level | Meaning |
|---|---|
| **Engine-authoritative** | Written by the engine from git, JSONL, or event log data. Cannot be overridden by the agent. |
| **Agent-reported** | Written by the agent via `context_set`. Validated at the boundary (enum checks, type coercion) but not independently verified. |
| **Derived** | Computed from other captured fields. |
| **Metadata** | Written automatically by the engine at session creation. |

---

## Raw Events

### `session_created`

Written at session creation. Establishes the session identity.

| Field | Type | Notes |
|---|---|---|
| `sessionId` | `string` | Unique session identifier (`sess_...`) |
| `parentSessionId` | `string \| undefined` | Set for child sessions spawned by coordinator |

---

### `run_started`

Written when a workflow run begins within a session.

| Field | Type | Notes |
|---|---|---|
| `runId` | `string` | Unique run identifier (`run_...`) |
| `workflowId` | `string` | Workflow being run (e.g. `wr.coding-task`) |
| `workflowHash` | `string` | SHA-256 of the compiled workflow definition |
| `workflowSourceKind` | `string` | `bundled` \| `imported` \| `personal` \| etc. |
| `workflowSourceRef` | `string` | Git ref or registry URL of the workflow source |
| `triggerSource` | `string` | `mcp` or daemon trigger ID |

**Authority:** Engine-authoritative, Metadata

---

### `observation_recorded`

Written by the workspace anchor resolver at session start. Captures git identity
for resume ranking and later diff computation.

| Key | Type | Source | Notes |
|---|---|---|---|
| `repo_root` | `string` | `git rev-parse --show-toplevel` | Absolute path to the workspace git root |
| `git_head_sha` | `string` | `git rev-parse HEAD` | 40-char SHA of HEAD at session start |
| `git_branch` | `string` | `git branch --show-current` | Short branch name at session start |
| `repo_root_hash` | `string` | SHA-256 of repo_root | Used for resume ranking |

**Authority:** Engine-authoritative

---

### `context_set`

Written multiple times per session. Carries session context state: initial goal,
agent-reported metrics, and intermediate state updates.

#### Initial context (`source: 'initial'`)

| Key | Type | Notes |
|---|---|---|
| `goal` | `string` | User-provided goal text |
| `autonomy` | `string` | `guided` \| `autonomous` |
| `riskPolicy` | `string` | `conservative` \| `standard` \| etc. |

#### Agent-reported metrics (`source: 'agent_delta'`, final step only)

Set by the agent at the last step of workflows with a `metricsProfile` field.
Validated at the tool boundary; invalid values are rejected.

| Key | Type | Authority | Notes |
|---|---|---|---|
| `metrics_outcome` | `'success' \| 'partial' \| 'abandoned' \| 'error'` | Agent-reported | Overall session outcome |
| `metrics_pr_numbers` | `number[]` | Agent-reported | PR numbers opened or worked on during the session |
| `metrics_files_changed` | `number` | Agent-reported | File count (approximate; see `gitEvidence` for authoritative) |
| `metrics_lines_added` | `number` | Agent-reported | Lines added (approximate; see `gitEvidence` for authoritative) |
| `metrics_lines_removed` | `number` | Agent-reported | Lines removed (approximate; see `gitEvidence` for authoritative) |
| `metrics_commit_shas` | `string[]` | Agent-reported | **Deprecated.** Use `gitEvidence.commitShas`. |

**Coverage:** Only sessions whose workflow has `metricsProfile` set and whose agent
followed the metrics footer prompt. Empirically ~53% of recent sessions.

---

### `node_created`

Written each time the DAG advances to a new node.

| Field | Type | Notes |
|---|---|---|
| `nodeKind` | `'step' \| 'checkpoint' \| 'blocked_attempt' \| 'gate_checkpoint'` | `step` = normal step; `blocked_attempt` = retry after output contract failure |
| `nodeId` | `string` | Unique node identifier |
| `parentNodeId` | `string \| null` | Parent node in the DAG |

**Used by projection:** Counting `step` nodes gives `stepsCompleted`; counting
`blocked_attempt` nodes gives `retriesCount`.

**Authority:** Engine-authoritative

---

### `delivery_recorded`

Written by the daemon delivery pipeline when commits are pushed. Not written for
MCP sessions.

| Field | Type | Notes |
|---|---|---|
| `shas` | `string[]` | Commit SHAs confirmed pushed by the delivery pipeline |

**Authority:** Engine-authoritative (most authoritative source of commit SHAs)

---

### `run_completed`

Written at session completion, inside the advance lock. Contains legacy git fields
captured in the response path (fast, 2s timeout per command).

| Field | Type | Authority | Notes |
|---|---|---|---|
| `startGitSha` | `string \| null` | Engine-authoritative | From `git_head_sha` observation |
| `endGitSha` | `string \| null` | Engine-authoritative | From `git rev-parse HEAD` at completion |
| `gitBranch` | `string \| null` | Engine-authoritative | From `git_branch` observation |
| `agentCommitShas` | `string[]` | Engine-authoritative | From `git log --no-merges --first-parent startSha..HEAD` |
| `captureConfidence` | `'high' \| 'none'` | Engine-authoritative | `high` when `endSha` present and commits found; `none` otherwise |
| `durationMs` | `number \| undefined` | Engine-authoritative | `lastEvent.timestampMs - firstEvent.timestampMs` |

**Note:** `captureConfidence` here is binary (`high`/`none`). For three-level
confidence with authoritative diff data, prefer `gitEvidence.captureConfidence`.

---

### `git_start_recorded`

Written fire-and-forget after `start_workflow` returns. Captures the working tree
state before the agent touches anything. Useful for knowing if the agent inherited
uncommitted work.

| Field | Type | Authority | Notes |
|---|---|---|---|
| `repoRoot` | `string` | Engine-authoritative | Workspace path |
| `stagedFiles` | `number` | Engine-authoritative | Files with staged changes at session start (`git diff --cached --numstat`) |
| `unstagedFiles` | `number` | Engine-authoritative | Files with unstaged changes at session start (`git diff --numstat`) |

**Written by:** `src/mcp/git-metrics/record.ts:recordGitStart()`
**Timeout:** 5000ms per command

---

### `git_metrics_recorded`

Written fire-and-forget after session completion (after `run_completed`). Contains
the authoritative git diff for the session run. Supersedes the scattered git fields
in `run_completed` for new sessions.

| Field | Type | Authority | Notes |
|---|---|---|---|
| `startSha` | `string \| null` | Engine-authoritative | From `run_completed` event |
| `endSha` | `string \| null` | Engine-authoritative | From `run_completed` event |
| `commitShas` | `string[]` | Engine-authoritative | From `git log --no-merges --first-parent startSha..HEAD` |
| `prRefs` | `number[]` | Engine-authoritative | Parsed from commit messages: `#N`, `Closes #N`, `Fixes #N`, `Refs #N` |
| `filesChanged` | `number \| null` | Engine-authoritative | From `git diff startSha..HEAD --numstat --no-renames`; null on failure |
| `linesAdded` | `number \| null` | Engine-authoritative | Same source; null on failure |
| `linesRemoved` | `number \| null` | Engine-authoritative | Same source; null on failure |
| `truncated` | `boolean` | Engine-authoritative | true when diff exceeded 10,000 lines (partial data) |
| `changedFilePaths` | `string[]` | Engine-authoritative | File paths from the diff (bounded by truncation limit) |
| `languageBreakdown` | `Record<string, number>` | Engine-authoritative | Extension → file count. Keys are lowercase with dot (`.ts`, `.swift`). Files without extension map to `''`. |
| `stagedFiles` | `number \| null` | Engine-authoritative | Staged file count at completion (`git diff --cached --numstat`); null on failure |
| `unstagedFiles` | `number \| null` | Engine-authoritative | Unstaged file count at completion (`git diff --numstat`); null on failure |
| `captureConfidence` | `'high' \| 'partial' \| 'none'` | Engine-authoritative | `high`: diff ran, SHAs differ; `partial`: SHAs available but diff failed/truncated; `none`: no git |
| `churnSignal` | `{ filesRemodified: number; windowDays: number } \| null` | Engine-authoritative | Files re-modified by other commits within `windowDays` (default 7) after session end. Capped at 100 files checked. null when git unavailable or no changed files. |

**Written by:** `src/mcp/git-metrics/record.ts:recordGitMetrics()`
**Timeouts:** diff 10,000ms, status/log 5,000ms

---

### `usage_recorded`

Written fire-and-forget after session completion. One event per MCP client detected.
Currently only Claude Code is implemented; Cursor and Antigravity are planned (#1117, #1118).

Detection: scans `~/.claude/projects/<encoded-workspace>/` for JSONL files containing
the WorkRail session ID in tool call payloads, then sums all assistant message usage blocks
with deduplication (Claude Code double-writes each turn; duplicates are skipped).

| Field | Type | Authority | Notes |
|---|---|---|---|
| `client` | `string` | Engine-authoritative | `'claude-code'` (others TBD) |
| `model` | `string \| null` | Engine-authoritative | Model ID from JSONL (e.g. `claude-sonnet-4-6`). null if not recorded. |
| `inputTokens` | `number` | Engine-authoritative | Total input tokens for the session |
| `outputTokens` | `number` | Engine-authoritative | Total output tokens |
| `cacheReadTokens` | `number` | Engine-authoritative | Cache read tokens (priced at ~$0.30/1M for Sonnet) |
| `cacheWriteTokens` | `number` | Engine-authoritative | Cache write tokens (priced at ~$3.75/1M for Sonnet) |
| `turns` | `number` | Engine-authoritative | Number of deduplicated assistant turns |

**Written by:** `src/mcp/client-usage/record.ts` via `src/mcp/handlers/v2-execution/index.ts`
**Coverage:** Only sessions where the client's JSONL file is found. Absent when workspace
path not set or JSONL correlation fails.

---

### `token_checkpoint`

Written fire-and-forget at `start_workflow` (phase: `start`) and session completion
(phase: `end`). Snapshots the cumulative token total for the entire conversation at
each boundary. The delta between end and start gives tokens consumed by this specific
workflow run (not the whole conversation).

**Key distinction from `usage_recorded`:** `usage_recorded` filters to turns containing
the session ID (session-attributed). Token checkpoints capture the full conversation
window -- any turns in between are included in the delta.

| Field | Type | Authority | Notes |
|---|---|---|---|
| `phase` | `'start' \| 'end'` | Engine-authoritative | Which boundary this snapshot represents |
| `inputTokens` | `number` | Engine-authoritative | Cumulative input tokens at snapshot time |
| `outputTokens` | `number` | Engine-authoritative | Cumulative output tokens |
| `cacheReadTokens` | `number` | Engine-authoritative | Cumulative cache read tokens |
| `cacheWriteTokens` | `number` | Engine-authoritative | Cumulative cache write tokens |
| `turns` | `number` | Engine-authoritative | Cumulative deduplicated turn count |

**End checkpoint verification:** The end checkpoint passes the session ID to the
reader, which verifies the JSONL file contains the session ID before accepting it.
This guards against picking up a different conversation file.

**Written by:** `src/mcp/handlers/v2-execution/index.ts:recordTokenCheckpoint()`

---

## SessionMetricsV2 Projection

`projectSessionMetricsV2(events)` in `src/v2/projections/session-metrics.ts` is the
single aggregation point. It reads all relevant events and returns a typed summary.
Returns `null` for sessions with no `run_completed` event (in-progress sessions or
very old sessions).

### Legacy git fields (from `run_completed`)

These fields exist for backward compatibility. For new sessions, prefer `gitEvidence`.

| Field | Type | Authority | Source event |
|---|---|---|---|
| `startGitSha` | `string \| null` | Engine-authoritative | `run_completed` |
| `endGitSha` | `string \| null` | Engine-authoritative | `run_completed` |
| `gitBranch` | `string \| null` | Engine-authoritative | `run_completed` |
| `agentCommitShas` | `readonly string[]` | Engine-authoritative | `run_completed` (from `git log`) |
| `captureConfidence` | `'high' \| 'none'` | Engine-authoritative | `run_completed` (binary; prefer `gitEvidence.captureConfidence`) |
| `durationMs` | `number \| undefined` | Engine-authoritative | `run_completed` |

### Agent-reported output metrics

Coverage ~53% of sessions (only when `metricsProfile` is set and agent complied).
Superseded by `gitEvidence` when available.

| Field | Type | Authority | Source |
|---|---|---|---|
| `outcome` | `'success' \| 'partial' \| 'abandoned' \| 'error' \| null` | Agent-reported | `context_set metrics_outcome` |
| `prNumbers` | `readonly number[]` | Agent-reported | `context_set metrics_pr_numbers` |
| `filesChanged` | `number \| null` | Agent-reported | `context_set metrics_files_changed` |
| `linesAdded` | `number \| null` | Agent-reported | `context_set metrics_lines_added` |
| `linesRemoved` | `number \| null` | Agent-reported | `context_set metrics_lines_removed` |

### Token usage

| Field | Type | Notes |
|---|---|---|
| `usageEvents` | `readonly ClientUsage[]` | One entry per detected client. Empty array when `usage_recorded` absent. |
| `tokenDelta` | `TokenSnapshot \| null` | End minus start checkpoint. null when either checkpoint is missing. |

`ClientUsage` fields: `client`, `model`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `turns`.

`TokenSnapshot` fields: `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `turns`.

### Engine-authoritative git evidence

| Field | Type | Notes |
|---|---|---|
| `gitEvidence` | `GitEvidence \| null` | null for sessions predating #1129. When present, supersedes legacy git fields. |

`GitEvidence` fields:

| Sub-field | Type | Notes |
|---|---|---|
| `startSha` | `string \| null` | Git HEAD at session start |
| `endSha` | `string \| null` | Git HEAD at session end |
| `commitShas` | `readonly string[]` | Commits created during session (`git log` from engine) |
| `prRefs` | `readonly number[]` | PR numbers parsed from commit messages |
| `committedDiff` | `GitCommittedDiff \| null` | null on diff failure; zero-valued struct on clean session |
| `committedDiff.filesChanged` | `number` | Files changed in committed work |
| `committedDiff.linesAdded` | `number` | Lines added in committed work |
| `committedDiff.linesRemoved` | `number` | Lines removed in committed work |
| `committedDiff.truncated` | `boolean` | true when diff exceeded 10,000 lines |
| `committedDiff.changedFilePaths` | `readonly string[]` | Changed file paths (bounded by truncation) |
| `committedDiff.languageBreakdown` | `Record<string, number>` | Extension → file count |
| `workingTree` | `GitWorkingTreeState \| null` | Working tree state at session completion |
| `workingTree.stagedFiles` | `number` | Staged but uncommitted files at end |
| `workingTree.unstagedFiles` | `number` | Unstaged files at end |
| `captureConfidence` | `'high' \| 'partial' \| 'none'` | Three-level confidence for the diff |
| `churnSignal` | `{ filesRemodified, windowDays } \| null` | Post-session churn detection |

### DAG topology counts

Derived from `node_created` events. 0 for sessions predating the feature or with no advances.

| Field | Type | Notes |
|---|---|---|
| `stepsCompleted` | `number` | Count of `node_created` events with `nodeKind='step'` |
| `retriesCount` | `number` | Count of `node_created` events with `nodeKind='blocked_attempt'` |

---

## Coverage Matrix

| Metric | MCP sessions | Daemon sessions | Requires | Since |
|---|---|---|---|---|
| `durationMs` | Yes | Yes | Always | Early |
| `startGitSha` / `endGitSha` | Yes | Yes | Git repo | Early |
| `agentCommitShas` | Yes | Yes | Git + commits | Early |
| `outcome` | ~53% | ~53% | `metricsProfile` + agent | #779 |
| `prNumbers` (agent) | ~40% | ~40% | `metricsProfile` + agent | #779 |
| `linesAdded` (agent) | ~30% | ~30% | `metricsProfile` + agent | #779 |
| `usageEvents` | Yes* | No | Claude Code JSONL | #1121 |
| `tokenDelta` | Yes* | No | Claude Code JSONL | #1125 |
| `gitEvidence` (diff) | Yes | Yes | Git repo | #1129 |
| `gitEvidence.languageBreakdown` | Yes | Yes | Git repo | #1131 |
| `gitEvidence.churnSignal` | Yes | Yes | Git repo + window | #1131 |
| `stepsCompleted` | Yes | Yes | Always | #1131 |
| `retriesCount` | Yes | Yes | Always | #1131 |
| `git_start_recorded` | Yes | Yes | Git repo | #1129 |

\* Requires `~/.claude/projects/` JSONL to be readable and session ID greppable.

---

## What is NOT captured

- **Dollar cost:** Token counts are present but pricing is not applied. Consumers multiply by model-specific rates.
- **PR merge rate:** Whether attributed PRs were actually merged requires async GitLab/GitHub polling after the session ends.
- **Step-level token breakdown:** Which steps consumed the most tokens. For daemon sessions, correlatable from daemon event logs; for MCP sessions, not available.
- **Tool call distribution:** How many times Bash/Read/Edit were called. Available in daemon event logs; not available for MCP sessions (tool calls are opaque to the engine).
- **Multi-repo tracking:** Only the primary workspace repo is tracked. If the agent worked in sibling repos, those are not captured.
- **Cursor / Antigravity token usage:** `usage_recorded` only covers Claude Code. Issues #1117 and #1118 track Cursor and Antigravity readers.

---

## Key files

| Purpose | File |
|---|---|
| Event schemas (Zod) | `src/v2/durable-core/schemas/session/events.ts` |
| Git evidence types | `src/v2/durable-core/schemas/session/git-evidence.ts` |
| Token/usage types | `src/v2/durable-core/schemas/session/usage.ts` |
| SessionMetricsV2 projection | `src/v2/projections/session-metrics.ts` |
| Git reader functions | `src/mcp/git-metrics/reader.ts` |
| Git fire-and-forget recorders | `src/mcp/git-metrics/record.ts` |
| Client usage readers | `src/mcp/client-usage/` |
| Token checkpoint recorder | `src/mcp/handlers/v2-execution/index.ts` |
| Workspace anchor (start SHA) | `src/v2/infra/local/workspace-anchor/index.ts` |
| Git end snapshot | `src/v2/infra/local/git-snapshot/index.ts` |
