# WorkTrain Daemon Invariants

Invariants that must hold across any refactor of the WorkTrain daemon. These complement the design locks in `docs/design/v2-core-design-locks.md` (which covers the WorkRail engine) with daemon-specific contracts.

See also: `tests/unit/workflow-runner-outcome-invariants.test.ts` -- the test file that enforces a subset of these invariants.

---

## 1. Outcome invariants

### 1.1 Every `runWorkflow()` exit path produces a defined outcome

`runWorkflow()` returns a `WorkflowRunResult` discriminated union. The `_tag` field must always be one of: `'success'`, `'error'`, `'timeout'`, `'stuck'`. `'unknown'` is not a valid outcome for any defined exit path.

**Why:** `'unknown'` in `execution-stats.jsonl` is silent data loss. Operators calibrate session timeouts and monitor health from this data.

**How it breaks:** `writeExecutionStats()` takes `outcome` by value. If called with an unassigned variable, it silently records `'unknown'`. All result paths go through `finalizeSession()`, which calls `tagToStatsOutcome()` to derive the outcome -- there are no direct `writeExecutionStats()` calls outside `finalizeSession()`.

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

This mapping is exhaustive. `tagToStatsOutcome()` is a pure function in `workflow-runner.ts` that uses `assertNever` on the default case -- the compiler enforces exhaustiveness when new `_tag` variants are added.

### 1.4 Outcome priority when multiple signals fire

`stuck` takes priority over `timeout`. This is enforced structurally by `TerminalSignal` and `setTerminalSignal()`: `setTerminalSignal()` is first-writer-wins -- the first signal to set `state.terminalSignal` wins, and subsequent calls are silent no-ops. Because stuck detection fires inside the turn-end subscriber (which runs before the wall-clock timeout handler), stuck always sets `terminalSignal` first when both conditions are present in the same turn.

**Code location:** `setTerminalSignal()` in `workflow-runner.ts`. `buildSessionResult()` reads `state.terminalSignal` after the loop exits.

### 1.5 stepCount reflects agent-loop advances only

`stepCount` in `execution-stats.jsonl` is the value of `stepAdvanceCount` -- the number of times `onAdvance()` was called during the agent loop. For sessions that exit before the agent loop starts (model validation failure, `start_workflow` failure, instant single-step completion), `stepCount` is `0`. This is correct and intentional -- `stepAdvanceCount` tracks agent loop step advances, not workflow steps completed.

---

## 2. Sidecar (crash-recovery) invariants

Each `runWorkflow()` call writes a per-session sidecar file at `~/.workrail/daemon-sessions/<sessionId>.json` via `persistTokens()`. This file is the crash-recovery anchor.

### 2.1 Sidecar is written before the agent loop starts

`persistTokens()` is called inside `buildPreAgentSession()` immediately after `executeStartWorkflow()` succeeds and the `continueToken` is available. `buildPreAgentSession()` returns `{ kind: 'complete', result: { _tag: 'error' } }` if `persistTokens()` fails -- no agent loop starts without a valid sidecar.

`persistTokens()` returns `Promise<Result<void, PersistTokensError>>` (not throws). Callers in the setup phase treat `err` as fatal (abort); callers inside tool closures treat `err` as degraded-but-continue (log and still call `onAdvance`/`onTokenUpdate` -- see invariant 4.3).

**Exception:** If `continueToken` is undefined (instant single-step completion, or a `pre_allocated` `SessionSource` with no token), `persistTokens()` is skipped. There is nothing to recover.

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

Two registries track in-flight daemon sessions:

| Registry | Key | Value | Purpose |
|---|---|---|---|
| `DaemonRegistry` | `workrailSessionId` | `{ workflowId, lastHeartbeatMs }` | Console `isLive` display |
| `ActiveSessionSet` | `workrailSessionId` | `SessionHandle` | Steer injection + SIGTERM abort |

`ActiveSessionSet` + `SessionHandle` (in `src/daemon/active-sessions.ts`) replaced the former separate `SteerRegistry` and `AbortRegistry` maps. A `SessionHandle` exposes `steer()`, `setAgent()`, `abort()`, and `dispose()` -- all session lifecycle operations on a single object.

### 3.1 Registry registration and deregistration

**Registration** happens in two phases:

- `DaemonRegistry` and `ActiveSessionSet` are registered inside `buildPreAgentSession()` -- AFTER all potentially-failing I/O (executeStartWorkflow, persistTokens, worktree creation). Error paths that return before this point have nothing to clean up. The single-step completion path goes through `finalizeSession()` (which calls `daemonRegistry.unregister()`) and returns the handle via `PreAgentSessionResult` so the caller (`runWorkflow()`) can call `handle.dispose()`.

- `handle.setAgent(agent)` is called in `buildAgentReadySession()` immediately after `const agent = new AgentLoop(...)`. This wires in abort capability. `abort()` before `setAgent()` is a safe no-op -- the TDZ hazard is eliminated by the null check inside `SessionHandleImpl.abort()`.

**Deregistration**:

- `handle.dispose()` is called in the `finally` block of `runAgentLoop()`. This removes the handle from `ActiveSessionSet` so `size` decrements correctly and shutdown drain terminates.

- `daemonRegistry.unregister()` is called via `finalizeSession()` at both result paths (early-exit and post-agent-loop). It is NOT in `finally` because the completion status ('completed' vs 'failed') differs by result.

**Why stale entries are bugs:** A stale steer handle on a dead session makes `POST /sessions/:id/steer` return 200 instead of 404. A stale abort handle makes the shutdown handler call `abort()` on an already-exited session. Both are silent correctness bugs.

### 3.2 `DaemonRegistry` is unregistered at every result path

`daemonRegistry.unregister(workrailSessionId, 'completed' | 'failed')` is called via `finalizeSession()` at both the early-exit path and the post-agent-loop path. It is NOT in `finally` because the completion status differs by result.

### 3.3 `workrailSessionId` is available before registry operations

All registry operations use `workrailSessionId` (the WorkRail `sess_*` ID decoded from the `continueToken`), not the process-local UUID. This is because `DaemonRegistry` is keyed by WorkRail session ID, which is what the console and coordinator scripts use for correlation.

If `parseContinueTokenOrFail()` fails (unusual -- the token just came from `executeStartWorkflow()`), `workrailSessionId` remains `null` and all registry operations are skipped. The session still runs; only console liveness and mid-session injection won't work.

### 3.4 Registration gap is documented

**Steer gap (~50ms):** There is a ~50ms window between `executeStartWorkflow()` returning and `activeSessionSet.register()` being called (after `parseContinueTokenOrFail()` completes). A `POST /sessions/:id/steer` call in this window receives 404. Coordinators should retry once on 404 during session startup.

**Abort gap (~200-500ms):** `handle.setAgent(agent)` is called after `const agent = new AgentLoop(...)` is constructed, which happens after the context-loading phase (`loadDaemonSoul`, `loadWorkspaceContext`, `loadSessionNotes` in parallel). During this window, `handle.abort()` is a safe no-op -- SIGTERM will not abort the session. Sessions in this window run to completion or hit the wall-clock timeout.

**Why the abort gap is wider than the steer gap:** `setAgent()` must be called after `agent` construction. Calling it before would be a TDZ hazard. The `SessionHandleImpl.abort()` null-checks `_agent`, making pre-`setAgent()` abort a safe no-op rather than a crash.

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

`persistTokens()` returns `Promise<Result<void, PersistTokensError>>`. On `err` inside a tool closure, the policy is **log and continue** -- `onAdvance()` / `onTokenUpdate()` are still called even when persistence fails. Rationale: a persist failure degrades crash recovery but the session is still live. Killing the session on persist failure would lose in-progress work, which is strictly worse.

**Note:** The sidecar write uses the atomic temp-rename pattern (`writeFile(tmp) → rename(tmp, final)`) to prevent corrupt partial writes.

### 4.4 Stuck detection is non-blocking for the session result

All three stuck detection signals (`repeated_tool_call`, `no_progress`, `timeout_imminent`) emit `agent_stuck` events via `emitter?.emit()`, which is fire-and-forget. An event write failure never affects the session.

Signals 1 and 2 call `setTerminalSignal(state, { kind: 'stuck', reason: ... })` subject to `stuckAbortPolicy`. Signal 3 (`timeout_imminent`) is purely observational -- the abort has already been triggered by the timeout handler.

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

`evaluateRecovery({ stepAdvances: >= 1 })` returns `'resume'`. If the sidecar contains `workflowId` and `workspacePath`, `runStartupRecovery()` calls `executeContinueWorkflow({ intent: 'rehydrate' })` to get the current step prompt, builds a minimal `WorkflowTrigger` and a `pre_allocated` `SessionSource`, and calls `runWorkflow()` fire-and-forget.

**Old-format sidecars** (missing `workflowId`/`workspacePath`) fall through to discard regardless of step count.

### 6.4 Resumed sessions use `branchStrategy: 'none'`

Worktree sessions that are resumed set `branchStrategy: 'none'` and use the persisted `worktreePath` as `workspacePath`. This prevents the resumed session from creating a second worktree on top of the existing one.

---

## 7. Structural enforcement summary

The invariants above are enforced by a combination of type system guarantees and code structure:

- `tagToStatsOutcome()` -- pure function with `assertNever` default; compiler error on unhandled `_tag`
- `sidecardLifecycleFor()` -- pure function with `assertNever` default; compiler error on unhandled `_tag`
- `buildSessionResult()` -- pure function; reads `state.terminalSignal` after loop exits
- `finalizeSession()` -- single cleanup site for all result paths (event emission, registry cleanup, stats, sidecar deletion)
- `setTerminalSignal()` -- first-writer-wins; structurally prevents dual stuck+timeout state
- `SessionHandle` -- encapsulates steer/abort lifecycle; `abort()` before `setAgent()` is a safe no-op

Adding a new `WorkflowRunResult` variant requires updating `tagToStatsOutcome()` and `sidecardLifecycleFor()` -- the compiler enforces both via `assertNever`. No I/O needs to be added at the new return site.
