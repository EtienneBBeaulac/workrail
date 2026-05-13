# Design Review: SessionReader Split + Double-DAG Fix

## Tradeoff Review

**T1: dispatch:null confined to spawnSessionCore**
Structural constraint -- coordinatorDeps must exist before TriggerRouter but dispatch only after. Acceptable: one null check in one method, returns typed err. Will not spread.

**T2: isBlocked inlined from dag + projectGapsV2**
3-line duplication of logic from `run-status-signals.ts:68-78`. Acceptable because: (a) coordinator sessions always use `guided` autonomy (defaultPreferences), so FULL_AUTO_NEVER_STOP edge case is immaterial in practice; (b) adding a projection overload for a coordinator concern is the wrong layer; (c) comment with source reference makes it traceable.

**T3: SessionReader takes two store ports, not V2ToolContext**
Correct capability-based design. tsc enforces completeness. No hidden assumption.

---

## Failure Mode Review

**FM1 (low): isBlocked inline diverges from projection**
Mitigated by comment referencing source. Risk is low -- coordinator autonomy mode verified as always `guided`.

**FM2 (none): SessionReader missing a needed port**
Non-issue -- A1/A2 verified: only sessionStore + snapshotStore needed. tsc catches at compile time.

**FM3 (low): dispatch:null before setDispatch**
Confined, returns typed err. Not eliminated but explicit.

---

## Runner-Up / Simpler Alternative

**Runner-up**: Add projection overload to `projectRunStatusSignalsV2` accepting pre-built DAG. Rejected -- projection layer is not the right place for a coordinator-specific optimization.

**Simpler**: Fix only double-DAG, leave conflation. Rejected -- doesn't satisfy the explicit goal of capability-based splitting and SessionReader testability.

---

## Philosophy Alignment

**Satisfied**: capability-based architecture, DI for boundaries, compose with small functions, functional core/imperative shell, keep interfaces small.

**Acceptable tensions**: dispatch:null (structural), isBlocked inline (3-line, documented).

**No violations.**

---

## Findings

**Yellow: isBlocked inline is undiscoverable**
The 3-line inline of `isBlocked` logic has no test that proves it matches `projectRunStatusSignalsV2`. If the projection logic evolves (e.g. a new gap category added to `hasBlockingCategoryGap`), the inline silently diverges. A unit test asserting that `deriveSessionStatus` returns `blocked` for a `blocked_attempt` tip node would catch regression.

---

## Recommended Revisions

1. Add a unit test: `deriveSessionStatus` returns `{ kind: 'blocked' }` when the tip node is `blocked_attempt`. This directly exercises the inlined isBlocked path.

---

## Residual Concerns

- The `FULL_AUTO_NEVER_STOP` autonomy check in the inline is technically dead code for coordinator sessions. Document this explicitly so a future reader doesn't remove it thinking it's unnecessary.
- `spawnAndAwait` is dead code (no production callers). Consider removing it in a follow-up to eliminate `pollUntilTerminal` entirely. Not in scope here.
