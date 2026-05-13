# Final Verification: SessionReader Split + Double-DAG Fix

## Readiness Claims and Proof Matrix

| AC | Claim | Evidence | Strength | Gap |
|---|---|---|---|---|
| 1 | `SessionReader` exported with two port params | export class + tsc clean | Strong | — |
| 2 | Session-reading testable via fake stores without V2ToolContext | 3 direct `new SessionReader(fakeStore, fakeSnap)` tests pass | Strong | — |
| 3 | `deriveSessionStatus` calls `projectRunDagV2` exactly once | `projectRunStatusSignalsV2` import removed; grep confirms | Strong | — |
| 4 | `isBlocked` inline matches run-status-signals.ts:68-78 | `blocked_attempt` → `blocked` test; code review against source | Strong | — |
| 5 | `CoordinatorDepsImpl` injects `SessionReader` | tsc + code review | Strong | — |
| 6 | Factory builds `SessionReader` from `ctx.v2` | Code + integration via createCoordinatorDeps tests | Strong | — |
| 7 | `dispatch:null` confined to `spawnSessionCore` | Code review -- one null check, one typed err return | Strong | — |
| 8 | 394/394 tests pass | `npx vitest run` output | Strong | — |

## Validation Evidence Summary

- `npx tsc --noEmit`: zero errors
- `npx vitest run`: 394/394 (6110 passing, 5 skipped)
- 3 new direct `SessionReader` tests prove isolation
- `blocked_attempt` test proves isBlocked inline path
- `projectRunStatusSignalsV2` import confirmed removed

## Severity-Classified Gaps

### Red
None.

### Orange
None.

### Yellow
- `dispatch:null` still exists -- structural circular dep constraint, confined to `spawnSessionCore`
- `ctx.v2 ? createCoordinatorDeps : null` guard in trigger-listener -- honest boundary validation
- `spawnAndAwait` is dead code (no production callers) -- filed as follow-up

## Regression / Drift Review

No regressions. `trigger-listener.ts` touched for the `ctx.v2` null guard -- confirmed harmless, minimum necessary to handle test contexts with null v2.

## Philosophy Alignment

**Satisfied:** capability-based architecture, DI for boundaries, compose with small functions, functional core/imperative shell, keep interfaces small, illegal states improved.

**Accepted tensions:** dispatch:null (structural), ctx.v2 guard (correct composition root validation).

**No violations.**

## Recommended Fixes

None. All issues are Yellow (accepted tensions or filed follow-ups).

## Readiness Verdict

**Ready with Accepted Tensions.**

dispatch:null is a structural constraint that cannot be eliminated without breaking the circular dep between TriggerRouter and coordinatorDeps. It is confined to one method and explicitly documented.
