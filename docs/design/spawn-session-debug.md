# spawn-session-debug: Why dispatch() Never Starts Sessions

**Diagnosis type:** single_cause  
**Confidence:** HIGH  
**Date:** 2026-04-19

---

## Executive Summary

`routerRef.dispatch()` in `spawnSession` is silently killed by the 30-second deduplication
guard inside `TriggerRouter.dispatch()`. The session is pre-created by `executeStartWorkflow`
but the agent loop (`runWorkflowFn`) is never started. The session exists in the store as a
zombie: it has a `run_started` event but the `session_started` event and all subsequent
agent-loop events never appear.

---

## Exact Failure Point

**File:** `src/trigger/trigger-router.ts`, lines 847-866 (`dispatch()` method)

```
dispatch(workflowTrigger: WorkflowTrigger): string {
  {
    const dedupeKey = `${workflowTrigger.goal}::${workflowTrigger.workspacePath}`;
    ...
    const lastDispatch = this._recentAdaptiveDispatches.get(dedupeKey);
    if (lastDispatch !== undefined && now - lastDispatch < TriggerRouter.ADAPTIVE_DEDUPE_TTL_MS) {
      console.log(`[TriggerRouter] Skipping duplicate dispatch: ...`);
      return workflowTrigger.workflowId;  // <-- EARLY RETURN, queue.enqueue() never called
    }
    this._recentAdaptiveDispatches.set(dedupeKey, now);
  }

  void this.queue.enqueue(workflowTrigger.workflowId, async () => { // never reached
    ...
    result = await this.runWorkflowFn(...);                         // never called
  });
}
```

The guard fires because `_recentAdaptiveDispatches` is a **shared map** on the `TriggerRouter`
instance, and `dispatchAdaptivePipeline()` writes to that same map with the same key format
(`goal::workspacePath`) moments before the child `dispatch()` call.

---

## Full Call Chain

```
dispatchAdaptivePipeline(goal, workspace)           [trigger-router.ts:1035]
  --> _recentAdaptiveDispatches['goal::workspace'] = now  <-- KEY SET HERE
  --> runAdaptivePipeline(...)
        --> runFullPipeline(...)
              --> deps.stderr('[full-pipeline] Spawning wr.discovery session')
              --> await deps.spawnSession('wr.discovery', goal, workspace)
                    --> executeStartWorkflow(...)        SUCCESS: session + run written to store
                    --> parseContinueTokenOrFail(...)    SUCCESS: sessionHandle decoded
                    --> routerRef.dispatch({
                          workflowId: 'wr.discovery',
                          goal,           // <-- same string
                          workspacePath: workspace,  // <-- same string
                          _preAllocatedStartResponse: ...
                        })
                          dedupeKey = 'goal::workspace'  <-- SAME KEY
                          now - lastDispatch = ~0ms < 30000ms  <-- DEDUP FIRES
                          return 'wr.discovery'          <-- queue.enqueue() NEVER CALLED
                    --> return { kind: 'ok', value: sessionHandle }
              --> awaitSessions([sessionHandle], 35 * 60 * 1000)
                    --> polls every 3s
                    --> session exists, run exists, status = in_progress (forever)
                    --> 35 minutes later: { outcome: 'timeout' }
```

The `session_started` event (emitted by `workflow-runner.ts:3050`) only fires inside
`runWorkflow()`. Since `runWorkflowFn` is never called, `session_started` never appears.

---

## Why route() Works

`route()` constructs `workflowTrigger.goal` from `trigger.goal` in triggers.yml (or from
goalTemplate interpolation). That goal is a **different string** from the coordinator's
`opts.goal`. Different dedupeKey -> no collision -> `queue.enqueue()` is reached ->
`runWorkflowFn` runs.

Example:
- Coordinator's `opts.goal`: `"Implement feature X for workspace /Users/etienneb/git/personal/workrail"`
- Trigger's `trigger.goal` in triggers.yml: `"Review incoming PR"`
- Dedup keys: different -> no collision

---

## Why the Failure Is Silent

`dispatch()` returns `workflowTrigger.workflowId` (not an error) on the early-return path.
`spawnSession` only errors on explicit `{kind:'err'}` returns from `dispatch()` -- but it calls
`executeStartWorkflow` and `parseContinueTokenOrFail` BEFORE calling `dispatch()`, so by the
time `dispatch()` silently skips, `spawnSession` already has a valid `sessionHandle` and
returns `{kind:'ok', value:sessionHandle}`.

The coordinator receives a valid-looking handle, logs nothing unusual, and starts polling.

---

## Why Worktrees Are Never Created

Worktree creation happens inside `runWorkflow()` (the same function that never runs). This is a
downstream symptom of the same root cause, not a separate bug.

---

## Alternatives Ruled Out

| Hypothesis | Verdict | Reason |
|---|---|---|
| `executeStartWorkflow` fails silently | Eliminated | Session IS in the store; awaitSessions polls it but status never completes |
| `routerRef` undefined at call time | Eliminated | '[full-pipeline] Spawning...' log confirms full-pipeline ran past the routerRef guard |
| Queue serialization behind a stalled prior run | Not primary cause | Dedup fires before `queue.enqueue()` is ever reached |
| Workflow loader can't find `wr.discovery` | Eliminated | `executeStartWorkflow` succeeds (session created); failure here would cause spawnSession to return `{kind:'err'}`, not a hanging awaitSessions |

---

## Minimal Fix

The deduplication in `dispatch()` was designed to prevent the same top-level pipeline from
being dispatched twice in rapid succession (e.g. from webhook retries). It must not apply
to child sessions spawned by an already-running pipeline.

The `dispatch()` early return at lines 861-863 of `trigger-router.ts` should not fire when
the call comes from `spawnSession` (i.e. when `_preAllocatedStartResponse` is set). Three
approaches -- listed from lowest-blast-radius to highest:

### Option A: Skip dedup when `_preAllocatedStartResponse` is present (targeted)

In `dispatch()`, bypass the dedup check when `_preAllocatedStartResponse` is set. This field
is only set by `spawnSession` (which already allocated the session -- dropping it would be
catastrophic). The presence of a pre-allocated response is authoritative evidence that the
caller explicitly intends to start this session.

```typescript
// In dispatch(), before the dedup block:
if (workflowTrigger._preAllocatedStartResponse !== undefined) {
  // Pre-allocated session: the caller already created the session in the store.
  // Deduplication must not apply here -- dropping this dispatch would zombie the session.
  void this.queue.enqueue(workflowTrigger.workflowId, async () => { ... });
  return workflowTrigger.workflowId;
}
// ... existing dedup block follows
```

### Option B: Remove dedup from `dispatch()` entirely (simpler)

The dedup in `dispatch()` was never well-justified for child sessions. The HTTP console route
that calls `dispatch()` (console-routes.ts:868) is already protected by HTTP request
deduplication at a higher layer. Removing the dedup from `dispatch()` leaves only
`dispatchAdaptivePipeline()`'s own dedup (which is the correct protection point for
top-level pipeline dedup).

### Option C: Separate dedup maps (cleanest isolation)

Give `dispatchAdaptivePipeline` its own dedup map instead of sharing
`_recentAdaptiveDispatches` with `dispatch()` and `route()`. This removes the cross-path
coupling entirely.

**Recommended: Option A.** It is the smallest possible change, is self-documenting, and
directly models the invariant: a pre-allocated session must always be started.

---

## Files Involved

- `src/trigger/trigger-router.ts`
  - Lines 847-866: `dispatch()` dedup block (the exact failure point)
  - Lines 996-1035: `dispatchAdaptivePipeline()` dedup block (the writer that poisons the key)
  - Line 500: `_recentAdaptiveDispatches` declaration (shared map)
- `src/trigger/trigger-listener.ts`
  - Lines 492-498: `spawnSession` calls `routerRef.dispatch()`

---

## Verification Recommendations

After applying a fix:

1. **Unit test (regression):** Call `dispatchAdaptivePipeline(goal, workspace)`, then
   immediately call `dispatch({workflowId:'wr.discovery', goal, workspacePath:workspace, _preAllocatedStartResponse:...})`.
   Assert that `runWorkflowFn` is called exactly once (currently fails: `runWorkflowFn` is
   never called due to dedup).

2. **Integration smoke test:** Run the full-pipeline coordinator against a test workspace.
   Verify `session_started` appears in the daemon event log for the spawned `wr.discovery`
   session within 5 seconds.

3. **Dedup regression:** Verify that calling `dispatchAdaptivePipeline` twice with the same
   goal+workspace within 30 seconds still only starts one pipeline (the dedup guard in
   `dispatchAdaptivePipeline` must still fire correctly).

4. **Direct dispatch regression:** Verify that calling `dispatch()` (without
   `_preAllocatedStartResponse`) twice with the same goal+workspace within 30 seconds still
   deduplicates (if that behavior is intentional for the HTTP console route path).
