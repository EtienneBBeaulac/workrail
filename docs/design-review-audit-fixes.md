<!-- design-review-audit-fixes.md -->
<!-- Design review for managed sources & workflow references audit fixes -->

# Design Review: Audit Fixes

## Tradeoff Review

| Tradeoff | Verdict | Condition That Breaks It |
|---|---|---|
| F9 fake churn (5 update points) | Acceptable -- TypeScript catches all missed updates at compile time | More fakes found outside `tests/` |
| F6 five-file diff | Acceptable -- runtime-equivalent change | Zod schema TYPE identity used for serialization (not the case here) |
| F9 fire-and-forget prune | Acceptable -- no user-visible impact | Prune deletes active snapshots (mitigated by no-op stub) |
| F2 null fallback for timeout | Acceptable -- explicit null-check handles the branch | Incorrect null-check allows null to propagate |
| F3 warnings field addition | Acceptable -- fully additive, no downstream breakage | Strict exact-match consumers (none found) |

## Failure Mode Review

| Failure Mode | Coverage | Risk Level |
|---|---|---|
| F2: timeout propagates as hard error | Handled via `.catch(() => null)` before `RA.fromPromise` | Medium -- requires correct implementation |
| F4: `allSettled` rejected entries | Not possible -- `isDirectory` never rejects | None |
| F9: prune deletes active snapshot | Mitigated by no-op `prune()` stub | Eliminated by design decision |
| F1: stat timeout treats all sources as stale | Acceptable -- degrade gracefully, next call hits cache | Low |
| F5: `assertNever` throws at runtime | Correct behavior -- surfaces missing case immediately | Low (intentional) |

## Runner-Up / Simpler Alternative Review

- Candidate B (resurrect dead module) has no elements worth borrowing -- the abstraction mismatch at `enrichPinnedSnapshotWithResolvedReferences` is fundamental.
- Simpler variants for F1/F4 (sequential loop + withTimeout) and F6 (comment-only) don't satisfy the findings. Rejected.
- F9 simplification: no-op `prune()` stub is the right simplification -- satisfies port contract without risking deletion.

## Philosophy Alignment

All CLAUDE.md principles satisfied. Three tensions noted:

1. **Errors-are-data vs. fire-and-forget** (F9 prune): Acceptable -- not on critical path, no user impact.
2. **Type safety vs. runtime null fallback** (F2): Acceptable -- explicit, deliberate, with null-check guard.
3. **Architectural fix vs. comment patch** (F7): Acceptable -- finding explicitly permits comment approach for Minor severity.

## Findings

### Yellow: F2 implementation shape needs precision

The `Promise.race([resolveWorkflowReferences(...), timeoutReject]).catch(() => null)` shape is correct but requires precision in the TypeScript type handling. The null must be checked before processing `result.resolved`/`result.warnings`. Recommend:

```typescript
const resolutionResultOrNull = await withTimeout(
  resolveWorkflowReferences(references, workspacePath),
  REFERENCE_RESOLUTION_TIMEOUT_MS,
  'reference_resolution',
).catch(() => null);

const result = resolutionResultOrNull ?? { resolved: allUnresolved, warnings: [] };
```

This is cleaner than a `Promise.race` with `RA.fromPromise`.

### Yellow: F9 prune() no-op return value

`prune()` should return `ResultAsync<number, PinnedWorkflowStoreError>` where `number` is the count of pruned entries. A no-op returns `okAsync(0)`. This is correctly typed and satisfies the port contract.

### Yellow: F9 prune() threshold for future implementation

When `prune()` is eventually implemented with real deletion logic, the threshold should be a parameter, not a hardcoded constant. The port signature `prune(olderThanMs: number)` already parameterizes it correctly -- the caller in `startAsyncServices()` passes the threshold value. This is already correct in the design.

## Recommended Revisions

1. **Use `.catch(() => null)` pattern (not `Promise.race`)** for F2 -- cleaner TypeScript, same semantics.
2. **F9 prune() returns `ResultAsync<number, PinnedWorkflowStoreError>`** -- the `number` is pruned count, `0` from no-op.
3. **Name the timeout constant** in `start.ts`: `REFERENCE_RESOLUTION_TIMEOUT_MS = 5_000` (consistent with `DISCOVERY_TIMEOUT_MS` naming in `request-workflow-reader.ts`).
4. **F3 `warnings` Zod description**: match the description style used in `V2WorkflowListOutputSchema` for consistency.

## Residual Concerns

- F9 real deletion: the no-op defers the GC policy decision. A follow-up ticket should specify the threshold and implement actual file deletion with a safe-deletion check (verify no session file references the snapshot before deleting).
- F10 comment: the existing `clearWalkCacheForTesting()` export already has a comment. The improvement is minor -- just strengthen the wording to explicitly mention the test-isolation risk.
