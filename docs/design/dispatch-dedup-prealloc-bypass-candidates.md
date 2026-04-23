# Design Candidates: Bypass Dispatch Dedup for Pre-Allocated Sessions

**Date:** 2026-04-19
**Status:** Decided -- Option A (guard before dedup block)
**Scope:** `src/trigger/trigger-router.ts`, `dispatch()` method only

---

## Problem Understanding

### Core Tensions

1. **Dedup protection vs session liveness** -- The 30s dedup window in `dispatch()` exists to prevent
   duplicate pipeline sessions from webhook retries. But the same mechanism incorrectly kills child
   sessions spawned by `spawnSession()`, which already pre-created the session in the store via
   `executeStartWorkflow()`. The invariant 'same key = duplicate' is false for pre-allocated sessions.

2. **Shared state vs path-specific logic** -- `_recentAdaptiveDispatches` is intentionally shared
   across `route()`, `dispatch()`, and `dispatchAdaptivePipeline()`. This cross-path coupling causes
   the key collision: `dispatchAdaptivePipeline()` writes `goal::workspace` at t=0, then `dispatch()`
   reads it at t~=0 and returns early. The fix must carve out an exception for one specific case
   without breaking the shared-state intent.

3. **Code reuse vs early-exit clarity** -- The dedup block is a scoped `{...}` block at the top of
   `dispatch()`. Adding the guard before it avoids duplicating the enqueue block, but requires
   careful restructuring to keep one enqueue call reached by both paths.

### Likely Seam

The real seam is `dispatch()` lines 851-866 (the dedup block). The symptom (zombie session) is
downstream, but the root cause (early return that bypasses `queue.enqueue()`) is exactly here.

### What Makes It Hard

A junior developer might:
- Add `_preAllocatedStartResponse` as a new parameter instead of checking the existing field.
- Delete the dedup block from `dispatch()` entirely (Option B) -- too broad.
- Add the guard inside the dedup block as a `return` that skips `_recentAdaptiveDispatches.set()`,
  which is technically acceptable (the map entry from `dispatchAdaptivePipeline()` is still valid
  for blocking duplicate top-level calls) but less clear.
- Accidentally duplicate the `queue.enqueue()` callback body, creating divergent result-handling.

---

## Philosophy Constraints

**Source: `/Users/etienneb/CLAUDE.md`**

- **Architectural fixes over patches** -- the guard models the invariant, not a special case
- **Make illegal states unrepresentable** -- `_preAllocatedStartResponse !== undefined` is a
  compile-time discriminator; the guard makes 'dedup fires for pre-allocated session' impossible
- **YAGNI with discipline** -- Option A is the minimal fix; no speculative abstractions
- **Document why, not what** -- the guard comment must explain the invariant, not describe the code

No conflicts between stated philosophy and repo patterns detected.

---

## Impact Surface

- `spawnSession()` in `src/trigger/trigger-listener.ts` is the only caller that sets
  `_preAllocatedStartResponse`. The fix must not change its call signature.
- `queue.enqueue()` callback body in `dispatch()` handles the full `WorkflowRunResult` union
  (success, error, timeout, stuck, delivery_failed). Both the guard path and the normal path must
  reach the same callback body -- no duplication.
- `_recentAdaptiveDispatches` -- for non-prealloc calls, cleanup-on-entry and set must still run.
- `route()` and `dispatchAdaptivePipeline()` -- no changes to either.

---

## Candidates

### Candidate A: Early-return guard before the dedup block (Option A from design doc)

**Summary:** Add `if (workflowTrigger._preAllocatedStartResponse !== undefined) { void this.queue.enqueue(...); return workflowTrigger.workflowId; }` before the scoped dedup block. The dedup block is only reached when the field is absent.

**Tensions resolved:** Dedup protection vs session liveness (fully resolved for pre-alloc path).
**Tensions accepted:** Shared state coupling remains -- the map is still shared.

**Boundary solved at:** `dispatch()` entry, before the dedup block. This is the real seam.

**Why this boundary:** The bug fires at the dedup block. The guard is placed exactly where the
divergence must happen. No other location would be more direct.

**Failure mode:** If the guard path and the normal path have separate `queue.enqueue()` callback
bodies, any future change to one body must be mirrored to the other. Mitigated by restructuring
so both paths reach the same enqueue call.

**Repo pattern:** Follows the `dispatchCondition` early-exit pattern in `route()` (lines 641-653).
Departs in that `dispatch()` previously had no such guard.

**Gains:** Minimal blast radius. Self-documenting -- the guard directly encodes the invariant.
**Loses:** Slightly more complex method structure if naively implemented with two enqueue blocks.

**Scope:** Best-fit. Single method, single guard.

**Philosophy:** Honors 'Architectural fixes', 'Make illegal states unrepresentable', 'YAGNI'.
No conflicts.

---

### Candidate B: Wrap dedup block in `if (!_preAllocatedStartResponse)` (same intent, cleaner structure)

**Summary:** Wrap the entire scoped dedup block in `if (workflowTrigger._preAllocatedStartResponse === undefined)`. Both paths then fall through to the same `void this.queue.enqueue(...)` call at the bottom of the method.

**Tensions resolved:** Same as A, plus eliminates code duplication risk.
**Tensions accepted:** Same as A.

**Boundary:** Same as A.

**Failure mode:** `_recentAdaptiveDispatches.set()` must still run for non-prealloc paths that
pass dedup. This is naturally handled by the wrap -- the set is inside the block.

**Repo pattern:** More consistent with the existing scoped-block style in `dispatch()`.

**Gains:** Single enqueue block -- no duplication risk.
**Loses:** The `_preAllocatedStartResponse` check is farther from the enqueue call than in A,
making the intent slightly less immediate.

**Scope:** Best-fit. Same scope as A.

**Philosophy:** Same as A.

---

### Candidate C: Remove dedup from `dispatch()` entirely (Option B from design doc)

**Summary:** Delete the entire dedup block from `dispatch()`. The dedup that protects against
webhook retries lives in `dispatchAdaptivePipeline()` and `route()`, both of which are the
actual entry points for external events.

**Tensions resolved:** Eliminates the shared-state coupling entirely.

**Boundary:** Too broad -- removes protection from the HTTP console route at `console-routes.ts:868`
which calls `dispatch()` directly.

**Failure mode:** Rapid-fire console dispatches could spawn duplicates if the HTTP layer does not
deduplicate. No evidence exists that this protection is currently needed, but removing it is a
behavioral change beyond the scope of this fix.

**Repo pattern:** Departs from the established shared-dedup-map pattern.

**Scope:** Too broad. The task explicitly specifies Option A.

**Philosophy:** Conflicts with 'YAGNI with discipline' -- speculative fix for an unproven gap.

---

## Comparison and Recommendation

All three candidates converge on the same fundamental fix. C is ruled out (too broad). A and B
are structurally equivalent -- the choice is whether to use an early-return guard (A) or a
wrapping if-block (B).

**Recommendation: Implement B's structure with A's intent.**

Use `if (workflowTrigger._preAllocatedStartResponse === undefined)` to wrap the dedup block,
with the `void this.queue.enqueue(...)` call appearing once after the if-block. This gives:
- No code duplication (single enqueue call)
- Clear separation: 'if non-prealloc, check dedup; then enqueue regardless'
- Consistent with the scoped-block style already in `dispatch()`

**Rationale:** The task pseudocode suggests A's early-return pattern, but B is equivalent and
avoids the duplication risk. Any reviewer familiar with the design doc will understand either shape.

---

## Self-Critique

**Strongest counter-argument:** The task pseudocode explicitly shows an early-return guard (A).
A reviewer seeing the design doc side-by-side with the implementation may expect exactly that
pattern. Diverging to a wrap (B) adds a tiny friction.

**Pivot conditions:**
- If the enqueue callback body diverges between paths in A, switch to B immediately.
- If `dispatch()` gains a third call path that also needs dedup bypass, consider Option C or
  a separate dedup map (Option C from design doc) at that point.

**Assumption that would invalidate this design:** If `_preAllocatedStartResponse` could ever be
set on a call where dedup should still fire. The JSDoc is explicit: the field is only set by
`spawnSession`/`spawn_agent` which already hold a pre-created session. This assumption is safe.

---

## Open Questions for the Main Agent

None. The problem, solution, boundary, and tests are fully specified.
