# WorkTrain Daemon Invariants

Invariants that must hold across any refactor of the WorkTrain daemon. These complement the design locks in `docs/design/v2-core-design-locks.md` (which covers the WorkRail engine) with daemon-specific contracts.

See also: `tests/unit/workflow-runner-outcome-invariants.test.ts` -- the test file that enforces a subset of these invariants.

---

## 1. Outcome invariants

### 1.1 Every `runWorkflow()` exit path produces a defined outcome

`runWorkflow()` returns a `WorkflowRunResult` discriminated union. The `_tag` field must always be one of: `'success'`, `'error'`, `'timeout'`, `'stuck'`. `'unknown'` is not a valid outcome for any defined exit path.

**Why:** `'unknown'` in `execution-stats.jsonl` is silent data loss. Operators calibrate session timeouts and monitor health from this data.

**How it breaks:** The `writeExecutionStats()` helper takes `outcome` by value. If called with a variable that hasn't been assigned yet, it silently records `'unknown'`. Every result path must call `writeExecutionStats()` with the correct outcome at the call site, not via a shared variable captured in a closure.

### 1.2 `delivery_failed` is never returned by `runWorkflow()` directly

`WorkflowRunResult` includes `_tag: 'delivery_failed'`, but `runWorkflow()` never produces it. `delivery_failed` is produced only by `TriggerRouter` after a failed `callbackUrl` HTTP POST. The `ChildWorkflowRunResult` alias makes this explicit at the `spawn_agent` call site.

**Why:** Child sessions spawned by `spawn_agent` bypass `TriggerRouter` entirely. If `delivery_failed` could appear from `runWorkflow()`, the parent session's outcome handling would silently corrupt.

### 1.3 `_tag` to stats outcome mapping

| `_tag` | `statsOutcome` |
|---|---|
| `'success'` | `'success'` |
| `'error'` | `'error'` |
| `'timeout'` | `'timeout'` |
| `'stuck'` | `'stuck'` |
| `'delivery_failed'` | `'success'` (workflow succeeded; only the POST failed) |

This mapping must be exhaustive. When `tagToStatsOutcome()` is extracted as a pure function (planned in the functional-core/imperative-shell refactor), it must use `assertNever` on the default case so the compiler enforces exhaustiveness.

### 1.4 Outcome priority when multiple signals fire

If both `stuckReason` and `timeoutReason` are non-null at the same time (same turn), `stuck` takes priority over `timeout`. This is intentional: stuck is the more specific signal (the agent is looping, not just slow), and fires before the wall-clock limit.

**Code location:** The `if (stuckReason !== null)` check precedes `if (timeoutReason !== null)` in `runWorkflow()`.

### 1.5 stepCount reflects agent-loop advances only

`stepCount` in `execution-stats.jsonl` is the value of `stepAdvanceCount` -- the number of times `onAdvance()` was called during the agent loop. For sessions that exit before the agent loop starts (model validation failure, `start_workflow` failure, instant single-step completion), `stepCount` is `0`. This is correct and intentional -- `stepAdvanceCount` tracks agent loop step advances, not workflow steps completed.

---

## 2. Sidecar (crash-recovery) invariants

Each `runWorkflow()` call writes a per-session sidecar file at `~/.workrail/daemon-sessions/<sessionId>.json` via `persistTokens()`. This file is the crash-recovery anchor.

### 2.1 Sidecar is written before the agent loop starts

`persistTokens()` is called immediately after `executeStartWorkflow()` succeeds and the `continueToken` is available. A crash between `executeStartWorkflow()` returning and the first LLM call is recoverable.

**Exception:** If `continueToken` is undefined (instant single-step completion, or `_preAllocatedStartResponse` with no token), `persistTokens()` is skipped. There is nothing to recover.

### 2.2 Sidecar is deleted on every non-worktree terminal path

The sidecar lifecycle decision is delegated to `sidecardLifecycleFor(tag, branchStrategy)` in `workflow-runner.ts`. That function is the authoritative source for this table; its `assertNever` default case ensures a compile error when `WorkflowRunResult` gains new variants without updating the rules.

| Outcome | Sidecar deleted? |
|---|---|
| `success` (non-worktree) | Yes -- `finalizeSession()` deletes via `sidecardLifecycleFor` |
| `success` (worktree) | No -- `TriggerRouter.maybeRunDelivery()` deletes it after delivery |
| `error` | Yes -- `finalizeSession()` deletes via `sidecardLifecycleFor` |
| `timeout` | Yes -- `finalizeSession()` deletes via `sidecardLifecycleFor` |
| `stuck` | Yes -- `finalizeSession()` deletes via `sidecardLifecycleFor` |

**Why worktree sessions differ:** Delivery (git commit, git push, gh pr create) runs inside the worktree after `runWorkflow()` returns. The sidecar must exist until delivery completes so `runStartupRecovery()` can find the worktree path if the daemon crashes during delivery.

### 2.3 Sidecar is never left behind after a clean terminal path

A sidecar that outlives the session inflates `countActiveSessions()` permanently until the next daemon restart. The only acceptable cases where a sidecar persists after `runWorkflow()` returns:
- Worktree sessions awaiting delivery (see 2.2)
- Crashed sessions (handled by `runStartupRecovery()` at next startup)

### 2.4 Sidecar contains trigger context for crash recovery

Since Phase B crash recovery (PR #811), `persistTokens()` also writes `workflowId`, `goal`, and `workspacePath` to the sidecar. This allows `runStartupRecovery()` to reconstruct a minimal `WorkflowTrigger` for resumption without scanning the session event log.

**Backward compatibility:** Old sidecars without these fields are discarded (not resumed) at startup. This is acceptable -- the information needed to reconstruct the trigger doesn't exist in the old format.

---

## 3. Registry invariants

Three registries track in-flight daemon sessions:

| Registry | Key | Value | Purpose |
|---|---|---|---|
| `DaemonRegistry` | `workrailSessionId` | `{ workflowId, lastHeartbeatMs }` | Console `isLive` display |
| `SteerRegistry` | `workrailSessionId` | `(text: string) => void` | Mid-session coordinator injection |
| `AbortRegistry` | `workrailSessionId` | `() => void` | SIGTERM graceful shutdown |

### 3.1 All registries are deregistered in the `finally` block

`steerRegistry.delete()` and `abortRegistry.delete()` are called in the `finally` block of `runWorkflow()`. This ensures cleanup happens even if an exception is thrown in the agent loop or in the post-finally result handling.

**Why `finally` and not per-result-path:** A stale steer or abort callback on a dead session would cause `POST /sessions/:id/steer` to return 200 (calling the closed-over callback) or the shutdown handler to call `abort()` on an already-exited session. Both are silent correctness bugs.

### 3.2 `DaemonRegistry` is unregistered at every result path

`daemonRegistry.unregister(workrailSessionId, 'completed' | 'failed')` is called at each of the four result paths (success, error, timeout, stuck). It is NOT in the `finally` block because the completion status ('completed' vs 'failed') differs by path.

### 3.3 `workrailSessionId` is available before registry operations

All registry operations use `workrailSessionId` (the WorkRail `sess_*` ID decoded from the `continueToken`), not the process-local UUID. This is because `DaemonRegistry` is keyed by WorkRail session ID, which is what the console and coordinator scripts use for correlation.

If `parseContinueTokenOrFail()` fails (unusual -- the token just came from `executeStartWorkflow()`), `workrailSessionId` remains `null` and all registry operations are skipped. The session still runs; only console liveness and mid-session injection won't work.

### 3.4 Registration gap is documented

**SteerRegistry gap (~50ms):** There is a ~50ms window between `executeStartWorkflow()` returning and `steerRegistry.set()` being called (after `parseContinueTokenOrFail()` completes). A `POST /sessions/:id/steer` call in this window receives 404. Coordinators should retry once on 404 during session startup.

**AbortRegistry gap (~200-500ms):** `abortRegistry.set()` is registered _after_ `const agent = new AgentLoop(...)` is constructed, which happens after the context-loading phase (`loadDaemonSoul`, `loadWorkspaceContext`, `loadSessionNotes` in parallel). This means there is a ~200-500ms window where SIGTERM will not abort an in-flight session. Sessions in this window run to completion or hit the wall-clock timeout.

**Why the abort gap is wider than the steer gap:** `abortRegistry.set` registers `() => agent.abort()` which closes over `agent`. Registering this callback before `agent` is constructed would be a TDZ (Temporal Dead Zone) hazard -- `agent` is declared with `const` and would not yet be initialized if the shutdown handler fired on an early-exit path. Registering after `agent` construction eliminates the hazard at the cost of a wider registration window. The accepted tradeoff is the same as for the steer gap.

---

## 4. Agent loop invariants

### 4.1 Tools execute sequentially

`AgentLoop` is constructed with `toolExecution: 'sequential'`. `continue_workflow` / `complete_step` must complete before the next tool (e.g. Bash) begins. Workflow tools have ordering requirements -- the next step's prompt must be received before the agent starts work on it.

### 4.2 `complete_step` injects the token; the LLM never sees it

`makeCompleteStepTool()` calls `getCurrentToken()` at execution time to inject the current `continueToken`. The token is never included in the tool's response text. This eliminates `TOKEN_BAD_SIGNATURE` errors from token mangling.

**Invariant:** `currentContinueToken` is updated in two places only:
1. `onAdvance()` -- after a successful step advance (new token for next step)
2. `onTokenUpdate()` -- after a blocked retry (retry token replaces the consumed token)

Both are guarded by the sequential tool execution invariant (no concurrent token updates).

### 4.3 Token is persisted before returning from tool execute

`persistTokens()` is called inside `makeCompleteStepTool.execute()` and `makeContinueWorkflowTool.execute()` before `onAdvance()` or `onTokenUpdate()` are called. A crash between the engine returning a new token and `persistTokens()` completing would leave an unrecoverable state.

**Note:** The sidecar write uses the atomic temp-rename pattern (`writeFile(tmp) → rename(tmp, final)`) to prevent corrupt partial writes.

### 4.4 Stuck detection is non-blocking for the session result

All three stuck detection signals (`repeated_tool_call`, `no_progress`, `timeout_imminent`) emit `agent_stuck` events via `emitter?.emit()`, which is fire-and-forget. An event write failure never affects the session.

Signals 1 and 2 abort the session (set `stuckReason`) subject to `stuckAbortPolicy`. Signal 3 (`timeout_imminent`) is purely observational -- the abort has already been triggered by the timeout handler.

### 4.5 `spawn_agent` depth is enforced at the call site

`makeSpawnAgentTool()` receives `spawnCurrentDepth` and `spawnMaxDepth` as constructor parameters. If `spawnCurrentDepth >= spawnMaxDepth`, `spawn_agent` returns a typed error without calling `runWorkflow()`. The depth check is not delegated to the inner `runWorkflow()` call.

---

## 5. Worktree isolation invariants

### 5.1 Agent file operations target `sessionWorkspacePath`, not `trigger.workspacePath`

For `branchStrategy: 'worktree'` sessions, all tool factories (`makeBashTool`, `makeGlobTool`, `makeGrepTool`, `makeEditTool`) receive `sessionWorkspacePath` (the isolated worktree path), not `trigger.workspacePath` (the main checkout). This prevents the agent from modifying the main checkout.

**Exception:** `git -C` operations that target the repo itself (fetch, worktree add, worktree remove) use `trigger.workspacePath`.

### 5.2 Worktree creation is atomic from git's perspective

`git worktree add` is atomic -- if it fails, no worktree is registered with git. The worktree creation failure path returns `_tag: 'error'` without any worktree cleanup step (there is nothing to clean up).

### 5.3 Worktree path is persisted to sidecar immediately after creation

After `git worktree add` succeeds, `persistTokens()` is called again with `worktreePath` included. This ensures `runStartupRecovery()` can find and remove the worktree if the daemon crashes before the session completes.

### 5.4 Worktree is removed by `TriggerRouter`, not by `runWorkflow()`

`git worktree remove --force` is run in `TriggerRouter.maybeRunDelivery()` after delivery (git push, gh pr create) completes. `runWorkflow()` intentionally does not remove the worktree on success -- delivery must run inside the worktree after `runWorkflow()` returns.

On failure/timeout/stuck paths, the worktree is left in place for debugging. `runStartupRecovery()` reaps orphan worktrees older than 24 hours.

---

## 6. Crash recovery invariants

### 6.1 Phase A runs unconditionally at startup

`clearQueueIssueSidecars()` deletes all `queue-issue-*.json` files at daemon startup. This unblocks GitHub issues for re-dispatch within one poll cycle (~5 minutes), regardless of whether session recovery succeeds.

### 6.2 Sessions with zero step advances are discarded

`evaluateRecovery({ stepAdvances: 0 })` always returns `'discard'`. A session that never advanced a step has no durable progress to recover -- re-dispatch is cheaper and cleaner than resuming from step 0 with a stale agent.

### 6.3 Sessions with >= 1 step advance are resumed if sidecar has trigger context

`evaluateRecovery({ stepAdvances: >= 1 })` returns `'resume'`. If the sidecar contains `workflowId` and `workspacePath`, `runStartupRecovery()` calls `executeContinueWorkflow({ intent: 'rehydrate' })` to get the current step prompt, builds a minimal `WorkflowTrigger` with `_preAllocatedStartResponse`, and calls `runWorkflow()` fire-and-forget.

**Old-format sidecars** (missing `workflowId`/`workspacePath`) fall through to discard regardless of step count.

### 6.4 Resumed sessions use `branchStrategy: 'none'`

Worktree sessions that are resumed set `branchStrategy: 'none'` and use the persisted `worktreePath` as `workspacePath`. This prevents the resumed session from creating a second worktree on top of the existing one.

---

## 7. Planned refactor: functional core / imperative shell

The invariants above are currently enforced by convention (comments, code structure) rather than by the type system. The planned refactor will make them structurally enforced:

**Core (pure functions, no I/O):**
- `buildSessionConfig(trigger) → SessionConfig` -- model, tools, limits, prompts
- `evaluateAgentExitState(exitState) → WorkflowRunResult` -- replaces 4 scattered return sites
- `tagToStatsOutcome(tag) → StatsOutcome` -- exhaustive via `assertNever`
- `evaluateStuck(signals) → StuckSignal | null` -- already nearly pure

**Shell (one cleanup site for all I/O):**
```typescript
async function runWorkflow(trigger, ctx, apiKey, ...): Promise<WorkflowRunResult> {
  const startMs = Date.now();
  const result = await _runWorkflowCore(trigger, ctx, apiKey, ...);
  // All I/O in one place:
  writeExecutionStats(statsDir, ..., tagToStatsOutcome(result._tag), result.stepCount);
  await cleanupSidecar(sessionId, result._tag, trigger.branchStrategy);
  emitSessionCompleted(emitter, sessionId, result._tag);
  daemonRegistry?.unregister(workrailSessionId, result._tag === 'success' ? 'completed' : 'failed');
  return result.workflowRunResult;
}
```

After the refactor, adding a new result path requires:
1. Adding it to the `WorkflowRunResult` union (compiler enforces exhaustiveness in `tagToStatsOutcome` via `assertNever`)
2. Returning the new variant from `_runWorkflowCore` (no I/O to add at the return site)

The current pattern requires manually adding `writeExecutionStats()`, sidecar deletion, event emission, and registry deregistration at each new return site -- easily forgotten.
