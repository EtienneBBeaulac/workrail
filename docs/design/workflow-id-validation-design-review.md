# Design Review: Workflow ID Validation at Daemon Startup

**Design under review:** Candidate A -- injectable `getWorkflowByIdFn` on `StartTriggerListenerOptions`  
**Date:** 2026-04-16

---

## Tradeoff Review

| Tradeoff | Acceptable? | Condition that breaks it |
|----------|-------------|--------------------------|
| Validation silently skipped when fn not provided | Yes | A new production call site added without the fn |
| New option field (API surface) | Yes | Interface is internal, non-breaking |

Hidden assumption: single production call site for `startTriggerListener`. True today.

**Mitigation added:** Log message when fn not provided, making the skip visible in startup logs.

---

## Failure Mode Review

| Failure Mode | Handled? | Action Required |
|--------------|----------|-----------------|
| FM1: getWorkflowByIdFn throws/rejects | NOT YET | Add try/catch around each fn call; warn+skip on error |
| FM2: transient workflow unavailability | Acceptable | warn+skip behavior is correct here |
| FM3: Map mutation during iteration | NOT YET | Collect unknowns in first pass, delete in second pass |
| FM4: ctx.workflowService undefined in production | Needs guard | Use optional chaining `?.` in default fn |

**Highest-risk:** FM1. An unhandled rejection would crash `startTriggerListener`. Must fix.

---

## Runner-Up / Simpler Alternative Review

- Runner-up (Candidate B, ctx direct): no elements to borrow. Testability loss outweighs API surface saving.
- No simpler variant satisfies both testability and correctness requirements.
- Candidate A is already minimum viable for the acceptance criteria.

---

## Philosophy Alignment

**Satisfied:** Dependency injection, validate at boundaries, errors are data, YAGNI, surface information.  
**Under tension (acceptable):**
- "Make illegal states unrepresentable" -- TriggerDefinition can still hold invalid workflowIds. Compile-time enforcement would require two-phase types; over-engineering for a Small task.
- "Immutability by default" -- triggerIndex Map is mutated, but mutation is local (created and modified within `startTriggerListener`, not shared until passed to TriggerRouter).

---

## Findings

**ORANGE -- FM1: Unhandled rejection from getWorkflowByIdFn**  
The current design has no try/catch around the fn call. An I/O error in the workflow storage lookup would propagate as an unhandled rejection and crash `startTriggerListener`. Fix: wrap each `await getWorkflowByIdFn(trigger.workflowId)` in try/catch; on error, log warning and skip that trigger (same policy as other validation failures).

**YELLOW -- FM3: Two-pass Map deletion**  
Must not delete from `triggerIndex` while iterating it. Fix: collect unknown IDs in an array during the loop, then delete in a second pass.

**YELLOW -- FM4: ctx.workflowService guard**  
The default fn production expression `ctx.workflowService.getWorkflowById(id).then(...)` will throw if `workflowService` is undefined. Fix: use optional chaining `ctx.workflowService?.getWorkflowById(id).then(w => w !== null) ?? true` (treat unavailable service as "found" -- skip validation rather than crash).

---

## Recommended Revisions

1. **Required:** Add try/catch in the validation loop; treat fn errors as warn+skip.
2. **Required:** Collect unknowns first, delete after iteration.
3. **Required:** Use optional chaining for the default production fn.
4. **Nice-to-have:** Log `[TriggerListener] workflowId validation skipped (no resolver provided)` when fn is absent, for observability.

---

## Residual Concerns

- The "silent skip when fn not provided" is acceptable but relies on a naming convention (option field) to communicate intent. Future callers won't get a compile-time reminder to provide the fn. This is a documentation concern, not a correctness concern.
- `onComplete.workflowId` is not validated by this design. Out of scope for this task; should be a follow-up if `onComplete` usage grows.
- No RED findings. All issues are fixable at implementation time with minor code additions.

---

## Pass 2 Findings (incremental)

No new RED or ORANGE findings. Design revisions from pass 1 are sufficient.

**New observation (YELLOW):** `onComplete.workflowId` (secondary workflow for completion hooks) is not validated. Accepted as out of scope -- add a comment in the implementation noting this limitation.

**Performance:** Sequential validation of N triggers is acceptable at expected trigger counts (1-10). No action needed.
