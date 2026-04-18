# spawn_agent result handling: delivery_failed bug discovery

**Status:** Discovery complete. Recommendation: Candidate 2 (ChildWorkflowRunResult alias + assertNever).

---

## Problem Understanding

### The bug

`makeSpawnAgentTool` in `src/daemon/workflow-runner.ts` (lines 1572-1579) maps `delivery_failed` to `outcome: 'success'` when constructing the structured result returned to the parent LLM. The code's own comment acknowledges that `delivery_failed` is unreachable from `runWorkflow()` -- yet the branch maps it to success instead of error.

### Core tensions

1. **Type completeness vs. type accuracy at a boundary.** `WorkflowRunResult` includes `delivery_failed` (correct for TriggerRouter). But `runWorkflow()` itself never returns `delivery_failed` (only TriggerRouter does, post-HTTP-callback). The type is wider than the actual behavior at this call site.

2. **Exhaustiveness vs. unreachability.** TypeScript requires handling all union variants. The current `else` fallthrough achieves exhaustiveness but assigns wrong behavior to the impossible case.

3. **Soft failure vs. hard failure for impossible states.** Existing `delivery_failed not expected here` callsites in `console-routes.ts` and `trigger-router.ts` use soft handling (log + ignore). For spawn_agent, the outcome directly affects the parent LLM's next action -- soft handling (mapping to success) is a data integrity bug.

### Where the problem lives

Symptom: result-mapping block in `makeSpawnAgentTool` (`else` branch, lines 1572-1579).

Architectural seam: the return type of `runWorkflow()`. It returns `WorkflowRunResult` (4 variants) but can only produce 3 (`success | error | timeout`). The `delivery_failed` variant was added in GAP-3 when TriggerRouter gained callback support, and `runWorkflow()`'s return type was widened to match -- even though `runWorkflow()` itself doesn't produce it.

### What makes it hard

The existing comment is correct ("delivery_failed is unreachable") but the chosen handling is wrong ("return as success"). The author conflated "the workflow work is done" (true at TriggerRouter level) with "the parent should treat this as success" (wrong at spawn_agent level, where the parent LLM acts on the outcome).

---

## Philosophy Constraints

**Principles that apply:**
- **Make illegal states unrepresentable** -- `delivery_failed` is architecturally impossible at this call site; the type should reflect that
- **Exhaustiveness everywhere** -- discriminated union handling must be complete and refactor-safe
- **Errors are data** -- impossible/unexpected states must surface as errors, not be silently mapped to success
- **Type safety as the first line of defense** -- compile-time guarantee preferred over runtime defensive check
- **Document "why", not "what"** -- the fix must update the WHY comment to accurately reflect the invariant

**Philosophy conflict:**
- CLAUDE.md says "exhaustiveness everywhere" but `console-routes.ts` and `trigger-router.ts` both use soft `delivery_failed not expected here` handling without assertNever. This is a gap between stated and practiced philosophy. Resolution: spawn_agent's user-visible consequence warrants the stricter approach; leave the other two callsites unchanged and document the intentional difference.

---

## Impact Surface

- `src/daemon/workflow-runner.ts` -- primary change site (makeSpawnAgentTool result mapping + new ChildWorkflowRunResult type alias)
- `src/trigger/trigger-router.ts` -- assigns `runWorkflow()` result to `WorkflowRunResult`; unaffected (still uses full union)
- `src/v2/usecases/console-routes.ts` -- same; unaffected
- `tests/unit/workflow-runner-*.test.ts` -- no changes needed to existing tests
- New: `tests/unit/workflow-runner-spawn-agent.test.ts` -- new test file for makeSpawnAgentTool result mapping

---

## Candidates

### Candidate 1: Minimal patch (one-line fix)

**Summary:** Change `outcome: 'success'` to `outcome: 'error'` in the `delivery_failed` else branch, update the comment.

**Tensions resolved:** errors-are-data (delivery_failed no longer maps to success).
**Tensions accepted:** type lie stays; no compile-time guard; implicit else fallthrough.
**Boundary:** runtime-only fix at the result-mapping block.
**Failure mode:** if WorkflowRunResult gains a 5th variant, the else silently maps it to error with a confusing `deliveryError` message (TypeScript won't warn).
**Repo pattern:** follows the soft-handling pattern from console-routes.ts and trigger-router.ts.
**Gains:** zero blast radius; one line.
**Loses:** compile-time exhaustiveness; type lie persists.
**Scope:** too narrow -- leaves the architectural debt in place.
**Philosophy:** honors "errors are data"; conflicts with "make illegal states unrepresentable" and "exhaustiveness everywhere."

---

### Candidate 2: ChildWorkflowRunResult alias + assertNever (recommended)

**Summary:** Add `export type ChildWorkflowRunResult = WorkflowRunSuccess | WorkflowRunError | WorkflowRunTimeout`, cast `childResult` to it after the `runWorkflowFn` call, replace the `else` with `assertNever(childResult)`.

**Concrete shape:**
```typescript
// Near WorkflowRunResult in workflow-runner.ts:
export type ChildWorkflowRunResult = WorkflowRunSuccess | WorkflowRunError | WorkflowRunTimeout;
// WHY: runWorkflow() never produces delivery_failed. That variant is only created by TriggerRouter
// after an HTTP callbackUrl POST fails. Child sessions spawned by spawn_agent bypass TriggerRouter
// and have no callbackUrl. This type makes the architectural invariant unrepresentable at compile time.

// In makeSpawnAgentTool execute():
const childResult = await runWorkflowFn(...) as ChildWorkflowRunResult;
// WHY cast: runWorkflow() returns WorkflowRunResult for TriggerRouter compatibility, but
// structurally only produces success/error/timeout. The cast documents this invariant;
// assertNever below catches any future violation at compile time.

if (childResult._tag === 'success') { ... }
else if (childResult._tag === 'error') { ... }
else if (childResult._tag === 'timeout') { ... }
else { assertNever(childResult); } // unreachable; compiler verifies exhaustiveness
```

**Tensions resolved:** exhaustiveness (assertNever catches new variants at compile time); illegal state unrepresentable (ChildWorkflowRunResult excludes delivery_failed); errors-are-data (impossible state throws, not maps to success).
**Tensions accepted:** the cast is a runtime assertion TypeScript can't statically verify on runWorkflow()'s body.
**Boundary:** type-system boundary at the call site in makeSpawnAgentTool.
**Failure mode:** if runWorkflow() is modified to produce delivery_failed, the assertNever throws at runtime instead of being caught at compile time on the function body. But the throw is loud and clear.
**Repo pattern:** adapts the repo's discriminated union + explicit tag-matching style; assertNever is idiomatic TypeScript; departs from the soft-handling pattern in console-routes/trigger-router (justified by user-visible consequence).
**Gains:** compile-time exhaustiveness over the 3 real variants; architectural invariant expressed in type system; future WorkflowRunResult additions caught by compiler.
**Loses:** one additional exported type alias; the cast is a soft assertion.
**Scope:** best-fit.
**Philosophy:** honors "make illegal states unrepresentable," "exhaustiveness everywhere," "errors are data," "type safety as the first line of defense," "document why."

---

### Candidate 3: Narrow runWorkflow()'s return type

**Summary:** Change `runWorkflow()`'s declared return type to `Promise<WorkflowRunSuccess | WorkflowRunError | WorkflowRunTimeout>`, introduce a `TriggerWorkflowRunResult = WorkflowRunResult` alias for TriggerRouter.

**Tensions resolved:** type lie eliminated at source; TypeScript statically verifies runWorkflow() cannot produce delivery_failed; no cast needed.
**Tensions accepted:** requires TriggerRouter to re-widen locally; higher blast radius.
**Boundary:** runWorkflow()'s public signature.
**Failure mode:** TriggerRouter assigns `let result: WorkflowRunResult = await runWorkflowFn(...)` then reassigns to delivery_failed later -- this still works since delivery_failed is assigned after runWorkflow() returns, not returned by it. Actually safe.
**Repo pattern:** departure -- WorkflowRunResult is the universal type across all callers.
**Gains:** strongest compile-time guarantee; type fully reflects runtime behavior.
**Loses:** higher blast radius; potential for unaudited callsite breakage.
**Scope:** too broad for this bug fix.
**Philosophy:** most strongly honors "make illegal states unrepresentable"; conflicts with YAGNI for this scope.

---

## Comparison and Recommendation

| Tension | C1 (patch) | C2 (alias+assertNever) | C3 (narrow runWorkflow) |
|---|---|---|---|
| delivery_failed -> error (not success) | Resolved | Resolved | Resolved |
| Compile-time exhaustiveness | Not resolved | Resolved | Resolved |
| Illegal state unrepresentable | Not resolved | Partially (cast) | Fully resolved |
| Blast radius | Zero | Minimal | Medium |
| Future-variant safety | Weak | Strong | Strongest |
| Consistency with existing patterns | High | Medium | Low |

**Recommendation: Candidate 2.**

Candidate 2 resolves the core tension at the right boundary: it makes the architectural invariant (delivery_failed is impossible at this call site) explicit in the type system, adds compile-time exhaustiveness over the 3 real variants, and fixes the wrong outcome mapping -- all without touching runWorkflow()'s public signature or any other caller.

---

## Self-Critique

**Strongest argument against Candidate 2:** The cast `as ChildWorkflowRunResult` is a developer pinky-promise. If runWorkflow() is modified to produce delivery_failed, the compiler won't catch it at the assignment site -- only at the assertNever branch at runtime. Candidate 3 would catch it at compile time.

**Why Candidate 1 loses:** Fixes the behavior without fixing the design. The type lie persists. If WorkflowRunResult gains a 5th variant, the else silently maps it to error with a message about `deliveryError` that may not exist on the new variant -- TypeScript wouldn't warn. This replicates the same structural weakness.

**What would justify Candidate 3:** Evidence that other direct callers of runWorkflow() (bypassing TriggerRouter) have the same unreachable delivery_failed problem, or that runWorkflow() is being given a callbackUrl parameter in a near-future PR.

**Assumption that would invalidate Candidate 2:** If runWorkflow() itself gains direct callbackUrl support and starts producing delivery_failed, the ChildWorkflowRunResult alias becomes stale. The WHY comment makes this assumption immediately visible during that future PR's review.

---

## Open Questions for Main Agent

1. Is there an existing `assertNever` utility in the codebase, or does it need to be added? (Check `src/utils/` or similar.)
2. Should `ChildWorkflowRunResult` be exported (for test use) or kept module-private? Recommendation: export it -- tests need to construct values of this type.
3. The tool description string on line 1434-1436 already lists `"success"|"error"|"timeout"` as the outcome values -- this matches the fix. No change needed there.
4. Confirm the test file naming convention: existing files are `workflow-runner-{feature}.test.ts`. New file should be `workflow-runner-spawn-agent.test.ts`.
