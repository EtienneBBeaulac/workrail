# Implementation Plan: Engine-Side Git Metrics Collection

## 1. Problem Statement

WorkRail sessions capture git state (startSha, endSha, captureConfidence) in `run_completed` but two bugs prevent useful data from reaching consumers:
1. `captureConfidence` is permanently `'none'` for all sessions -- the condition `agentCommitShas.length > 0` is always false since PR #903 (agentCommitShas was deprecated to empty).
2. The committed diff (lines added/removed, files changed) is never captured -- only agent-reported context_set metrics_* values exist, which are unreliable.
3. No baseline dirty-state is captured at session start -- there is no record of whether the working tree was clean when the agent began.

## 2. Acceptance Criteria

All IDs trace to pre-registered criteria from Phase 5.

- [ ] **AC-1:** `git_start_recorded` event written fire-and-forget after `start_workflow` succeeds (when workspace path is provided).
- [ ] **AC-2:** `git_metrics_recorded` event written fire-and-forget after session completion (isComplete=true), containing committed diff stat between startSha and endSha, captureConfidence, and commit SHAs.
- [ ] **AC-3:** `captureConfidence` in `git_metrics_recorded` is `'high'` when endSha differs from startSha, `'partial'` when endSha present but equals startSha or diff failed, `'none'` when no git info available.
- [ ] **AC-4:** `projectSessionMetricsV2` returns non-null `gitEvidence` when `git_metrics_recorded` event is in the log; returns null gitEvidence when that event is absent (backward compat for old sessions).
- [ ] **AC-5:** Git operation failures and timeouts do not propagate as MCP tool errors; they are caught and produce null/partial results silently.
- [ ] **AC-6:** `run_completed` event schema is unchanged -- existing session logs parse correctly after the change.
- [ ] **[NEW-1]** All execFile calls set `maxBuffer: 5 * 1024 * 1024`. Rationale: without maxBuffer, pathological diffs could exhaust process memory before truncation (discovered in design review O-1).
- [ ] `npx vitest run` passes.
- [ ] `npm run build` clean.

## 3. Non-Goals

- No changes to the `run_completed` event schema.
- No changes to `captureConfidence` type on `run_completed` (remains `'high'|'none'`).
- No changes to `outcome-success.ts` beyond the captureConfidence condition fix.
- No new MCP tools or API endpoints.
- No console UI changes (gitEvidence will be available in SessionMetricsV2 but console rendering is out of scope).
- No git operations inside the session lock.

## 4. Philosophy-Driven Constraints

- **[PHILOSOPHY]** `GitEvidence` is an explicit domain type with named fields -- no `Record<string, unknown>` or `JsonValue` carriers.
- **[PHILOSOPHY]** Reader functions return null on failure, never throw -- errors are data.
- **[PHILOSOPHY]** Reader functions are pure async functions, not classes -- compose with small pure functions.
- **[PHILOSOPHY]** null on `committedDiff` and `workingTree` fields means command failed; zero-change result returns a zero-valued struct (not null).
- **[CONVENTION]** New events registered via `DomainEventEnvelopeV1Schema.extend({ kind: z.literal('...'), data: ... })` pattern.
- **[CONVENTION]** execFile not exec for all git commands (user-controlled repoRoot path).
- **[CONVENTION]** recordGitMetrics appended as await in the sequential async IIFE -- not a concurrent void call.
- **[TEAM_RULE]** Git operations fire-and-forget, NEVER inside outcome-success.ts lock chain.

## 5. Invariants

- **I-1:** `git_start_recorded` is written once per session (at session start) or not at all. Duplicate writes are prevented because the fire-and-forget only runs in the handleV2StartWorkflow success path.
- **I-2:** `git_metrics_recorded` is written once per session (at session completion) or not at all. Fires only when `isComplete=true` in the async IIFE.
- **I-3:** `run_completed` schema is unchanged -- any event log valid before this change is valid after.
- **I-4:** `null` on `GitEvidence.committedDiff` means the git diff command failed or timed out. `{ filesChanged: 0, linesAdded: 0, linesRemoved: 0, truncated: false }` means the command ran and found no changes.
- **I-5:** All git execFile calls set `maxBuffer: 5 * 1024 * 1024` to prevent unbounded memory use on large diffs.
- **I-6:** All git execFile calls set explicit timeouts: 10000ms for diff, 5000ms for status/log.

## 6. Selected Approach

**Candidate B:** Two new events (`git_start_recorded`, `git_metrics_recorded`), new `src/mcp/git-metrics/` module (types/reader/record/index), wired fire-and-forget in `handleV2StartWorkflow` and the completion async IIFE. `SessionMetricsV2` extended with `gitEvidence: GitEvidence | null`.

See `/Users/etienneb/git/personal/workrail/docs/design/git-metrics-candidates.md` for full design candidate rationale.

## 7. Slices

### Slice 1: Event schemas + constants (no behavior change)

**Files:**
- `src/v2/durable-core/constants.ts` -- add `GIT_START_RECORDED: 'git_start_recorded'` and `GIT_METRICS_RECORDED: 'git_metrics_recorded'` to `EVENT_KIND`
- `src/v2/durable-core/schemas/session/events.ts` -- add `git_start_recorded` and `git_metrics_recorded` to `DomainEventV1Schema` discriminated union

**Done when:** `npm run build` clean with new event kinds. TypeScript discriminated union updated.

**AC traced:** AC-6 (run_completed schema unchanged), AC-2 (event exists).

**Implementation notes:**
- `git_start_recorded` data: `{ stagedFiles: number, unstagedFiles: number, repoRoot: string }`
- `git_metrics_recorded` data: `{ startSha: string | null, endSha: string | null, commitShas: readonly string[], filesChanged: number | null, linesAdded: number | null, linesRemoved: number | null, truncated: boolean, stagedFiles: number | null, unstagedFiles: number | null, captureConfidence: z.enum(['high', 'partial', 'none']), prRefs: readonly number[] }`

### Slice 2: src/mcp/git-metrics/ module

**Files (new):**
- `src/mcp/git-metrics/types.ts`
- `src/mcp/git-metrics/reader.ts`
- `src/mcp/git-metrics/record.ts`
- `src/mcp/git-metrics/index.ts`

**Done when:** Module exports `recordGitStart` and `recordGitMetrics`, reader functions return correct types, all functions are covered by unit tests.

**AC traced:** AC-1, AC-2, AC-3, AC-5, NEW-1.

**Implementation notes:**
- `readWorkingTreeState(repoRoot, timeoutMs)`: runs `git diff --cached --numstat` and `git diff --numstat`, returns `{ stagedFiles, unstagedFiles }` or null on failure.
- `readCommittedDiff(repoRoot, startSha, timeoutMs)`: runs `git diff startSha..HEAD --numstat --no-renames`, returns `{ filesChanged, linesAdded, linesRemoved, truncated }` or null on failure. Truncates at 10000 lines.
- `parseCommitMessages(repoRoot, startSha, timeoutMs)`: runs `git log --pretty=format:%s%n%b --no-merges --first-parent startSha..HEAD`, returns commit SHAs and PR refs parsed from message body.
- `readCommitShas(repoRoot, startSha, timeoutMs)`: runs `git log --no-merges --first-parent --format=%H startSha..HEAD`.
- All execFile calls: `maxBuffer: 5 * 1024 * 1024`, explicit timeout.
- `recordGitStart(sessionId, repoRoot, sessionStore, gate, idFactory)`: calls readWorkingTreeState, appends git_start_recorded event.
- `recordGitMetrics(sessionId, repoRoot, startSha, sessionStore, gate, idFactory)`: runs all reader functions, computes captureConfidence, appends git_metrics_recorded event.
- PR ref parsing: match `#\d+`, `Closes #\d+`, `Fixes #\d+`, `Refs #\d+` in commit message bodies.

### Slice 3: captureConfidence bug fix in outcome-success.ts

**Files:**
- `src/mcp/handlers/v2-advance-core/outcome-success.ts` -- change line ~272 condition

**Done when:** Condition reads `endSha !== null && commitShas.length > 0 ? 'high' : 'none'`.

**AC traced:** AC-3 (indirect -- git_metrics_recorded uses its own captureConfidence, but this fix prevents the run_completed value from being further misleading).

**Note:** This is a minimal correctness fix. It does NOT add 'partial' to the run_completed captureConfidence (schema unchanged per I-3).

### Slice 4: Wiring in handleV2StartWorkflow and handleV2ContinueWorkflow

**Files:**
- `src/mcp/handlers/v2-execution/index.ts`

**Done when:** `recordGitStart` fires after handleV2StartWorkflow success. `recordGitMetrics` is the third await in the completion async IIFE.

**AC traced:** AC-1, AC-2, AC-5.

**Implementation notes:**
```typescript
// In handleV2StartWorkflow success branch (after recordTokenCheckpoint):
void recordGitStart(result.sessionId, input.workspacePath, guard.ctx.v2.sessionStore, guard.ctx.v2.gate, guard.ctx.v2.idFactory);

// In the completion async IIFE:
void (async () => {
  await collectAndRecordUsage(sessionId, sessionStore, gate, idFactory);
  await recordTokenCheckpoint(sessionId, 'end', undefined, sessionStore, gate, idFactory);
  await recordGitMetrics(sessionId, sessionStore, gate, idFactory);
})();
```

Note: `recordGitMetrics` must re-read the session store to find the repoRoot and startSha (same pattern as collectAndRecordUsage re-reading for workspacePath).

### Slice 5: SessionMetricsV2 projection extension

**Files:**
- `src/v2/projections/session-metrics.ts` -- add `gitEvidence: GitEvidence | null` field, read from `git_metrics_recorded` event

**Done when:** `projectSessionMetricsV2` returns `gitEvidence` populated from `git_metrics_recorded` when present, null when absent.

**AC traced:** AC-4.

**Implementation notes:**
- Add `@deprecated` JSDoc on existing `captureConfidence` field (Y-1 from design review).
- gitEvidence projection reads git_metrics_recorded event and maps to GitEvidence type.
- Backward compat: sessions without git_metrics_recorded return `gitEvidence: null`.

### Slice 6: console/src/api/types.ts mirror type

**Files:**
- `console/src/api/types.ts` -- add `GitEvidence` type matching the projection output

**Done when:** Console API type mirrors GitEvidence.

**AC traced:** (infrastructure for future console rendering -- no dedicated AC, but required for type consistency).

### Slice 7: Tests

**Files (new):**
- `tests/unit/git-metrics-reader.test.ts` -- reader unit tests with mocked execFile
- `tests/unit/git-metrics-projection.test.ts` -- projection tests for gitEvidence field

**Done when:** Tests pass for: reader returns null on execFile failure; reader truncates at 10000 lines; captureConfidence='high' when commitShas.length > 0; captureConfidence='partial' when endSha != startSha but diff failed; gitEvidence=null when git_metrics_recorded absent; gitEvidence populated when event present.

**AC traced:** AC-1 through AC-6.

## 8. Test Design

**Unit tests (automated):**
- Reader functions with mocked execFile: success case, failure case, timeout case, truncation case.
- `parseCommitMessages` with PR ref patterns: `#123`, `Closes #456`, `Fixes #789`, none.
- `captureConfidence` computation: all three cases.
- `projectSessionMetricsV2` with and without `git_metrics_recorded` event in event log.

**Integration tests:**
- Not required for this PR -- the fire-and-forget pattern is tested by existing integration tests for collectAndRecordUsage and recordTokenCheckpoint.

**Regression:**
- Existing `tests/lifecycle/bundled-workflow-smoke.test.ts` and `tests/unit/session-metrics.test.ts` must continue to pass without modification (AC-4 backward compat).

## 9. Risk Register

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| maxBuffer exhausted before truncation | Low | High (OOM) | Set maxBuffer: 5MB; truncation is secondary defense |
| SESSION_LOCK_REENTRANT if recordGitMetrics runs concurrently | Low | Medium (silent data loss) | Sequential await in async IIFE |
| git_metrics_recorded event silent loss after terminal state | Low | Low (no session correctness impact) | Confirmed safe by collectAndRecordUsage pattern |
| TypeScript exhaustive switch breakage from new event kinds | Medium | Low (compile error, caught in CI) | Run npm run build before PR |

## 10. PR Packaging

**estimatedPRCount:** 1 (single PR: `feat/etienneb/git-metrics`)

All slices ship together. No slice is useful without the others (schema + reader + wiring + projection + tests must all land together).

## 11. Follow-Up Tickets

- Console rendering of gitEvidence (display committed diff in session detail panel).
- Audit of sessions missing git_metrics_recorded (monitoring gap noted in design review).
- Deprecate and eventually remove legacy `captureConfidence`, `startGitSha`, `endGitSha` from SessionMetricsV2 after gitEvidence is the established path.

## 12. Unresolved Questions

None. All questions resolved during design phases.

**unresolvedUnknownCount:** 0
**planConfidenceBand:** High
