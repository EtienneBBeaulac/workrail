# Design Review: Bypass Dispatch Dedup for Pre-Allocated Sessions

**Date:** 2026-04-19
**Reviewer:** Claude (automated design review pass)
**Selected approach:** Wrap dedup block in `if (workflowTrigger._preAllocatedStartResponse === undefined)`

---

## Tradeoff Review

### Shared dedup map stays shared

The `_recentAdaptiveDispatches` map remains shared across all dispatch paths. Pre-alloc calls
bypass the check but do not update the map.

**Assessment:** Sound. The map entry from `dispatchAdaptivePipeline()` correctly blocks duplicate
top-level pipelines for 30s. Pre-alloc calls are child sessions -- they should not add new map
entries. All cross-path scenarios analyzed; no violations found.

**Condition for unacceptability:** If a legitimate retry of the same goal+workspace (without
pre-alloc) must fire within 30s of the original dispatch. Unlikely in practice; TTL is 30s.

### Comment is the only regression protection

The guard `if (_preAllocatedStartResponse === undefined)` wrapping the dedup block has no
compile-time enforcement beyond the unit test.

**Assessment:** Acceptable. The unit test `dispatch() with _preAllocatedStartResponse bypasses
dedup and calls runWorkflowFn` catches any regression. The JSDoc on the field and the guard
comment provide documentation-level protection.

---

## Failure Mode Review

| Mode | Handled? | Mitigation |
|---|---|---|
| Guard removed in refactor | Yes | Unit test catches it |
| Falsy check instead of `!== undefined` | Non-issue | Type is always an object when present |
| Semaphore deadlock | Not new risk | Pre-existing FIFO semaphore handles this |
| Session completes before enqueue | Not real | executeStartWorkflow doesn't run agent loop |

**Highest-risk:** Guard removed in refactor. Mitigated by unit test.

---

## Runner-Up / Simpler Alternative Review

- **Runner-up (early-return guard A):** Structurally equivalent. Loses because B keeps a single
  enqueue block, reducing duplication risk. No elements worth borrowing beyond the guard comment.
- **Simpler alternative (extract `_enqueueDispatch`):** Would be cleaner but is out of scope for
  this targeted fix. No correctness benefit.

---

## Philosophy Alignment

All relevant CLAUDE.md principles are satisfied:
- **Architectural fixes over patches** -- the guard models the root invariant
- **Make illegal states unrepresentable** -- compile-time discriminator
- **YAGNI with discipline** -- minimal change, no speculation
- **Document why, not what** -- guard comment explains invariant

Pre-existing tensions (mutable shared map) are not introduced by this fix.

---

## Findings

**No RED findings.** No blocking issues detected.

**ORANGE (advisory):**
1. The guard comment must be explicit about WHY dedup is bypassed, not just THAT it is bypassed.
   A vague comment like `// skip dedup for pre-alloc` is insufficient. The comment must state:
   'executeStartWorkflow already created the session in the store; dropping this dispatch would
   zombie it.'

**YELLOW (notes):**
1. The unit test for the bypass case should assert that `runWorkflowFn` is called exactly once
   (not just called), to verify the session actually starts.
2. Consider adding a log line in the bypass path: `console.log('[TriggerRouter] Pre-allocated session dispatched: workflowId=...')` for observability.

---

## Recommended Revisions

1. Write the guard comment to match the invariant stated in the design doc:
   ```typescript
   // Pre-allocated session: executeStartWorkflow already created the session in the store.
   // Deduplication must not apply here -- dropping this dispatch would zombie the session.
   ```
2. In the test: assert `calls` has exactly 1 entry (`toHaveLength(1)`) after the bypass dispatch.
3. Optional: add a `console.log` in the bypass path for daemon observability.

---

## Residual Concerns

None. The fix is sound, minimal, and directly models the documented invariant. All failure modes
are either handled or pre-existing. The design is ready for implementation.
