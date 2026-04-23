# Discovery Loop Investigation A

**Date:** 2026-04-21
**Bug:** WorkTrain autonomous pipeline repeatedly runs `wr.discovery` sessions on GitHub issue #393 without progressing past discovery.

---

## 1. What the Logs Actually Show

### 1.1 Timeline

| Time (approx) | Event |
|---|---|
| 18:16 | `trigger_fired` + `session_started` for `wr.coding-task` (issue #393) |
| 18:19 | Session completes `outcome=success`. Discovery step done, but issue still open. |
| 19:53 | First `session_started` for `wr.discovery` (no trigger_fired -- in-process dispatch) |
| 19:53 - 23:54 | Six `wr.discovery` sessions start in rapid succession without any `session_completed` events between them (concurrent spawning race) |
| 23:24 - 07:24 | Hourly `wr.discovery` cycle: `session_started` at :24, `session_completed outcome=timeout detail=wall_clock` 30 min later at :54, followed immediately by next start |

### 1.2 Evidence from `queue-poll.jsonl`

- Issue #393 is selected on **every single poll cycle** (every 5 minutes) starting at 19:10 on Apr 20.
- The selection reason never changes: `maturity=specced, reason="has acceptance criteria or checklist"`.
- The `task_skipped` entries with `reason=active_session_in_process` appear only briefly (during the few minutes the `dispatchingIssues` in-memory Set holds the issue number). They disappear as soon as the pipeline Promise settles.
- No `task_skipped` with `reason=active_session` (idempotency file scan) ever appears for issue #393.

### 1.3 Evidence from `daemon/2026-04-21.jsonl`

All 14 `wr.discovery` `session_completed` events have `outcome=timeout, detail=wall_clock`. None have `outcome=success`. The pipeline never logs escalation to an outbox nor advances to shaping. No `session_started` event ever appears for `wr.shaping` or the coding workflow for this issue.

### 1.4 Evidence from `daemon.stdout.log`

The repeating pattern (confirmed at every cycle):

```
[QueuePoll] in-flight-clear #393 reason=completed
[QueuePoll] cycle start repo=EtienneBBeaulac/workrail issues_fetched=1
[QueuePoll] selected #393 ... maturity=specced
[QueuePoll] in-flight-add #393
[QueuePoll] dispatched via adaptivePipeline
[TriggerRouter] Pre-allocated session dispatched: workflowId=wr.discovery
[WorkflowRunner] Session started: workflowId=wr.discovery
... (30 min elapses) ...
[TriggerRouter] Dispatch timed out: workflowId=wr.discovery reason=wall_clock message=Workflow timed out after 30 minutes
[QueuePoll] in-flight-clear #393 reason=completed
(next cycle repeats)
```

Crucially: `[full-pipeline]` log lines never appear. The coordinator's inner log output is absent because `runAdaptivePipeline` is running inside `dispatchAdaptivePipeline`, which runs on the async queue, but no `stderr` bridge surfaces those logs in `daemon.stdout.log`. The FULL pipeline IS running, but it is invisible except for the child `wr.discovery` session dispatches it produces.

---

## 2. Exact Code Path

The loop follows this execution path on every cycle:

```
PollingScheduler.doPollGitHubQueue()
  -> issue #393 not in dispatchingIssues (cleared from previous cycle)
  -> checkIdempotency(393, sessionsDir) -> 'clear'   [** root cause #1 **]
  -> no 'worktrain:in-progress' label                [** root cause #2 **]
  -> dispatchingIssues.add(393)
  -> router.dispatchAdaptivePipeline(goal, workspace) [fire-and-forget Promise]
      -> runAdaptivePipeline(deps, opts) -> FULL mode
          -> runFullPipelineCore()
              -> spawnSession('wr.discovery', goal, workspace)  [no context passed]
                  -> router.dispatch({ workflowId: 'wr.discovery', goal, ... })
                      -> runWorkflow() -> wall_clock timer = 30 min (DEFAULT_SESSION_TIMEOUT_MINUTES)
                      -> After 30 min: daemonRegistry.unregister(id, 'failed')
                      -> session .json file DELETED (line 3867 of workflow-runner.ts)
                      -> returns _tag:'timeout'
              -> awaitSessions([discoveryHandle], 55_min)
                  -> polls ConsoleService.getSessionDetail(discoveryHandle)
                  -> engineState.kind !== 'complete' (agent was aborted mid-run)
                  -> status = 'dormant' (no new events, no completion)
                  -> does NOT match 'complete' | 'complete_with_gaps' | 'blocked'
                  -> keeps polling for 55 minutes
                  -> after 55 min: returns outcome='timeout' for discoveryHandle
              -> discoveryResult.outcome === 'timeout' != 'success'
              -> returns { kind: 'escalated', escalationReason: { phase: 'discovery' } }
      -> dispatchAdaptivePipeline Promise resolves
  -> dispatchP.then(): dispatchingIssues.delete(393)

(55-60 min later, next QueuePoll cycle)
  -> issue #393 not in dispatchingIssues (cleared)
  -> checkIdempotency(393) -> 'clear' again
  -> LOOP REPEATS
```

**Total cycle duration:** ~55 minutes (dominated by awaitSessions timeout). This matches the ~1-hour spacing between `session_started` events in the logs (e.g. 23:24, 00:24, 01:24, 02:24, 03:24, 04:24, 05:24, 06:24).

---

## 3. Root Causes

### Root Cause #1 (Primary): `checkIdempotency` never fires for queue-originated sessions

`checkIdempotency` in `src/trigger/adapters/github-queue-poller.ts` scans `~/.workrail/daemon-sessions/*.json` for files where `context.taskCandidate.issueNumber === issueNumber`.

`persistTokens` in `src/daemon/workflow-runner.ts` (line 714) writes:
```json
{ "continueToken": "...", "checkpointToken": "...", "ts": 1234567890 }
```

There is **no `context` field** in this file. The `taskCandidate` context is passed to `dispatchAdaptivePipeline` but is never threaded into the `spawnSession` call for `wr.discovery` (see `full-pipeline.ts` line 206-210 -- `spawnSession('wr.discovery', opts.goal, opts.workspace)` with no 4th `context` argument).

Because `persistTokens` never writes `context`, `checkIdempotency` hits the `continue` branch for every session file and returns `'clear'`. The idempotency guard designed to prevent re-dispatch is permanently bypassed.

Additionally, on wall_clock timeout, the `.json` file is **explicitly deleted** (workflow-runner.ts line 3867):
```typescript
await fs.unlink(path.join(DAEMON_SESSIONS_DIR, `${sessionId}.json`)).catch(() => {});
```
Even if the context were present, the file is gone before the next poll cycle.

### Root Cause #2 (Secondary): No `worktrain:in-progress` label is ever applied to the issue

The H3 guard in `polling-scheduler.ts` (line 505) checks for the `worktrain:in-progress` label. This label is never added to issue #393 -- not by the queue poller at dispatch time, and not by the `wr.discovery` agent during its run. Without this label, the H3 guard provides no protection.

### Root Cause #3 (Contributing): `wr.discovery` session timeout mismatch

`DEFAULT_SESSION_TIMEOUT_MINUTES = 30` (workflow-runner.ts line 83) applies to `wr.discovery` sessions dispatched via `router.dispatch()`. `DISCOVERY_TIMEOUT_MS = 55 minutes` (adaptive-pipeline.ts line 39) is how long `awaitSessions` waits for the session to complete. The session always dies at 30 minutes, but `awaitSessions` wastes the remaining 25 minutes polling a `dormant` session before timing out itself. This 55-minute wasted wait is why the loop period is ~1 hour rather than ~30 minutes.

The mismatch happens because `spawnSession` calls `router.dispatch()` without passing `agentConfig.maxSessionMinutes`, so the inner `wr.discovery` session inherits the global default (30 min) rather than the coordinator's expected 55-minute budget.

### Root Cause #4 (Contributing): Escalation is silent

When the FULL pipeline escalates at the discovery phase, no signal is sent to the human outbox and the GitHub issue remains open and assigned. The queue poller has no way to distinguish "this issue has been attempted and failed" from "this issue has never been attempted." The same issue is therefore eligible for re-selection on every cycle.

---

## 4. Recommended Fixes

### Fix 1 (Required): Thread `issueNumber` into `spawnSession` context for the outer session

In `trigger-listener.ts`, the `spawnSession` implementation should accept and write `context` into the `persistTokens` payload. Specifically: when `dispatchAdaptivePipeline` is called with a `context` containing `taskCandidate.issueNumber`, that context should be stored in the session sidecar so `checkIdempotency` can find it.

One clean approach: pass `taskCandidate` as a context field in `spawnSession`, and extend `persistTokens` to write `context` alongside the tokens:

```typescript
// In persistTokens (workflow-runner.ts):
const state = JSON.stringify({
  continueToken,
  checkpointToken,
  ts: Date.now(),
  ...(worktreePath !== undefined ? { worktreePath } : {}),
  ...(context !== undefined ? { context } : {}),  // ADD THIS
}, null, 2);
```

And in `trigger-listener.ts`, thread `opts.taskCandidate` into the `spawnSession` → `dispatch` call for the top-level pipeline session.

### Fix 2 (Required): Apply `worktrain:in-progress` label at dispatch time

When `doPollGitHubQueue` selects an issue and calls `dispatchAdaptivePipeline`, it should immediately apply a `worktrain:in-progress` label to the GitHub issue via the API. This provides a cross-restart, cross-process guard that survives daemon restarts and does not depend on in-memory state or sidecar file scanning.

Remove the label when the pipeline completes (success or escalation). This is the most robust idempotency mechanism for a persistent external queue.

### Fix 3 (Required): Pass `maxSessionMinutes` to inner `wr.discovery` spawn

In `full-pipeline.ts`, pass `agentConfig.maxSessionMinutes` when calling `spawnSession` for `wr.discovery`:

```typescript
const discoverySpawnResult = await deps.spawnSession(
  'wr.discovery',
  opts.goal,
  opts.workspace,
  undefined,  // no taskCandidate context for the child session
  { maxSessionMinutes: Math.floor(DISCOVERY_TIMEOUT_MS / 60_000) },  // 55 min
);
```

This aligns the child session's wall_clock timeout with the coordinator's `awaitSessions` timeout and eliminates the 25-minute polling waste.

### Fix 4 (Required): Write to outbox on discovery escalation

In `full-pipeline.ts` (and the overall FULL pipeline escalation path), call `deps.postToOutbox` when discovery times out, so the operator knows the pipeline failed and can intervene. The current silence means the issue stays open and the loop continues indefinitely.

### Fix 5 (Optional but recommended): Add `in_progress` → escalation-marker to session status mapping

In `awaitSessions`, treat a session whose `daemonRegistry` status is `'failed'` as outcome `'timeout'` immediately rather than polling until `awaitSessions` itself times out. This requires surfacing the registry status through `ConsoleService.getSessionDetail`, which is a more invasive change -- implement after Fixes 1-4.

---

## 5. Issue Triage

The correct fix ordering is: **Fix 2 (label) first** for immediate protection, then **Fix 1 (context threading)** to make the sidecar guard work properly, then **Fix 3 (timeout alignment)** to eliminate wasted polling, then **Fix 4 (escalation notice)** for operator visibility.

Fix 2 alone would stop the loop immediately because the `worktrain:in-progress` label check runs before `checkIdempotency` in `polling-scheduler.ts` line 505, and does not depend on any file state or memory state.
