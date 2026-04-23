# Design Candidates: In-Process awaitSessions and getAgentResult

**Date:** 2026-04-19
**Task:** Replace HTTP-to-self `awaitSessions` and `getAgentResult` in `src/trigger/trigger-listener.ts` with in-process `ConsoleService` calls.

---

## Problem Understanding

### Tensions

1. **Construction order vs. dependency injection**: `coordinatorDeps` must be constructed before `TriggerRouter` (it is a constructor argument), but `ConsoleService` needs to be available inside the closure. The `routerRef` forward-reference pattern already solves a similar ordering problem -- `consoleService` can be constructed before the closure and captured by the closure.

2. **Graceful degradation vs. correctness**: If `ctx.v2.dataDir` or `ctx.v2.directoryListing` is null (the daemon-console.ts path guards against this), should `awaitSessions` degrade to returning all-failed or crash? The design doc says construct before `coordinatorDeps` -- the guard should produce a logged warning and graceful fallback since the coordinator handles `allSucceeded: false`.

3. **Session visibility race**: Sessions created in-process by `spawnSession()` may not be immediately readable via `getSessionDetail()`. This is why `SESSION_LOAD_FAILED` must be treated as "not ready yet" (retry), not as failure.

4. **Interface cleanliness vs. minimal scope**: `CoordinatorDeps.port` is a required field (`readonly port: number`) that is never read by coordinator logic (`grep deps.port` returns nothing). Removing `port: DAEMON_CONSOLE_PORT` from the trigger-listener deps object requires either (a) making `port` optional in the interface, or (b) using a `0` sentinel.

### Likely Seam

The composition root `startTriggerListener()` in `src/trigger/trigger-listener.ts` is the correct and only seam. This is where all other deps are wired, `ctx.v2.*` ports are available, and `ConsoleService` can be constructed.

### What Makes This Hard

- `CoordinatorDeps.port` is required but unused by coordinator logic. The design doc says to remove it, but the interface requires it. TypeScript will reject omitting a required field.
- The `error` terminal status mentioned in the task description does not exist in `ConsoleRunStatus` (`'in_progress' | 'complete' | 'complete_with_gaps' | 'blocked'`). The design doc is authoritative.
- The dynamic import pattern is required to avoid circular dependency (same as `daemon-console.ts:113`).

---

## Philosophy Constraints

From `/Users/etienneb/CLAUDE.md`:
- **Architectural fixes over patches** -- this fix IS the architectural fix (in-process instead of HTTP)
- **Immutability by default** -- `pending Set` mutation is minimal and contained in the polling loop
- **Errors are data** -- use `.isOk()` / `.isErr()` on `ResultAsync`, not try/catch
- **Validate at boundaries, trust inside** -- guard `ctx.v2.dataDir` at construction time
- **Document "why", not "what"** -- add WHY comments on new implementations

No philosophy conflicts with repo patterns -- `daemon-console.ts` already uses the exact same construction approach.

---

## Impact Surface

- **`AdaptiveCoordinatorDeps` interface**: No change (extends `CoordinatorDeps`, no new fields needed)
- **`CoordinatorDeps` interface** (`src/coordinators/pr-review.ts:210`): `port` is `required number` -- must be made optional if removing from trigger-listener deps
- **CLI path** (`src/cli-worktrain.ts:1549`): sets `port` in deps object for out-of-process coordinator -- remains correct either way
- **Pipeline coordinators** (`full-pipeline.ts`, `implement.ts`, `pr-review.ts`): call `awaitSessions`/`getAgentResult` by interface -- behavior change is transparent
- **`src/mcp/`**: Not touched (explicit out-of-scope)

---

## Candidates

### Candidate A: Design doc implementation with `port` made optional

**Summary**: Implement exactly per design doc. Construct `ConsoleService` locally in `startTriggerListener()`. Replace `awaitSessions` and `getAgentResult` with in-process calls. Make `readonly port: number` optional (`readonly port?: number`) in `CoordinatorDeps` to allow removing it from the trigger-listener deps object.

**Tensions resolved**: All four tensions resolved cleanly. `SESSION_LOAD_FAILED` = retry. Guard for `ctx.v2` nulls. `port` field made honest (optional, unused by logic).

**Tension accepted**: Requires touching `src/coordinators/pr-review.ts` for one-char interface change.

**Boundary**: `startTriggerListener()` composition root -- correct seam.

**Why best fit**: Fully executes design doc intent. `deps.port` confirmed unused by all coordinator logic.

**Failure mode**: None identified. `grep deps.port` confirmed zero usages in coordinator logic.

**Repo pattern**: Follows `daemon-console.ts` construction pattern exactly. Follows `spawnSession` in-process migration pattern.

**Gains**: Clean interface, no dead required field, full design doc compliance, no `0` sentinel.

**Losses**: Touches `src/coordinators/pr-review.ts` (one-char change).

**Scope judgment**: Best-fit. The scope restriction says "do not touch `src/mcp/`" not "do not touch `src/coordinators/`".

**Philosophy fit**: Honors "architectural fixes over patches", "make illegal states unrepresentable" (no sentinel), "errors are data".

---

### Candidate B: Design doc implementation, keep `port: 0` sentinel

**Summary**: Same `ConsoleService` construction and awaitSessions/getAgentResult replacement, but set `port: 0` in the trigger-listener deps object instead of making the interface field optional.

**Tensions resolved**: Removes HTTP-to-self bugs. Zero interface changes.

**Tension accepted**: Leaves dead required field with a misleading `0` value.

**Failure mode**: Future code reads `deps.port` and uses `0` as a real port, producing silent bugs.

**Repo pattern**: Departs from design doc intent ("remove the constant and port from coordinatorDeps").

**Gains**: No interface touch; purely local change.

**Losses**: Interface stays polluted with unused required field; violates design doc intent; `0` sentinel is an illegal state that can be constructed.

**Scope judgment**: Too narrow (doesn't fully execute design doc intent).

**Philosophy fit**: Conflicts with "make illegal states unrepresentable" and "architectural fixes over patches".

---

## Comparison and Recommendation

**Recommendation: Candidate A.**

`deps.port` is confirmed unused by any coordinator logic (exhaustive grep). Making it optional is a one-character change that eliminates a dead field and fully executes the design doc intent. The scope restriction is explicitly "do not touch `src/mcp/`" -- `src/coordinators/pr-review.ts` is in scope. Candidate A is the correct architectural fix.

The `0` sentinel in Candidate B is precisely the kind of "patch over architectural fix" that CLAUDE.md's philosophy warns against.

---

## Self-Critique

**Strongest argument against Candidate A**: A conservative interpretation of "only touch trigger-listener.ts" would favor the sentinel. If the reviewer intended zero interface changes, Candidate B is the safe choice.

**Pivot condition**: If touching `pr-review.ts` causes unexpected test failures (e.g., tests construct `CoordinatorDeps` with `port` required and would need to add `port: undefined`), fall back to `port: 0` sentinel or make it optional with a default. But since `port` is already unused, this risk is low.

**Assumption that would invalidate**: If some test or code path actually reads `deps.port` and would break if `0` is used or the field is absent. The grep confirms this does not exist.

---

## Open Questions for Main Agent

1. Should the guard for `ctx.v2.dataDir === undefined` cause a process.stderr warning only, or should it cause `startTriggerListener` to return an `err`? (Daemon-console.ts returns `err` -- but trigger-listener has already started by this point. Recommendation: warn + let `awaitSessions`/`getAgentResult` return degraded results.)
2. Should the `consoleService` local variable be constructed inside a try/catch or guarded more defensively? (No -- the constructor is synchronous and cannot throw given valid inputs.)
