# Discovery Loop Investigation B: wr.discovery Infinite Re-run on Issue #393

**Date:** 2026-04-21
**Issue:** GitHub #393 - "test(daemon): add coverage for loadSessionNotes failure paths"
**Symptom:** Autonomous pipeline repeatedly runs `wr.discovery` sessions on issue #393. Each session runs for ~30 minutes then stops with `outcome: timeout`. The pipeline never progresses to shaping or coding. The issue stays assigned to `worktrain-etienneb`. The queue keeps re-selecting it every poll cycle.

---

## Timeline of What Actually Happened

All timestamps are UTC. Source: `~/.workrail/events/daemon/2026-04-21.jsonl` and `~/.workrail/queue-poll.jsonl`.

### 2026-04-20 19:10 - Loop begins

Issue #393 is assigned to `worktrain-etienneb` and has a `## Acceptance Criteria` checklist section in its body. `inferMaturity()` scores it as `specced`.

Queue poll starts selecting it every ~5 minutes:

```
19:10:53  task_selected  reason="has acceptance criteria or checklist"
19:15:48  task_selected  ...
19:20:48  task_selected  ...
... (continues hourly or more frequently through 2026-04-21)
```

Each selection dispatches `dispatchAdaptivePipeline(goal="test(daemon): ...", workspace=".../workrail")`. The goal contains no PR/MR reference and no dep-bump keyword, so `routeTask()` returns `FULL`. The FULL pipeline spawns `wr.discovery`.

### 2026-04-21 01:53 - First wr.discovery sessions start

```
01:53:42  session_started  wr.discovery  cd2f1c1f
01:55:30  session_started  wr.discovery  0913d66e
01:57:11  session_started  wr.discovery  03b13b82
01:58:53  session_started  wr.discovery  b586dba9
02:01:01  session_started  wr.discovery  3846e2a5
02:02:44  session_started  wr.discovery  2976d1db
```

Multiple sessions are spawned near-simultaneously because the daemon restarted many times between 01:50 and 02:07 (15+ restarts logged). Each restart clears the in-memory `dispatchingIssues` set, so the idempotency guard is reset and the queue re-dispatches on the first poll cycle after each restart.

### 2026-04-21 05:24 onward - Single-session steady-state

From 05:24 onward, one `wr.discovery` session is spawned per hour (matching the queue poll interval). The pattern is:

```
05:24:20  session_started   wr.discovery  747b8b81
05:54:20  session_completed wr.discovery  747b8b81  outcome=timeout

06:24:15  session_started   wr.discovery  063f67e3
06:54:15  session_completed wr.discovery  063f67e3  outcome=timeout

07:24:15  session_started   wr.discovery  c816e662
07:54:15  session_completed wr.discovery  c816e662  outcome=timeout
... (continues through 13:24)
```

Every session runs for exactly 30 minutes, then times out. No shaping, coding, or review sessions are ever spawned. The issue remains open and assigned to `worktrain-etienneb` throughout.

---

## What Should Have Happened

1. Queue selects issue #393 (maturity=`specced`). **[Correct]**
2. `dispatchAdaptivePipeline` routes to FULL mode. **[Correct]**
3. FULL pipeline spawns `wr.discovery` with `DISCOVERY_TIMEOUT_MS = 55 minutes`. **[Correct - coordinator side]**
4. `wr.discovery` completes successfully within 55 minutes.
5. FULL pipeline reads the handoff artifact, spawns `wr.shaping`, then `wr.coding-task`.
6. Coding session opens a PR. PR review runs. PR merges.
7. Post-merge: issue #393 is closed (either automatically by GitHub when the PR closes it, or explicitly).
8. On the next queue poll, `pollGitHubQueueIssues()` fetches only open issues - #393 would no longer appear, ending the loop.

Instead:
- `wr.discovery` sessions time out at 30 minutes (not 55).
- The FULL pipeline escalates.
- No downstream phases run.
- The GitHub issue stays open and assigned.
- The queue re-selects the issue on every poll cycle indefinitely.

---

## Root Causes

### Root Cause 1 (Primary): Session timeout mismatch - 30 min vs. 55 min

**File:** `src/daemon/workflow-runner.ts:83` and `src/trigger/trigger-listener.ts:436-498`

`DEFAULT_SESSION_TIMEOUT_MINUTES = 30` is the default applied to all sessions that do not receive an explicit `agentConfig.maxSessionMinutes` override.

When the coordinator calls `deps.spawnSession('wr.discovery', ...)`, the implementation in `trigger-listener.ts:492-498` calls `routerRef.dispatch({ workflowId, goal, workspacePath, context, _preAllocatedStartResponse })`. Note that **no `agentConfig` field is passed**. This means the spawned `wr.discovery` session runs under `DEFAULT_SESSION_TIMEOUT_MINUTES = 30`.

The coordinator then calls `deps.awaitSessions([discoveryHandle], DISCOVERY_TIMEOUT_MS)` where `DISCOVERY_TIMEOUT_MS = 55 * 60 * 1000` (55 minutes). But the session itself has already timed out at 30 minutes and returned `outcome: timeout` to the `awaitSessions` poller.

The mismatch:

| Layer | Timeout value | Where set |
|---|---|---|
| Session wall-clock (actual) | 30 min | `workflow-runner.ts:83` `DEFAULT_SESSION_TIMEOUT_MINUTES` |
| Coordinator await (expected) | 55 min | `adaptive-pipeline.ts:39` `DISCOVERY_TIMEOUT_MS` |

The coordinator's 55-minute budget is never consumed because the session dies first at 30 minutes. `awaitSessions` sees `outcome: timeout`, the FULL pipeline returns `{ kind: 'escalated', escalationReason: { phase: 'discovery', reason: 'discovery session timeout' } }`, and nothing more is done.

**Why the sessions time out:** The `wr.discovery` workflow has 22 steps. It needs to do landscape analysis, candidate generation, direction selection, and handoff preparation. 30 minutes is insufficient for this on a complex task, especially when the session is also attempting delegation via `spawn_agent` (which eats into the parent's wall-clock budget).

### Root Cause 2 (Primary): No post-escalation issue lifecycle management

**File:** `src/trigger/polling-scheduler.ts:616-624`

When `dispatchAdaptivePipeline` resolves (with any outcome including `escalated`), the only action taken is:

```typescript
void dispatchP
  .then(() => {
    this.dispatchingIssues.delete(top.issue.number);  // only action
    console.log(`[QueuePoll] in-flight-clear #${top.issue.number} reason=completed`);
  })
  .catch(() => {
    this.dispatchingIssues.delete(top.issue.number);  // only action
    console.log(`[QueuePoll] in-flight-clear #${top.issue.number} reason=error`);
  });
```

The `PipelineOutcome` returned by the coordinator is **silently discarded**. There is no code that:

- Inspects `outcome.kind` (could be `merged`, `escalated`, or `dry_run`)
- Adds a `worktrain:failed` or `worktrain:in-progress` label to the GitHub issue on escalation
- Posts a comment explaining the failure
- Closes the issue if merged
- Persists the session ID to the `daemon-sessions/` directory (the sidecar idempotency store)

Without any of these, the queue's only guard against re-selecting a completed/escalated issue is:
1. **`worktrain:in-progress` label check** (H3 in `doPollGitHubQueue`) - never added
2. **`/sess_[a-z0-9]+/` in issue body** (H3) - never added
3. **`dispatchingIssues` in-memory set** - cleared on `dispatchAdaptivePipeline` completion and lost on every daemon restart
4. **`checkIdempotency()` sidecar scan** - scans `~/.workrail/daemon-sessions/`, but that directory is always empty (the coordinator never writes session files there)
5. **GitHub issue state = closed** - never triggered because the pipeline never reaches merge

All five guards fail. The issue is re-selected on every subsequent poll cycle.

### Root Cause 3 (Contributing): In-memory `dispatchingIssues` lost on daemon restart

**File:** `src/trigger/polling-scheduler.ts:113`, `private readonly dispatchingIssues = new Set<number>()`

The `dispatchingIssues` set is in-memory only. Each daemon restart clears it completely. The daemon restarted 15+ times between 01:50-02:07 and multiple times thereafter. Every restart causes the set to be re-initialized empty, so the first poll cycle after each restart re-dispatches #393 even if the previous pipeline is still in flight.

The queue poll log shows this clearly:

```
01:10:39  task_skipped   reason=active_session_in_process  (set is live)
01:12:29  task_selected  reason=...                         (daemon restarted, set cleared)
01:12:39  task_skipped   reason=active_session_in_process  (set re-populated)
01:16:06  task_selected  reason=...                         (daemon restarted again)
```

The sidecar idempotency check (`checkIdempotency()` scanning `~/.workrail/daemon-sessions/`) was designed to handle cross-restart dedup, but it only works if the coordinator writes JSON files to that directory. It never does.

### Root Cause 4 (Contributing): `daemon-sessions/` directory never populated by coordinator

**File:** `src/trigger/adapters/github-queue-poller.ts:86`, `src/trigger/trigger-listener.ts:436-498`

`checkIdempotency()` scans `~/.workrail/daemon-sessions/` for JSON files containing `context.taskCandidate.issueNumber`. The directory is empty at time of investigation. The coordinator's `spawnSession()` implementation does not write any file to `daemon-sessions/`. The comment in `checkIdempotency()` says:

> "real session files written by persistTokens() contain only { continueToken, checkpointToken, ts } -- no context field. A file without taskCandidate cannot claim ownership of any issue."

So even if a file were written, it would be read as `clear` (not `active`) because it would have no `context.taskCandidate.issueNumber`. The sidecar idempotency check is effectively dead for coordinator-spawned sessions.

---

## Evidence Summary

| Evidence | Source |
|---|---|
| 13 wr.discovery sessions completed with `outcome=timeout`, all at exactly ~30 min | `events/daemon/2026-04-21.jsonl` |
| `DEFAULT_SESSION_TIMEOUT_MINUTES = 30` | `src/daemon/workflow-runner.ts:83` |
| `DISCOVERY_TIMEOUT_MS = 55 * 60 * 1000` | `src/coordinators/adaptive-pipeline.ts:39` |
| `spawnSession()` passes no `agentConfig` to `routerRef.dispatch()` | `src/trigger/trigger-listener.ts:492-498` |
| 73 `task_selected` events for #393 across 19+ hours | `~/.workrail/queue-poll.jsonl` |
| 0 shaping or coding sessions spawned | `events/daemon/2026-04-21.jsonl` (no `session_started` for `wr.shaping` or `wr.coding-task` linked to #393) |
| `dispatchAdaptivePipeline` result never inspected | `src/trigger/polling-scheduler.ts:616-624` |
| `daemon-sessions/` directory is empty | `ls ~/.workrail/daemon-sessions/` |
| GitHub issue #393 remains `OPEN`, assigned to `worktrain-etienneb` | `gh issue view 393` |
| 15+ daemon restarts between 01:50-02:07 | `events/daemon/2026-04-21.jsonl` (daemon_started/stopped events) |

---

## Recommended Fixes

### Fix 1 (Critical): Pass `agentConfig.maxSessionMinutes` in coordinator's `spawnSession()`

**File:** `src/trigger/trigger-listener.ts` (the `spawnSession` implementation, lines 492-498) or `src/coordinators/modes/full-pipeline.ts` (the call site).

The `spawnSession` signature already accepts a `context` parameter. The fix is to thread `agentConfig` through the spawn call so the child session gets the correct timeout budget.

**Option A:** Extend `CoordinatorDeps.spawnSession` to accept an optional `agentConfig` parameter:

```typescript
// In pr-review.ts (CoordinatorDeps interface):
readonly spawnSession: (
  workflowId: string,
  goal: string,
  workspace: string,
  context?: Readonly<Record<string, unknown>>,
  agentConfig?: { readonly maxSessionMinutes?: number; readonly maxTurns?: number },
) => Promise<Result<string | null, string>>;
```

Then in `full-pipeline.ts`, pass the coordinator's per-phase timeout:

```typescript
const discoverySpawnResult = await deps.spawnSession(
  'wr.discovery',
  opts.goal,
  opts.workspace,
  undefined,
  { maxSessionMinutes: Math.ceil(DISCOVERY_TIMEOUT_MS / 60_000) },  // 55
);
```

And in `trigger-listener.ts`, forward the agentConfig to the dispatch call:

```typescript
routerRef.dispatch({
  workflowId,
  goal,
  workspacePath: workspace,
  context,
  agentConfig,  // forward the injected agentConfig
  _preAllocatedStartResponse: startResult.value.response,
});
```

**Option B (simpler, no signature change):** Set a higher default in `~/.workrail/config.json` or in the trigger definition's `agentConfig.maxSessionMinutes`. This avoids code changes but requires operator action and is less principled (the coordinator already has the right value; it should communicate it).

**Recommendation:** Option A. The coordinator knows the correct budget for each phase. Passing it explicitly is a tighter invariant than relying on a global default. The mismatch between `DEFAULT_SESSION_TIMEOUT_MINUTES=30` and `DISCOVERY_TIMEOUT_MS=55` is a latent bug that would also affect shaping (35 min > 30 min) and coding (65 min > 30 min) sessions.

### Fix 2 (Critical): Handle PipelineOutcome in the queue poller

**File:** `src/trigger/polling-scheduler.ts:616-624`

The `dispatchP.then/catch` blocks must inspect the outcome and take action when the pipeline escalates:

```typescript
void dispatchP
  .then((outcome) => {
    this.dispatchingIssues.delete(top.issue.number);
    if (outcome.kind === 'escalated') {
      // Add worktrain:failed label + comment to prevent re-selection
      void this.markIssueEscalated(top.issue, outcome.escalationReason, source);
    } else if (outcome.kind === 'merged') {
      // Issue should be closed by the PR, but add a log entry
      console.log(`[QueuePoll] pipeline merged for #${top.issue.number}`);
    }
  })
  .catch((err) => {
    this.dispatchingIssues.delete(top.issue.number);
    void this.markIssueEscalated(top.issue, { phase: 'dispatch', reason: String(err) }, source);
  });
```

`markIssueEscalated()` should:
1. Add the `worktrain:failed` label to the issue (which is already checked by H3 as `active_session_or_in_progress` - or add a dedicated `worktrain:failed` label to `queueConfig.excludeLabels`)
2. Post a comment with the escalation reason for operator visibility

Alternatively, a simpler guard: add `worktrain:failed` to `queueConfig.excludeLabels` and have the poller add that label on escalation.

### Fix 3 (Important): Persist issue ownership to `daemon-sessions/` for cross-restart idempotency

**File:** `src/trigger/polling-scheduler.ts` (in `doPollGitHubQueue`) or `src/trigger/trigger-listener.ts` (in `spawnSession`).

Before calling `dispatchAdaptivePipeline`, write a sidecar file to `~/.workrail/daemon-sessions/<issueNumber>.json` with content `{ "context": { "taskCandidate": { "issueNumber": N } } }`. Remove this file in the `.then`/`.catch` completion handler.

This makes `checkIdempotency()` effective across daemon restarts. The existing logic in `github-queue-poller.ts:305-356` already handles this correctly - it just needs a file to read.

### Fix 4 (Secondary): Add a 30-second dedup TTL extension when the daemon restarts

**File:** `src/trigger/polling-scheduler.ts` (start of `doPollGitHubQueue`)

The 30-second dedup window in `TriggerRouter._recentAdaptiveDispatches` is lost on restart. A short startup delay (e.g., wait 60 seconds before the first post-restart poll cycle) would reduce the burst of duplicate dispatches during rapid restart sequences. This is a band-aid; Fix 3 is the correct structural solution.

---

## Non-Causes (Ruled Out)

- **Queue filter not working:** The queue correctly filters to only open issues assigned to `worktrain-etienneb`. Issue #393 legitimately matches because it is open and assigned.
- **`inferMaturity()` incorrect:** #393 has `## Acceptance Criteria` with `- [ ]` checklist items. `specced` is the correct maturity.
- **`routeTask()` routing to wrong mode:** The goal "test(daemon): add coverage..." correctly routes to FULL (no PR reference, no dep-bump keywords, no pitch file).
- **`wr.discovery` workflow definition incorrect:** The workflow has 22 steps and is substantive. The issue is runtime timeout, not workflow structure.
- **Coordinator logic incorrect:** The FULL pipeline's escalation on discovery timeout is correct behavior. The bug is that escalation has no consequence on the queue side.
