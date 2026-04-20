# Design: Stuck Escalation for Overnight-Autonomous WorkTrain Sessions

## Context / Ask

**Stated goal:** Design automatic escalation when WorkTrain sessions get stuck, so overnight-autonomous runs don't burn their full 30-minute wall clock on a broken tool call.

**This goal is a solution statement.** The underlying problem is:

> Overnight-autonomous sessions have no early-exit path when the agent enters a stuck loop. The system must detect the stuck state, abort cleanly, and produce structured diagnostic output without requiring a human to check the logs after the full wall-clock budget is consumed.

**Scope:** `src/daemon/workflow-runner.ts` and `src/trigger/trigger-router.ts` only. Do NOT touch `src/mcp/`.

**Prior art:** `docs/design/daemon-stuck-detection-discovery.md` -- discovery that defined the three stuck heuristics, added `AgentStuckEvent` to `daemon-events.ts`, and wired `repeated_tool_call`, `no_progress`, and `timeout_imminent` into the `turn_end` subscriber. Those signals exist and fire today. They are advisory-only -- no abort, no outbox, no notification.

## Path Recommendation

**`full_spectrum`** -- both landscape grounding (where to hook abort/outbox in the existing code) and concept shaping (abort policy, result variant design) are real risks. The proposed approach is well-matched to the problem, but the integration point and the result type design need careful analysis.

## Constraints / Anti-goals

**Constraints:**
- Abort only within `src/daemon/` and `src/trigger/`. No changes to `src/mcp/`.
- `WorkflowRunResult` is a discriminated union consumed by `assertNever` in `TriggerRouter.route()` and `dispatch()` -- any new variant must be handled exhaustively in both callers.
- Outbox write must be best-effort (non-fatal) -- same contract as `DaemonEventEmitter.emit()`.
- Notifications are fire-and-forget -- same contract as `NotificationService.notify()`.
- `stuckAbortPolicy` must be opt-in, defaulting to `'abort'` for new triggers and to `'notify_only'` for any existing trigger that doesn't specify it (to avoid breaking existing behavior).

**Anti-goals:**
- Do not build a watchdog daemon or restart mechanism.
- Do not implement coordinator retry logic in this design (that is a future fix-coordinator concern).
- Do not change the `turn_end` subscriber's detection thresholds -- this design wires actions to existing signals, not new signals.
- Do not make `outbox.jsonl` the sole escalation path -- it has no automated consumer.

## Challenged Assumptions

1. **Assumption: The three heuristics reliably distinguish stuck from legitimately slow.**
   - Risk: `make all` called 3x triggers `repeated_tool_call` but is not stuck. `no_progress` at 80% turns fires during valid deep research.
   - Mitigation: `stuckAbortPolicy: 'notify_only'` available per trigger. For `repeated_tool_call`, the abort is justified because the exact same `argsSummary` (200-char JSON) repeating 3x is a stronger signal than mere tool-name repetition.

2. **Assumption: Aborting on first heuristic trigger is better than one warning turn.**
   - Risk: a transient 500 error resolves on the next turn; abort kills a recovering session.
   - Mitigation: allow `stuckAbortThreshold` (future extension) to increase the repeat count before abort. For the initial design, threshold stays at 3 (existing `STUCK_REPEAT_THRESHOLD`).

3. **Assumption: `outbox.jsonl` is the right escalation target.**
   - Reality: `outbox.jsonl` has no automated consumer -- only `worktrain-inbox` (manual CLI) and `pr-review.ts` `drainMessageQueue` read it. The primary actionable signal is the macOS/webhook notification.
   - Resolution: write to both outbox (for coordinator scripts) AND fire notification (for human overnight use). Neither is the sole path.

## Landscape Packet

### Integration point: where abort already happens

In `workflow-runner.ts` the `turn_end` subscriber already has two abort paths:

```
// max_turns path (line 3088-3104)
if (maxTurns > 0 && turnCount >= maxTurns && timeoutReason === null) {
  timeoutReason = 'max_turns';
  emitter?.emit({ kind: 'agent_stuck', reason: 'timeout_imminent', ... });
  agent.abort();
  return;
}

// stuck detection heuristics (lines 3106-3165)
// -- repeated_tool_call: emit only, no abort
// -- no_progress: emit only, no abort
// -- timeout_imminent: emit only (abort already fired in setTimeout callback)
```

The stuck abort must be inserted immediately after each heuristic `emitter?.emit()` call, guarded by `stuckAbortPolicy`.

### WorkflowRunResult union (current)

```typescript
type WorkflowRunResult =
  | WorkflowRunSuccess        // _tag: 'success'
  | WorkflowRunError          // _tag: 'error'
  | WorkflowRunTimeout        // _tag: 'timeout'
  | WorkflowDeliveryFailed    // _tag: 'delivery_failed'
```

`TriggerRouter.route()` and `dispatch()` both have `assertNever(result)` guards. Adding a new `_tag: 'stuck'` variant requires handling in both.

### outbox.jsonl write pattern (from pr-review.ts)

```typescript
const outboxPath = path.join(os.homedir(), '.workrail', 'outbox.jsonl');
await fs.mkdir(workrailDir, { recursive: true });
await fs.appendFile(outboxPath, JSON.stringify(entry) + '\n', 'utf8');
```

No shared utility -- each writer does it directly. The stuck-escalation writer should follow the same pattern, injected via `WorkflowTrigger` deps or called as a module-level helper.

### NotificationService (notification-service.ts)

`notify(result: WorkflowRunResult, goal: string)` -- already dispatches on `result._tag`. Adding a `stuck` variant requires a new case in `buildNotificationBody()`, `buildOutcome()`, and `buildDetail()`.

### agentConfig in WorkflowTrigger (workflow-runner.ts line 214)

```typescript
readonly agentConfig?: {
  readonly model?: string;
  readonly maxSessionMinutes?: number;
  readonly maxTurns?: number;
  // NEW:
  readonly stuckAbortPolicy?: 'abort' | 'notify_only';
  readonly noProgressAbortEnabled?: boolean;
};
```

This is the correct location for both new fields. They are session-behavior knobs, same as `maxSessionMinutes` and `maxTurns` -- not trigger-routing knobs.

## Problem Frame Packet

The three stuck heuristics (`repeated_tool_call`, `no_progress`, `timeout_imminent`) fire today as advisory events. There is no action. For overnight-autonomous use, the invariant must change:

- `repeated_tool_call` is a **hard abort signal** -- same tool+args 3x is definitionally broken.
- `no_progress` at 80% turns is a **soft abort signal** -- may have false positives; the policy controls whether to abort or just notify.
- `timeout_imminent` already has an abort (the wall-clock timer fires `agent.abort()` independently) -- no new abort needed here, but a stuck-escalation outbox entry and notification should fire.

After abort, `runWorkflow()` must return a new `WorkflowRunResult` variant that carries enough structured data for a human and a future fix-coordinator to understand the failure without reading logs.

## Recommended Design

### 1. Abort Policy

| Signal | Default action | With `stuckAbortPolicy: 'notify_only'` | Gating flag |
|---|---|---|---|
| `repeated_tool_call` | Abort immediately | Emit event only, no abort | Always active |
| `no_progress` | Emit + notify only | Emit + notify only | `noProgressAbortEnabled: true` required to abort |
| `timeout_imminent` | No new abort (already aborting) | Same | N/A |

**`stuckAbortPolicy: 'abort' | 'notify_only'`** (default: `'abort'`): controls whether a stuck signal triggers an abort or only an event emission and notification. Per-trigger, lives in `agentConfig`.

**`noProgressAbortEnabled: boolean`** (default: `false`): separately gates whether the `no_progress` heuristic (80% turns, 0 step advances) can trigger an abort. When false, `no_progress` only emits the `agent_stuck` event and fires a notification -- it never aborts. This flag exists because `no_progress` has a meaningful false-positive rate on legitimate deep-research sessions (e.g. a wr.discovery run spending 50 turns before its first step advance).

**Rationale for the default `noProgressAbortEnabled: false`:** The primary overnight-autonomous failure mode is `repeated_tool_call` (the same failing command called 15x). The `no_progress` heuristic is a secondary signal that benefits from explicit opt-in after the false-positive rate is observed in production.

### 2. New `WorkflowRunResult` Variant

```typescript
/** Workflow aborted by stuck detection before the wall-clock timeout fired. */
export interface WorkflowRunStuck {
  readonly _tag: 'stuck';
  readonly workflowId: string;
  /**
   * Which heuristic triggered the abort.
   * Matches AgentStuckEvent.reason to allow correlation with daemon event log.
   */
  readonly stuckReason: 'repeated_tool_call' | 'no_progress';
  /** Human-readable description of why stuck was detected. */
  readonly detail: string;
  /** The tool name that was called repeatedly (present for repeated_tool_call). */
  readonly toolName?: string;
  /** The argsSummary of the repeated call (present for repeated_tool_call). */
  readonly argsSummary?: string;
  /** Total LLM turns consumed at the time of abort. */
  readonly turnCount: number;
  /** Number of workflow step advances at the time of abort. */
  readonly stepAdvanceCount: number;
  /**
   * Wall-clock milliseconds elapsed from session start to abort.
   * Lets a coordinator compute wall-clock savings vs. a full timeout.
   * Requires `sessionStartMs = Date.now()` to be added before the agent loop.
   */
  readonly elapsedMs: number;
  /**
   * Summaries of all issue_reported calls during this session (if any).
   * Populated from the `issueSummaries` ring tracked by the onIssueSummary callback.
   * Provides additional context for a fix-coordinator without requiring log parsing.
   */
  readonly issueSummaries?: readonly string[];
}

// Updated union:
export type WorkflowRunResult =
  | WorkflowRunSuccess
  | WorkflowRunError
  | WorkflowRunTimeout
  | WorkflowDeliveryFailed
  | WorkflowRunStuck;    // NEW
```

**Why a new variant instead of reusing `WorkflowRunError` or `WorkflowRunTimeout`:**
- `WorkflowRunError` means a tool or engine error, not a stuck loop. Conflating them forces consumers to parse message strings.
- `WorkflowRunTimeout` means the wall-clock fired -- stuck abort happens _before_ the wall clock fires.
- A distinct `_tag: 'stuck'` lets `TriggerRouter`, `NotificationService`, and future coordinators distinguish the case at compile time with `assertNever` exhaustiveness.

**`ChildWorkflowRunResult` must also be updated** to include `WorkflowRunStuck` since `runWorkflow()` now produces it directly (not via `TriggerRouter`).

### 3. Outbox Entry Schema

Written to `~/.workrail/outbox.jsonl` as a single JSONL line immediately after abort:

```json
{
  "id": "<uuid-v4>",
  "kind": "stuck_session",
  "sessionId": "<local-uuid>",
  "workrailSessionId": "<sess_...>",
  "workflowId": "<workflow-id>",
  "stuckReason": "repeated_tool_call",
  "detail": "Same tool+args called 3 times: Bash",
  "toolName": "Bash",
  "argsSummary": "{\"command\":\"npm test\"}",
  "turnCount": 12,
  "stepAdvanceCount": 0,
  "elapsedMs": 94000,
  "issueSummaries": ["Tool call failed: ENOENT /path/to/file"],
  "timestamp": "2026-04-19T03:14:15.926Z"
}
```

**Fields needed by a future fix-coordinator:**
- `stuckReason` + `toolName` + `argsSummary` -- to classify the failure and decide whether to retry
- `turnCount` + `stepAdvanceCount` -- to understand how much progress was lost
- `workrailSessionId` -- to correlate with WorkRail session store for checkpoint resumption
- `elapsedMs` -- to measure wall-clock savings vs. a full timeout

### 4. Integration Point

**Location: inside the `turn_end` subscriber in `runWorkflow()`, immediately after each stuck heuristic `emitter?.emit()` call.**

Rationale:
- This is where `agent.abort()` already lives for `max_turns`.
- `turnCount`, `stepAdvanceCount`, `sessionStartMs`, `toolName`, `argsSummary` are all in scope as closures.
- Post-run handling in `TriggerRouter.route()` is the wrong layer: by the time `runWorkflow()` returns, the outbox write should already have happened (it's diagnostic context for the abort, not post-hoc delivery).

**Abort sequence (for `repeated_tool_call`):**
1. Check: `stuckAbortPolicy !== 'notify_only'` (default: abort)
2. Set `stuckReason` and `stuckContext` closure variables
3. Call `agent.abort()`
4. Write outbox entry (best-effort, non-fatal, fire-and-forget pattern)
5. Return from `turn_end` subscriber (same as `max_turns` path)
6. `runWorkflow()` catches the abort and returns `WorkflowRunResult` with `_tag: 'stuck'`

**`runWorkflow()` return path:**
The existing error-catch block needs a branch for the stuck abort. The `stuckContext` closure variable (set in step 2 above) distinguishes stuck abort from other aborts:

```typescript
// Existing error catch in runWorkflow():
} catch (err) {
  if (stuckContext !== null) {
    return {
      _tag: 'stuck',
      workflowId: trigger.workflowId,
      ...stuckContext,
    };
  }
  // ... existing error handling
}
```

### 5. TriggerRouter Changes

Both `route()` and `dispatch()` need a new branch before the `assertNever` guard:

```typescript
} else if (result._tag === 'stuck') {
  console.log(
    `[TriggerRouter] Workflow stuck: triggerId=${trigger.id} ` +
    `workflowId=${trigger.workflowId} reason=${result.stuckReason} ` +
    `tool=${result.toolName ?? 'n/a'} turns=${result.turnCount}`,
  );
}
```

Delivery (`maybeRunDelivery`) should NOT run for stuck results -- there is no successful output to commit.

### 6. NotificationService Changes

Three pure functions need new cases:

```typescript
// buildNotificationBody:
case 'stuck':
  return `Session aborted (stuck loop): ${truncated}`;

// buildOutcome: NotificationPayload['outcome'] needs 'stuck' added
// buildDetail:
case 'stuck':
  return `stuckReason: ${result.stuckReason}; tool: ${result.toolName ?? 'n/a'}; ` +
         `turns: ${result.turnCount}; stepAdvances: ${result.stepAdvanceCount}`;
```

`NotificationPayload.outcome` currently is `'success' | 'error' | 'timeout' | 'delivery_failed'`. Add `'stuck'`.

## 5-File Change Estimate

| File | Change |
|---|---|
| `src/daemon/workflow-runner.ts` | (1) Add `WorkflowRunStuck` interface and update `WorkflowRunResult` union. (2) **CRITICAL: Also update `ChildWorkflowRunResult` type alias** -- if missed, the cast at line 2014 silently allows `_tag: 'stuck'` to reach `makeSpawnAgentTool`'s assertNever, causing a runtime crash in child sessions. (3) Add `stuckAbortPolicy` and `noProgressAbortEnabled` to `WorkflowTrigger.agentConfig`. (4) Add `sessionStartMs = Date.now()` alongside `turnCount`. (5) Wire abort + fire-and-forget outbox write in `turn_end` subscriber. (6) Add `stuckContext` closure variable + branch in catch block to return `_tag: 'stuck'`. (7) Add `stuck` case to `makeSpawnAgentTool` switch. |
| `src/trigger/trigger-router.ts` | Add `stuck` branch in `route()` and `dispatch()` before `assertNever`; `maybeRunDelivery` already skips non-success results (no change needed). |
| `src/trigger/notification-service.ts` | Add `stuck` case to `buildNotificationBody`, `buildOutcome`, `buildDetail`; add `'stuck'` to `NotificationPayload.outcome`. |
| `src/trigger/types.ts` | Add `stuckAbortPolicy?: 'abort' | 'notify_only'` and `noProgressAbortEnabled?: boolean` to `TriggerDefinition.agentConfig`. |
| `src/daemon/daemon-events.ts` | No changes required -- `AgentStuckEvent` already exists and fires. |

**Total: 4 files changed** (`daemon-events.ts` is unchanged). `workflow-runner.ts` has multiple edit locations -- all must be done in a single commit to avoid TypeScript exhaustiveness errors at intermediate states.

## Decision Log

- **`full_spectrum` path chosen** because both the integration point (landscape) and the result type design (concept) are genuine risks.
- **New `_tag: 'stuck'` variant** preferred over reusing `WorkflowRunTimeout` because stuck abort fires _before_ the wall clock -- conflating them loses diagnostic precision.
- **Outbox write in `turn_end` subscriber** (not in `TriggerRouter`) because the outbox entry is diagnostic context for the abort, not post-hoc delivery.
- **`stuckAbortPolicy` in `agentConfig`** (not a top-level `TriggerDefinition` field) because it belongs with `maxSessionMinutes` and `maxTurns` -- all are session-behavior knobs, not trigger-routing knobs.
- **`timeout_imminent` does not get a new abort** -- the wall-clock timer already calls `agent.abort()` independently; adding a second abort would be redundant and could race.
- **Default `stuckAbortPolicy: 'abort'`** for all triggers. Overnight-autonomous is the primary use case. Human-supervised users who want softer behavior must opt in to `'notify_only'`.
- **`noProgressAbortEnabled: false` default** -- `no_progress` has a real false-positive rate on deep-research sessions. Separating the gate from `stuckAbortPolicy` allows independent control: a trigger can have `stuckAbortPolicy: 'abort'` (abort on `repeated_tool_call`) without also aborting on `no_progress`.
- **`issueSummaries` field borrowed from Candidate C** -- the `issueSummaries` array is already tracked in session closures at zero additional collection cost. Adding it to `WorkflowRunStuck` now avoids a future breaking interface change when a fix-coordinator needs it.
- **outbox is best-effort** (fire-and-forget, errors swallowed) -- consistent with the `DaemonEventEmitter` contract. A failed write must never affect the `WorkflowRunResult`.
- **`sessionStartMs = Date.now()`** must be added before the agent loop -- it does not currently exist in workflow-runner.ts. Trivial one-line addition.
- **Candidate A rejected** -- adding `reason: 'stuck_loop'` to `WorkflowRunTimeout` conflates stuck-abort with wall-clock timeout, violating 'make illegal states unrepresentable'. The 5-file vs. 2-file maintenance advantage does not justify this semantic violation.
- **Candidate C deferred** -- `issue_reported severity=fatal` abort is the correct Phase 2 extension once `repeated_tool_call` abort is validated in production. The `issueSummaries` field on `WorkflowRunStuck` provides partial Candidate C value at near-zero cost.

## Residual Concerns

1. **`repeated_tool_call` false-positive rate in production is unvalidated.** The `stuckAbortPolicy: 'notify_only'` escape hatch mitigates. If false-positive rate exceeds ~20%, consider flipping the default to `'notify_only'` and making `'abort'` opt-in.

2. **Outbox write may be lost on rapid daemon shutdown.** The fire-and-forget write initiates before `runWorkflow()` returns, but completes asynchronously. On SIGKILL, the entry may be lost. Same risk as `DaemonEventEmitter` -- accepted by design.

3. **No shadow-mode validation.** Ideally, heuristics would run in shadow mode (emit only) for 20+ production sessions before enabling abort. `stuckAbortPolicy: 'notify_only'` serves as a manual shadow mode.

## Final Summary

The design adds `WorkflowRunStuck` as a new `WorkflowRunResult` variant (`_tag: 'stuck'`), wires abort into the `repeated_tool_call` heuristic (unconditional, subject to `stuckAbortPolicy`) and optionally into `no_progress` (gated by `noProgressAbortEnabled: true`) in the `turn_end` subscriber, writes a structured outbox entry on abort, and extends `NotificationService` to distinguish stuck from timeout. The result carries `issueSummaries` for coordinator context. The policy is per-trigger via `agentConfig.stuckAbortPolicy` and `agentConfig.noProgressAbortEnabled`. The change touches 4 files and follows all existing patterns (fire-and-forget outbox, best-effort notification, `assertNever` exhaustiveness, max_turns abort template). A future fix-coordinator can read the outbox entry and extract all fields needed to classify and potentially retry the stuck session without parsing log text.

**Critical implementation note:** `ChildWorkflowRunResult` must be updated in the same commit as `WorkflowRunResult`. Failure to do so causes a runtime `assertNever` crash in child sessions spawned by `makeSpawnAgentTool`.
