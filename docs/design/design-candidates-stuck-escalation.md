# Design Candidates: WorkTrain Stuck-Escalation

*Generated: 2026-04-19 | Pitch: .workrail/current-pitch.md*

---

## Problem Understanding

### Core Tensions

1. **Stuck vs timeout conflation**: When `repeated_tool_call` fires, the session
   currently runs until wall-clock or max-turns timeout. The result is
   `_tag: 'timeout'`, which is indistinguishable from a legitimate slow session.
   Automated routing requires a distinct discriminant.

2. **Abort vs notify-only independence**: Outbox notification and `agent.abort()`
   are two separate effects. `notify_only` policy suppresses the abort but must
   not suppress the outbox write. These effects must not be coupled.

3. **ChildWorkflowRunResult atomic update**: The `as ChildWorkflowRunResult` cast
   at line 2172 in `makeSpawnAgentTool` suppresses any compile-time error from a
   missing union update. Only the `assertNever(childResult)` at line 2212 catches
   the omission -- at runtime, crashing the parent session.

4. **no_progress false-positive risk**: The no_progress heuristic fires on
   legitimate research workflows that spend many turns reading before advancing.
   It must be opt-in (default: false) to avoid breaking existing sessions.

### Likely Seam

The `turn_end` subscriber in `runWorkflow()` is the correct location. All
required state (lastNToolCalls, stepAdvanceCount, timeoutReason, issueSummaries)
is available there as closure variables. Detection fires at the right moment
(after each turn, synchronously before next step injection).

### What Makes This Hard

- The `as ChildWorkflowRunResult` cast is a type-safety trap: it silences
  TypeScript while leaving a runtime crash. Only careful reading of the pitch
  reveals the issue.
- `buildOutcome()` in notification-service.ts has return type
  `NotificationPayload['outcome']`. Adding 'stuck' to WorkflowRunResult causes
  a compile error there unless the outcome union is also widened.

---

## Philosophy Constraints

From CLAUDE.md:

- **Make illegal states unrepresentable**: the stuck discriminant prevents
  conflating stuck with timeout at the type level.
- **Exhaustiveness everywhere**: assertNever guards in trigger-router and
  makeSpawnAgentTool enforce this -- adding stuck arm is required.
- **Errors are data**: WorkflowRunResult is a Result type; WorkflowRunStuck is
  a new variant, not an exception.
- **Type safety as first line of defense**: ChildWorkflowRunResult update in
  same commit restores the compile-time invariant that the cast broke.
- **Fire-and-forget for side effects**: outbox write uses void + catch, same
  as DaemonEventEmitter and issue recording.

No conflicts between stated philosophy and repo patterns.

---

## Impact Surface

Paths that must stay consistent when WorkflowRunResult gains a new variant:

1. `makeSpawnAgentTool` -- `assertNever(childResult)` at line 2212; requires
   ChildWorkflowRunResult update and a new `stuck` arm in the result mapping.
2. `trigger-router.ts` `route()` -- exhaustive if-else chain ending in
   `assertNever(result)` at line ~689.
3. `trigger-router.ts` `dispatch()` -- same exhaustive chain at line ~770.
4. `notification-service.ts` `buildNotificationBody()` -- exhaustive switch.
5. `notification-service.ts` `buildDetail()` -- exhaustive switch.
6. `notification-service.ts` `buildOutcome()` -- return type
   `NotificationPayload['outcome']`; 'stuck' must be added to that union.
7. `NotificationPayload.outcome` union -- currently
   `'success' | 'error' | 'timeout' | 'delivery_failed'`; must add `'stuck'`.

---

## Candidates

### Candidate A: New `_tag: 'stuck'` discriminated union variant (SELECTED)

**Summary**: Add `WorkflowRunStuck` interface with `_tag: 'stuck'`, wire abort
in turn_end subscriber after Signal 1 and Signal 2 emitter calls, return stuck
result before timeout check, update both `WorkflowRunResult` and
`ChildWorkflowRunResult` unions atomically, add `writeStuckOutboxEntry` helper.

**Tensions resolved**:
- Stuck/timeout conflation: separate discriminant, separate return path.
- Abort/notify independence: outbox write fires before the abort gate check.
- ChildWorkflowRunResult crash: atomic update with assertNever arm added.
- no_progress false-positive: gated by `noProgressAbortEnabled: false` default.

**Boundary solved at**: `turn_end` subscriber (detection + abort), result
construction (return), 4 files for propagation to callers.

**Why best-fit boundary**: The turn_end subscriber is the only location with
access to all required state. The result construction is the canonical output
boundary for runWorkflow(). Propagation to callers follows the existing
WorkflowRunResult variant fan-out pattern.

**Failure mode**: Forgetting to update `NotificationPayload.outcome` union --
caught by `npm run build` (TypeScript compile error in `buildOutcome()`).

**Repo-pattern relationship**: Mirrors `timeoutReason` flag pattern exactly.
Mirrors `WorkflowRunTimeout` interface field shape. Follows assertNever guard
pattern already established in trigger-router and makeSpawnAgentTool.

**Gains**: Distinct routing for stuck sessions, type-safe callers, clean
separation of abort and notification effects.

**Losses**: One more variant in the union (minor cognitive load increase).

**Scope judgment**: Best-fit. 4 files, mechanical wiring, all design resolved.

**Philosophy fit**: Honors all relevant CLAUDE.md principles. No conflicts.

---

### Candidate B: Extend `WorkflowRunTimeout.reason` with stuck sub-values

**Summary**: Add `'stuck_repeated_tool_call' | 'stuck_no_progress'` to
`WorkflowRunTimeout.reason` -- reuse the timeout discriminant.

**Tensions resolved**: None of the core ones. Stuck and timeout still share
`_tag: 'timeout'`, requiring callers to inspect reason to distinguish them.

**Failure mode**: Violates make-illegal-states-unrepresentable. Callers using
`result._tag === 'timeout'` would silently handle stuck sessions as timeouts.

**Repo-pattern relationship**: Departs from the exhaustiveness-everywhere
pattern. The assertNever guard pattern exists precisely to avoid this.

**Scope judgment**: Too narrow -- preserves the routing problem this pitch
exists to solve.

**Rejected because**: Violates philosophy, does not resolve the core tension,
and the pitch explicitly rejects conflating stuck with timeout.

---

## Comparison and Recommendation

Candidate A is the only viable candidate. All analysis converges.

The core recommendation is to implement Candidate A exactly as specified in
`.workrail/current-pitch.md`, with one addition not noted in the pitch:
update `NotificationPayload.outcome` union to include `'stuck'` (required for
`buildOutcome()` to compile).

---

## Self-Critique

**Strongest counter-argument**: Adding a 5th variant to WorkflowRunResult
increases cognitive load for callers. Counter: assertNever guards make missing
cases compile errors, which is the correct safeguard. The complexity cost is
paid once (at implementation) and enforced automatically.

**Narrower option that lost**: Update only WorkflowRunResult, skip
ChildWorkflowRunResult. Lost because: runtime crash in makeSpawnAgentTool
when a child hits stuck-abort. The cast at line 2172 provides no protection.

**Broader option not justified**: Adding `onStuck:` hook to TriggerDefinition.
Explicitly deferred per pitch No-Gos. Would require trigger-store.ts parser
changes -- outside the 4-file scope.

**Pivot condition**: If `assertNever(childResult)` were removed in favor of a
logged fallback, ChildWorkflowRunResult update would be less critical. It is
not removed, so the atomic update is required.

---

## Open Questions for the Main Agent

None. All design decisions are resolved in the pitch. The only implementation
detail requiring attention is the `NotificationPayload.outcome` union widening
(add 'stuck') -- verify this compiles before finalizing.
