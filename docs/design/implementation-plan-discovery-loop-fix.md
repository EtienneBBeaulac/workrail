# Implementation Plan: Discovery Loop Fix

**Date:** 2026-04-19
**Branch:** `fix/discovery-loop-timeout-and-label`
**Commit:** `fix(coordinator): thread session timeouts, inspect PipelineOutcome, add sidecar idempotency`

---

## 1. Problem Statement

WorkTrain's pipeline re-ran `wr.discovery` on issue #393 at least 73 times over 19+ hours. Three root causes create an infinite re-selection loop:

1. `spawnSession()` passes no `agentConfig` -- sessions inherit `DEFAULT_SESSION_TIMEOUT_MINUTES=30`, but the coordinator waits 55 minutes. Sessions die at 30m; coordinator times out at 55m and escalates.
2. `PipelineOutcome` is silently discarded in `polling-scheduler.ts` -- no label is applied on escalation, so the issue is re-selected on every poll cycle.
3. `checkIdempotency()` sidecar scan is dead -- `persistTokens()` never writes a `context` field, so every session file is treated as `'clear'`.

---

## 2. Acceptance Criteria

- `spawnSession` with `agentConfig.maxSessionMinutes` threads through to `runWorkflowFn` (Fix 1)
- On `PipelineOutcome.kind === 'escalated'`, `applyGitHubLabel` is called with `worktrain:in-progress` (Fix 2)
- On `PipelineOutcome.kind === 'success'`, no label is applied (Fix 2)
- Issue-ownership sidecar is written before dispatch and deleted on completion (Fix 3)
- Expired sidecar (TTL exceeded) returns `'clear'` from `checkIdempotency` (Fix 3)
- `npm run build` passes with no errors
- `npx vitest run` passes with no regressions

---

## 3. Non-Goals

- Do NOT touch `src/mcp/`
- N-strike mechanism (label applied only after N escalations) -- deferred
- Coordinator-owns-termination refactor -- deferred
- Unassigning bot from issue on escalation -- not in spec
- Daemon startup sidecar cleanup -- deferred
- Exhaustive TypeScript switch on PipelineOutcome kinds -- deferred (if-check satisfies spec)

---

## 4. Philosophy-Driven Constraints

- All new interface fields are `readonly`
- `applyGitHubLabel` uses injected `fetchFn` (not `globalThis.fetch` directly)
- Sidecar write failure must NOT block dispatch (fire-and-forget, log warn)
- `applyGitHubLabel` failure must NOT block poll cycle cleanup (log warn, continue)
- ESM imports use `.js` extension
- New types: discriminated union `PipelineOutcome` already exists -- use it, don't re-create

---

## 5. Invariants

1. **Fix 1 + Fix 2 ship together** -- deploying Fix 2 without Fix 1 causes every FULL-mode issue to escalate (30m timeout) and get permanently labeled
2. **Label = `worktrain:in-progress`** -- already in `queueConfig.excludeLabels` (polling-scheduler.ts:505); using a new label requires operator config change with no enforcement
3. **Sidecar TTL = `DISCOVERY_TIMEOUT_MS + 60_000`** ms -- handles crash case; expired sidecar = eligible for re-dispatch
4. **Conservative idempotency**: malformed sidecar = 'active' (never allow double-dispatch)
5. **Sidecar written before dispatch, deleted in both .then() and .catch()**

---

## 6. Selected Approach

**Candidate A**: Exact spec implementation.

- Fix 1: Add optional 5th param `agentConfig?` to `CoordinatorDeps.spawnSession` in `pr-review.ts`, thread through `trigger-listener.ts` to `routerRef.dispatch()`, pass correct timeouts at 4 spawn sites in `full-pipeline.ts`
- Fix 2: Change `Promise<unknown>` to `Promise<PipelineOutcome>` in `polling-scheduler.ts`, inspect outcome, add `applyGitHubLabel` private method
- Fix 3: Write `queue-issue-<N>.json` sidecar in `doPollGitHubQueue`, extend `checkIdempotency` to check sidecar files by filename pattern with TTL check

**Runner-up**: Candidate B (separate sidecar function). Lost: creates coordination risk with two callsites.

---

## 7. Vertical Slices

### Slice 1: Fix 1 -- Thread maxSessionMinutes through spawnSession

**Files changed**:
- `src/coordinators/pr-review.ts` -- add optional `agentConfig?: { readonly maxSessionMinutes?: number; readonly maxTurns?: number }` as 5th param to `CoordinatorDeps.spawnSession`
- `src/coordinators/adaptive-pipeline.ts` -- `AdaptiveCoordinatorDeps` extends `CoordinatorDeps`, so this is automatically propagated; no change needed here
- `src/trigger/trigger-listener.ts` -- add `agentConfig?: { readonly maxSessionMinutes?: number; readonly maxTurns?: number }` as 5th param to `spawnSession` closure, forward to `routerRef.dispatch({ ..., agentConfig })`
- `src/coordinators/modes/full-pipeline.ts` -- pass `{ maxSessionMinutes: Math.ceil(DISCOVERY_TIMEOUT_MS / 60_000) }` (=55) at discovery spawn, `{ maxSessionMinutes: Math.ceil(SHAPING_TIMEOUT_MS / 60_000) }` (=35) at shaping spawn, `{ maxSessionMinutes: Math.ceil(REVIEW_TIMEOUT_MS / 60_000) }` (=25) at UX design spawn, `{ maxSessionMinutes: Math.ceil(CODING_TIMEOUT_MS / 60_000) }` (=65) at coding spawn

**Done when**: TypeScript compiles cleanly; `spawnSession` at all call sites passes the correct agentConfig

### Slice 2: Fix 2 -- Inspect PipelineOutcome and apply worktrain:in-progress label

**Files changed**:
- `src/trigger/polling-scheduler.ts`:
  - Add import: `import type { PipelineOutcome } from '../coordinators/adaptive-pipeline.js';`
  - Add import: `import { DISCOVERY_TIMEOUT_MS } from '../coordinators/adaptive-pipeline.js';`
  - Change `Promise<unknown>` to `Promise<PipelineOutcome>` at L605-610
  - Change `.then(() => {` to `.then((outcome: PipelineOutcome) => {`
  - Add label application for `outcome.kind === 'escalated' || outcome.kind === 'dry_run'`
  - Add private method `applyGitHubLabel(issueNumber: number, label: string, token: string, repo: string): Promise<void>`
    - POST `https://api.github.com/repos/${repo}/issues/${issueNumber}/labels`
    - Body: `JSON.stringify({ labels: [label] })`
    - Headers: `Authorization: Bearer ${token}`, `Accept: application/vnd.github+json`, `Content-Type: application/json`
    - Uses `(this.fetchFn as QueueFetchFn | undefined) ?? globalThis.fetch`
    - Non-fatal: catch error, console.warn, return

**Done when**: On escalated/dry_run outcome, `applyGitHubLabel` is called with `('worktrain:in-progress', queueConfig.token, source.repo)`

### Slice 3: Fix 3 -- Write/delete sidecar and extend checkIdempotency

**Files changed**:
- `src/trigger/polling-scheduler.ts`:
  - Before dispatch call: write `queue-issue-<N>.json` to `sessionsDir` with `{ issueNumber, triggerId, dispatchedAt: Date.now(), ttlMs: DISCOVERY_TIMEOUT_MS + 60_000 }`
  - In `.then()` handler: delete the sidecar file (fire-and-forget, ignore errors)
  - In `.catch()` handler: delete the sidecar file (fire-and-forget, ignore errors)
- `src/trigger/adapters/github-queue-poller.ts`:
  - In `checkIdempotency`, before the main scan loop, check if `queue-issue-${issueNumber}.json` exists in `sessionsDir`
  - If file exists: parse it, check `dispatchedAt + ttlMs > Date.now()` -- if true (not expired), return 'active'; if false (expired), return 'clear' for this file
  - On any parse error for the sidecar: return 'active' (conservative)
  - Update JSDoc to describe sidecar file format

**Done when**: Sidecar is written before dispatch, deleted on completion; `checkIdempotency` returns 'active' for active sidecar and 'clear' for expired sidecar

### Slice 4: Tests

**New file**: `tests/unit/discovery-loop-fix.test.ts`

**Test cases**:

1. `spawnSession with agentConfig.maxSessionMinutes threads through to dispatch call`
   - Create a fake `routerRef` that captures dispatch calls
   - Call `coordinatorDeps.spawnSession('wr.discovery', goal, workspace, undefined, { maxSessionMinutes: 55 })`
   - Assert dispatch was called with `agentConfig: { maxSessionMinutes: 55 }`
   - Note: This tests trigger-listener.ts via integration or by testing the coordinator deps implementation directly

2. `On PipelineOutcome.kind === escalated, applyGitHubLabel is called with worktrain:in-progress`
   - Create a fake router with `dispatchAdaptivePipeline` returning `{ kind: 'escalated', escalationReason: { phase: 'discovery', reason: 'timeout' } }`
   - Create a fake fetchFn that captures calls
   - Run `doPollGitHubQueue` (via private method cast)
   - Assert fetchFn was called with URL containing `/labels` and body containing `worktrain:in-progress`

3. `On PipelineOutcome.kind === success, no label is applied`
   - Same setup but `dispatchAdaptivePipeline` returns `{ kind: 'merged', prUrl: 'https://github.com/...' }`
   - Assert fetchFn was NOT called with a labels URL

4. `Issue-ownership sidecar is written before dispatch and deleted on completion`
   - Create a tmpDir for sessionsDir
   - Run `doPollGitHubQueue`
   - Assert sidecar file exists after dispatch setup but is deleted after completion
   - Note: Since dispatch is async, check sidecar presence inside the `dispatchAdaptivePipeline` mock

5. `Expired sidecar (TTL exceeded) returns 'clear' from checkIdempotency`
   - Write a sidecar file with `{ issueNumber: 42, triggerId: 'x', dispatchedAt: 0, ttlMs: 1 }` (already expired)
   - Call `checkIdempotency(42, tmpDir)`
   - Assert result is `'clear'`

---

## 8. Test Design

**File**: `tests/unit/discovery-loop-fix.test.ts`
**Framework**: Vitest with `vi.fn()` fakes
**Fixtures**: tmpDir for session files, fake fetchFn capturing calls, fake router returning specific PipelineOutcome kinds

Key patterns from existing tests:
- Private method access: `(scheduler as unknown as { doPollGitHubQueue(...) }).doPollGitHubQueue(...)`
- Fake router: `{ dispatchAdaptivePipeline: async (...) => { return { kind: 'escalated', ... } } }`
- Queue config: use `vi.mock` or provide a mock `loadQueueConfig`

Note: The `spawnSession` agentConfig threading test (test case 1) may be better placed in an integration test that creates a real `trigger-listener.ts` environment. Given the complexity, a unit test that mocks the router and verifies the dispatch call args is acceptable.

---

## 9. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| GitHub token expired at label application time | Low | Issue loops again | Warn log is the signal; no code mitigation needed |
| Sidecar accumulation if delete fails | Low | Manual cleanup needed | TTL handles cleanup after 56m |
| TypeScript error from 5th optional param on test fakes | Low | Build fails | vi.fn() mocks don't enforce param count |
| Import of DISCOVERY_TIMEOUT_MS creates circular dep | Low | Build fails | adaptive-pipeline.ts has no deps on polling-scheduler.ts |

---

## 10. PR Packaging Strategy

**Single PR** on branch `fix/discovery-loop-timeout-and-label`
All 3 fixes + tests in one PR. Fixes 1 and 2 are coupled -- they cannot be split.

---

## 11. Philosophy Alignment

| Principle | Slice | Status |
|---|---|---|
| Immutability by default | 1 (agentConfig fields readonly) | Satisfied |
| Type safety | 2 (Promise<PipelineOutcome>) | Satisfied |
| Errors are data | 2 (applyGitHubLabel fire-and-forget) | Tension -- acceptable for non-fatal I/O |
| Dependency injection | 2 (fetchFn injected) | Satisfied |
| Exhaustiveness | 2 (all 3 outcome kinds handled) | Satisfied |
| YAGNI | All | Satisfied -- no extra abstractions |
| Document why not what | 3 (JSDoc update for checkIdempotency) | Satisfied |
| Determinism | 3 (TTL check adds wall-clock dep) | Tension -- acceptable for crash recovery |
