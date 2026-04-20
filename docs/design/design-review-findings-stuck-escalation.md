# Design Review Findings: WorkTrain Stuck-Escalation

*Generated: 2026-04-19 | Pitch: .workrail/current-pitch.md*

---

## Tradeoff Review

| Tradeoff | Status | Condition for Failure |
|----------|--------|-----------------------|
| One more union variant in WorkflowRunResult | Acceptable | All callers use assertNever guards -- compile error enforces handling |
| ChildWorkflowRunResult atomic update relies on discipline | Managed | Fails only if commit is split; mitigated by single-PR implementation and compile-time test |
| NotificationPayload.outcome union widening (gap, not tradeoff) | Resolved | Add 'stuck' to outcome union; caught by npm run build |

---

## Failure Mode Review

| Failure Mode | Severity | Design Handling | Missing Mitigation |
|--------------|----------|-----------------|--------------------|
| ChildWorkflowRunResult not updated | High | Atomic commit, compile-time assignability test | None beyond discipline |
| stuckReason / timeoutReason race | Low | First-writer-wins guard; max_turns early return prevents race | None needed |
| writeStuckOutboxEntry fails | Low | Fire-and-forget, console.warn on error | None -- intentional |
| no_progress fires on research workflow | Low | noProgressAbortEnabled defaults to false | None needed |
| NotificationPayload.outcome compile error | Medium | Add 'stuck' to union | None -- caught at build |

---

## Runner-Up / Simpler Alternative Review

- **Candidate B** (extend WorkflowRunTimeout.reason): No elements worth borrowing.
  Does not resolve the core routing tension.
- **Skip ChildWorkflowRunResult**: Not acceptable -- runtime crash in parent session.
- **Skip sessionStartMs**: Not recommended -- pitch explicitly adds it for Signal 5 follow-up
  to avoid future restructuring.
- **Inline outbox write**: Works but reduces turn_end subscriber readability. Not worth it.

No hybrid opportunities identified.

---

## Philosophy Alignment

| Principle | Status |
|-----------|--------|
| Make illegal states unrepresentable | Satisfied |
| Exhaustiveness everywhere | Satisfied |
| Errors are data | Satisfied |
| Immutability by default | Satisfied |
| Type safety as first line of defense | Under tension (pre-existing cast; improved but not fully resolved) |
| Fire-and-forget for side effects | Satisfied |

---

## Findings

### Yellow: NotificationPayload.outcome union widening not specified in pitch

The pitch states 'buildOutcome() returns result._tag directly -- no change needed'.
However, the return type annotation `NotificationPayload['outcome']` will cause a
TypeScript compile error when 'stuck' is added to WorkflowRunResult but not to the
outcome union. **Resolution**: add `'stuck'` to `NotificationPayload.outcome` union
in notification-service.ts. This is a mechanical fix, not a design change.

### Yellow: Pre-existing `as ChildWorkflowRunResult` cast at line 2172

The cast suppresses TypeScript's compile-time check that would otherwise catch a
missing ChildWorkflowRunResult update. This PR updates the union and adds a
compile-time assignability test to partially compensate. Removing the cast is
out of scope. **Residual concern**: future union additions must be caught by the
test rather than the compiler.

---

## Recommended Revisions

1. Add `'stuck'` to `NotificationPayload.outcome` union (not in pitch, required for compile).
2. Add compile-time assignability test for `ChildWorkflowRunResult` in the test file.
3. Document the `as ChildWorkflowRunResult` cast issue in a code comment at line 2172
   (or verify existing comment is sufficient).

---

## Residual Concerns

- The `as ChildWorkflowRunResult` cast remains. Future contributors adding a new
  WorkflowRunResult variant may forget to update ChildWorkflowRunResult. The
  compile-time test in the stuck-escalation test file partially mitigates this,
  but only for the stuck variant. A broader structural fix (removing the cast)
  is a follow-up.
- Webhook consumers reading `outcome: 'stuck'` must handle the new value.
  This is a new feature, not a breaking change, but operators consuming the
  webhook should be aware.
