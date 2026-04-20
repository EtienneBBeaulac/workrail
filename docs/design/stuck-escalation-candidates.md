# Design Candidates: Stuck Escalation for Overnight-Autonomous WorkTrain Sessions

> Raw investigative material for main-agent review. Not a final decision.

## Problem Understanding

### Core Tensions

1. **Early certainty vs. false positives.** Aborting at threshold 3 for `repeated_tool_call` saves up to 27 minutes of a 30-minute session. But a legitimate retry loop (transient network error, idempotent file read called 3x) also triggers at 3. Higher threshold = fewer false positives but less wall-clock savings; lower = more savings but more false positives.

2. **Structural correctness vs. maintenance surface.** Adding `_tag: 'stuck'` to `WorkflowRunResult` is structurally clean (make illegal states unrepresentable) but widens the maintenance surface: every switch on the union must be updated. The naive alternative (add `reason: 'stuck_loop'` to `WorkflowRunTimeout`) avoids the new variant but conflates stuck abort with wall-clock timeout -- these have categorically different implications for retry logic.

3. **Abort power vs. future recoverability.** `agent.abort()` is terminal. A `steer()` injection could warn the agent and let it self-correct. Aborting closes the door to LLM-driven self-recovery. For overnight-autonomous use, abort is deterministic and saves resources. For supervised use, steer-and-warn might be preferred.

4. **Outbox write timing vs. fire-and-forget contract.** The outbox write must happen as close as possible to the abort moment. But `turn_end` is synchronous, and any blocking `await` would stall the abort path. Resolution: initiate outbox write as a detached fire-and-forget Promise in `turn_end`, same contract as `DaemonEventEmitter.emit()`.

### Likely Seam

`turn_end` subscriber in `workflow-runner.ts`. Confirmed -- not just where the symptom appears, but where all relevant state exists (`turnCount`, `stepAdvanceCount`, `lastNToolCalls`, `timeoutReason`). The `max_turns` abort at lines 3088-3104 is the exact template: set closure variable, emit event, call `agent.abort()`, return.

### What Makes This Hard

1. `ChildWorkflowRunResult` type alias (line 396) -- must be updated alongside `WorkflowRunResult`. If missed, the cast at line 2014 silently hides the new variant from `makeSpawnAgentTool`'s switch, producing a runtime `assertNever` error in production.

2. The fire-and-forget contract -- any `await` in the `turn_end` subscriber blocks the abort path. The outbox write must be a detached Promise.

3. Double-emit of `timeout_imminent` -- the max_turns path emits it AND the `timeoutReason !== null` check at line 3157 would also emit it. The design must not add a third abort here.

4. `maybeRunDelivery` gate in TriggerRouter -- must exclude `stuck` results from autoCommit delivery (there is no successful output to commit).

## Philosophy Constraints

From `CLAUDE.md` and codebase patterns:

- **Make illegal states unrepresentable** -- stuck and timeout are categorically different; a new discriminant is required.
- **Exhaustiveness everywhere** -- all `assertNever` guards must be updated when the union grows.
- **Errors are data** -- `WorkflowRunStuck` as a result value, not an exception.
- **Fire-and-forget observability** -- `DaemonEventEmitter.emit()` and `NotificationService.notify()` both return void and swallow errors. Outbox write must follow this contract.
- **YAGNI with discipline** -- do not add `issue_reported severity=fatal` abort without production evidence.
- **Pure functions for message building** -- `buildNotificationBody`, `buildOutcome`, `buildDetail` are pure switch-dispatch functions; new cases extend them cleanly.
- **WHY comments** -- every non-obvious decision must have an inline rationale comment.

No conflicts between stated philosophy and repo patterns.

## Impact Surface

Changes required beyond the immediate task if `WorkflowRunResult` is widened:

| Location | File | Required Change |
|---|---|---|
| `WorkflowRunResult` type alias | `workflow-runner.ts` | Add `WorkflowRunStuck` variant |
| `ChildWorkflowRunResult` type alias | `workflow-runner.ts` | Add `WorkflowRunStuck` variant |
| `makeSpawnAgentTool` switch | `workflow-runner.ts` | Add `stuck` case (assertNever guard) |
| `turn_end` subscriber | `workflow-runner.ts` | Add abort logic for `repeated_tool_call` and `no_progress` |
| `runWorkflow()` catch block | `workflow-runner.ts` | Add branch: if `stuckContext !== null` return `WorkflowRunStuck` |
| `TriggerRouter.route()` | `trigger-router.ts` | Add `stuck` log branch before `assertNever` |
| `TriggerRouter.dispatch()` | `trigger-router.ts` | Add `stuck` log branch before `assertNever` |
| `maybeRunDelivery` gate | `trigger-router.ts` | Exclude `stuck` from delivery |
| `buildNotificationBody` | `notification-service.ts` | Add `stuck` case |
| `buildOutcome` | `notification-service.ts` | Add `stuck` to return type |
| `buildDetail` | `notification-service.ts` | Add `stuck` case |
| `NotificationPayload.outcome` | `notification-service.ts` | Add `'stuck'` to union |
| `TriggerDefinition.agentConfig` | `types.ts` | Add `stuckAbortPolicy?: 'abort' | 'notify_only'` |

## Candidates

### Candidate A: Minimal -- Abort with existing result types

**Summary:** Wire `agent.abort()` after `repeated_tool_call` emit, add `reason: 'stuck_loop'` to `WorkflowRunTimeout` (new string value), skip outbox write and notification extension.

**Tensions resolved:** Maintenance surface (2 files changed).

**Tensions accepted:** Structural correctness (conflates stuck with wall-clock timeout), coordinator readiness (no toolName/argsSummary in result), notification distinctness (NotificationService cannot distinguish stuck from timeout).

**Boundary solved at:** `turn_end` subscriber + `WorkflowRunTimeout` extension. This is a symptom-level fix -- it stops the waste but provides no diagnostic value.

**Failure mode:** A coordinator script reading `result._tag === 'timeout'` has no way to distinguish stuck abort from wall-clock timeout without parsing `result.reason`. This is string parsing -- exactly what discriminated unions are designed to prevent.

**Repo pattern relationship:** Adapts max_turns abort template. Does NOT follow the `WorkflowRunTimeout` vs. `WorkflowRunError` precedent of 'one variant per categorically distinct outcome.'

**Gains:** 2 files changed. Minimal assertNever surface.

**Gives up:** Semantic precision (stuck != timeout), coordinator readiness, notification distinctness.

**Scope judgment:** Too narrow. Violates 'make illegal states unrepresentable.'

**Philosophy:** Honors YAGNI. Conflicts with 'make illegal states unrepresentable', 'exhaustiveness everywhere', 'errors are data.'

---

### Candidate B: Full -- New `WorkflowRunStuck` variant + outbox + notification (RECOMMENDED)

**Summary:** Add `WorkflowRunStuck` to `WorkflowRunResult` and `ChildWorkflowRunResult`; abort on `repeated_tool_call` and `no_progress`; write a 10-field outbox entry as a fire-and-forget Promise; extend `NotificationService` with a `stuck` case; add `stuckAbortPolicy: 'abort' | 'notify_only'` to `WorkflowTrigger.agentConfig`.

**Tensions resolved:** All four. Structural correctness (new variant), coordinator readiness (toolName/argsSummary/turnCount/stepAdvanceCount on the result), notification distinctness (new message body), policy expressiveness (stuckAbortPolicy with abort default).

**Tensions accepted:** Maintenance surface (5 files, all switch statements widened), policy granularity (no per-signal policy within a trigger -- only per-trigger).

**Boundary solved at:**
- `turn_end` subscriber: abort + fire-and-forget outbox write
- `runWorkflow()` catch block: construct `WorkflowRunStuck` from `stuckContext` closure variable
- `TriggerRouter.route()`/`dispatch()`: log and skip delivery
- `NotificationService.notify()`: new message body

**Failure mode:** The outbox write initiates in `turn_end` as a detached Promise but the `WorkflowRunStuck` result is returned synchronously from the catch block. The outbox write may complete AFTER the result reaches TriggerRouter. Acceptable (outbox is diagnostic, not delivery) but must be documented.

**Repo pattern relationship:** Follows the `WorkflowRunTimeout` precedent exactly. Uses `DaemonEventEmitter` fire-and-forget pattern for outbox write. Uses max_turns abort template. Extends `NotificationService` pure-function pattern.

**Gains:** Full semantic precision, coordinator-ready structured data, notification distinctness, type-safe exhaustiveness.

**Gives up:** 5-file maintenance surface, `ChildWorkflowRunResult` and `makeSpawnAgentTool` must be updated.

**Scope judgment:** Best-fit. Directly addresses all 4 decision criteria. No speculative abstractions.

**Philosophy:** Honors all core principles. Minor YAGNI pressure vs. Candidate A, but the added files are necessary consequences of correct union design.

---

### Candidate C: Extended -- Candidate B + `issue_reported severity=fatal` abort trigger

**Summary:** All of Candidate B, plus: abort when the `onIssueSummary` callback receives `severity: 'fatal'`, implemented via a `fatalIssueAbortPending` closure flag set by the callback and checked/cleared in `turn_end`. Adds `stuckReason: 'fatal_issue_report'` to `WorkflowRunStuck` and an optional `issueSummary` field.

**Tensions resolved:** All of Candidate B's tensions, plus the primary framing risk (agent self-report is more reliable than heuristics per session ea2de6e5).

**Tensions accepted:** Higher implementation complexity, one-turn abort latency for fatal issues (the flag is checked in `turn_end`, not inline in the callback).

**Boundary solved at:** All of Candidate B's boundaries, plus `onIssueSummary` callback wiring.

**Failure mode:** One-turn latency -- the abort fires on the turn AFTER `report_issue` calls, not immediately. For a fatal issue, one extra LLM turn is acceptable but must be documented.

**Repo pattern relationship:** Extends Candidate B. Adapts the existing `onIssueSummary` callback infrastructure.

**Gains:** Catches the most reliable real-world stuck signal. Directly addresses primary framing risk.

**Gives up:** Higher initial complexity. `stuckReason` union grows to 3 values. Requires production evidence to justify over Candidate B.

**Scope judgment:** Slightly broad for the initial design. The primary use case (blind tool loop) is covered by Candidate B. Candidate C is the correct Phase 2 extension.

**Philosophy:** Fully honors all principles. Marginal YAGNI pressure vs. Candidate B -- grounded in real log evidence (session ea2de6e5) but requires more than one data point to justify the added complexity upfront.

## Comparison and Recommendation

| Criterion | A | B | C |
|---|---|---|---|
| Structural correctness | FAIL | PASS | PASS |
| Coordinator readiness | FAIL | PASS | PASS |
| Notification distinctness | FAIL | PASS | PASS |
| Policy expressiveness | PARTIAL | PASS | PASS |
| Maintenance surface | Best | Medium | Highest |
| Covers primary framing risk | No | No | Yes |
| YAGNI compliance | Best | Good | Marginal |
| Reversibility | Hard | Easy | Easy |

**Recommendation: Candidate B.**

Reasoning: Structural correctness is non-negotiable (CLAUDE.md: 'make illegal states unrepresentable'). Candidate A fails this criterion regardless of its maintenance advantage. Candidate C is architecturally correct but the `issue_reported severity=fatal` trigger requires production evidence beyond session ea2de6e5. The 5-file surface of Candidate B is manageable because all changes are additive switch-case additions, and TypeScript exhaustiveness enforcement catches any missed location at compile time.

## Self-Critique

**Strongest counter-argument against Candidate B:** The `repeated_tool_call` heuristic may have an unacceptable false-positive rate in production. If it aborts legitimate sessions frequently, operators will set `stuckAbortPolicy: 'notify_only'` everywhere, negating the feature. A minimal Candidate A approach would have caused less collateral damage in this scenario.

**Response:** The `stuckAbortPolicy: 'notify_only'` escape hatch directly addresses this. The structural correctness argument still stands -- conflating stuck with timeout is a design debt that compounds over time.

**Pivot to Candidate A:** If there is a hard constraint against widening `WorkflowRunResult` (e.g., a serialization layer or cross-process protocol that can't handle new variants). No such constraint exists.

**Pivot to Candidate C:** If production logs show `repeated_tool_call` false-positive rate exceeds 20% while `issue_reported severity=fatal` false-positive rate is under 5%.

## Open Questions for the Main Agent

1. **Verify abort propagation:** Does `agent.abort()` called in `turn_end` correctly propagate to the `runWorkflow()` catch block without clearing closure state? The `stuckContext` variable must be readable in the catch block after abort. Confirm by reading `AgentLoop.abort()` implementation.

2. **`sessionStartMs` presence:** Is `const sessionStartMs = Date.now()` already set before the agent loop in `runWorkflow()`? If not, it must be added to support `elapsedMs` in the outbox entry.

3. **`no_progress` false-positive rate:** The 80%-turns threshold fires even on a legitimate research session. Should the initial design wire `no_progress` abort, or start with only `repeated_tool_call` abort and add `no_progress` in a follow-on?

4. **`stuckAbortPolicy` placement:** Should the policy live in `WorkflowTrigger.agentConfig` (as proposed), or in a separate top-level `TriggerDefinition.stuckPolicy` field to distinguish session-behavior knobs from routing knobs?
