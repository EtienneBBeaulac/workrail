# Design Review: start_workflow Latency Fixes

## Tradeoff Review

| Fix | Tradeoff | Validity | Failure Condition |
|-----|----------|----------|-------------------|
| Fix 1 | git command 1 stays sequential | Valid -- command 1 gates the rest; parallelizing would waste I/O on failure | None |
| Fix 2 | Chain restructuring for ResultAsync.combine | Valid -- stalePaths scoping preserved by closure; never error type cast is compile-time safe | TypeScript type error if resolveWorkspaceAnchors error type changes |
| Fix 3 | Skip Zod round-trip validation on cache-miss | Valid -- enrichedCompiled already passed full Phase 1a pipeline | Would fail if pinnedStore.put normalizes fields (it does not) |
| Fix 4 | Promise.allSettled preserves partial results on rejection | Valid -- unexpected throws treated as stale, same as current ENOENT behavior | None |

## Failure Mode Review

All failure modes are handled:
- Fix 1: `gitCommand` returns null on any failure; `Promise.all` resolves normally with null values
- Fix 2: never error type cast is zero-cost; TypeScript enforces correctness
- Fix 3: fallback `resolvedReferences` at line 162 handles undefined correctly whether returning enrichedCompiled directly or from store
- Fix 4: allSettled rejection handling maps to same stalePaths behavior as current code

**Highest-risk failure mode**: Fix 2 chain restructuring accidentally breaking stalePaths scoping. Must verify stalePaths is still referenced correctly in the final response assembly after restructuring.

## Runner-Up / Simpler Alternative Review

- Runner-up (sequential-but-earlier anchors) offers no elements worth borrowing -- it loses the parallelism benefit
- Simpler variant for Fix 2 (bare Promise.all with exceptions) violates the codebase's Errors-are-data principle
- No hybrid needed

## Philosophy Alignment

| Principle | Fix 1 | Fix 2 | Fix 3 | Fix 4 |
|-----------|-------|-------|-------|-------|
| Errors are data | Satisfied | Satisfied (ResultAsync.combine) | Satisfied | Satisfied (allSettled) |
| Functional over imperative | Satisfied | Satisfied | N/A | Satisfied |
| Determinism | Satisfied | Satisfied | Satisfied | Satisfied (input-order preserved) |
| YAGNI | N/A | N/A | Satisfied (removes redundant check) | N/A |

No philosophy conflicts.

## Findings

**Yellow: Fix 2 chain complexity**
The `executeStartWorkflow` function's andThen chain becomes slightly more complex with `ResultAsync.combine`. This is acceptable -- complexity is localized and the function was already composite. Monitor for stalePaths scoping correctness.

**Yellow: Fix 3 removes defensive validation**
The redundant `pinnedStore.get` after `put` was providing a round-trip Zod validation. Removing it reduces defensiveness. Acceptable because the Phase 1a pipeline already validates the shape, and the cache-hit path already skips this validation.

No Red or Orange findings.

## Recommended Revisions

None. Design is ready for implementation as specified.

## Residual Concerns

1. **Fix 2**: After implementation, manually verify that `stalePaths` is correctly referenced in the final response output (`staleRoots` field). The TypeScript compiler will not catch a stale closure reference if `stalePaths` is still in scope but refers to the wrong value.

2. **Fix 3**: If `pinnedStore` is ever changed to a store that normalizes data on write (e.g., adds timestamps, normalizes fields), Fix 3 must be reverted. Worth noting in a code comment.
