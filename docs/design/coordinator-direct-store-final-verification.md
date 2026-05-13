# Final Verification: Coordinator Direct Store Access

## Readiness Claims and Proof Matrix

| AC | Claim | Evidence | Strength | Gap |
|---|---|---|---|---|
| 1 | ConsoleService not imported/used in coordinator-deps.ts | grep clean; import removed | Strong | — |
| 2 | `consoleService` field removed from `CoordinatorDepsDependencies` | tsc clean; grep confirms | Strong | — |
| 3 | `await_degraded` removed from `ChildSessionResult` | types.ts updated; 17 coordinator-chaining tests pass | Strong | — |
| 4 | `awaitSessions` polls sessionStore + snapshotStore for completion | Code review of `deriveSessionStatus` | Partial | No dedicated unit test for new polling path |
| 5 | IO_ERROR/LOCK_BUSY retry; CORRUPTION/INVARIANT fail-fast | Code review of `deriveSessionStatus` error dispatch | Partial | No unit test for error code paths |
| 6 | `getAgentResult` reads from projectNodeOutputsV2 + projectArtifactsV2 (all nodes) | Code review of `fetchAgentResult` | Partial | No unit test for new fetchAgentResult path |
| 7 | `spawnAndAwait` uses pollUntilTerminal, no inline ConsoleService loop | grep clean; code review | Strong | — |
| 8 | trigger-listener no longer constructs/passes consoleService | grep clean; tsc clean | Strong | — |
| 9 | All existing tests pass | 393/393 | Strong | — |

## Validation Evidence Summary

- `npx tsc --noEmit`: zero type errors
- `npx vitest run`: 393/393 (one timing flap on perf test; second run clean)
- Manual grep: no live `consoleService` or `await_degraded` references in coordinator-deps.ts or trigger-listener.ts
- pr-review.ts doc comment updated to remove stale ConsoleService references

## Severity-Classified Gaps

### Red (blocking)
None.

### Orange (should fix before shipping)
**Missing unit tests for ACs 4-6.** `coordinator-direct-store.test.ts` is specified in the implementation plan but not yet written. The planned tests cover:
- `awaitSessions`: `SESSION_STORE_IO_ERROR` → retries
- `awaitSessions`: `SESSION_STORE_CORRUPTION_DETECTED` → fails fast
- Complete session (tip snapshot `engineState.kind === 'complete'`) → `outcome: 'success'`
- Blocked session (`isBlocked: true`) → `outcome: 'failed'`
- `fetchAgentResult`: seeded recap + artifact events → correct notes/artifacts returned
- `fetchAgentResult`: empty event log → returns `{ recapMarkdown: null, artifacts: [] }`

A wrong error dispatch would not be caught by any existing test. Write these before shipping.

### Yellow (accepted tension / follow-up)
- `POLL_INTERVAL_MS` (3000ms) duplicated between `awaitSessions` and `pollUntilTerminal`. Minimal; extract as constant in follow-up.
- `pollUntilTerminal` is a new named function not literally in the plan -- necessary because factory object literals don't have typed `this`. 10 lines, delegates to `deriveSessionStatus`. Not real drift.

## Regression / Drift Review

No regressions. All 5 slices stayed within planned scope. No unexpected scope changes. `pollUntilTerminal` was a minimal adaptation to a TypeScript language constraint (factory object literal `this` is implicitly `any`), not a design change.

## Philosophy Alignment

**Satisfied:** make-illegal-states-unrepresentable, errors-are-data, functional-core-imperative-shell, single-source-of-state-truth, validate-at-boundaries.

**Accepted tensions:** `pollUntilTerminal` is not fully pure (polls with timeout); `POLL_INTERVAL_MS` duplicated.

**No violations.**

## Recommended Fixes

1. Write `tests/unit/coordinator-direct-store.test.ts` (6 tests, all specified in the implementation plan). This converts ACs 4-6 from "partial" to "strong" proof. Required before shipping.

## Readiness Verdict

**Not Ready** -- Orange gap (missing unit tests for new polling and fetchAgentResult paths) must be addressed before shipping. Implementation is correct per code review and tsc; tests are the remaining deliverable.
