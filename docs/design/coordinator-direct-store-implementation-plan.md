# Implementation Plan: Coordinator Direct Store Access

## Problem statement

`coordinator-deps.ts` routes session polling and artifact reading through `ConsoleService`, a UI projection layer. ConsoleService is passed as a nullable parameter; when null, `awaitSessions` silently returns all sessions as failed and `getAgentResult` returns empty results. The `await_degraded` variant in `ChildSessionResult` encodes this silent misconfiguration as a result value. The coordinator has direct access to `ctx.v2.sessionStore` and `ctx.v2.snapshotStore` -- ConsoleService adds no capability, only indirection and a failure mode.

## Acceptance criteria

1. `ConsoleService` is no longer imported or used in `coordinator-deps.ts`.
2. `consoleService` field is removed from `CoordinatorDepsDependencies`.
3. `await_degraded` variant is removed from `ChildSessionResult` in `coordinators/types.ts`.
4. `awaitSessions` correctly polls `ctx.v2.sessionStore.load()` and determines completion via `ctx.v2.snapshotStore.getExecutionSnapshotV1()`.
5. `awaitSessions` retries on `SESSION_STORE_IO_ERROR` and `SESSION_STORE_LOCK_BUSY`; fails fast on `SESSION_STORE_CORRUPTION_DETECTED` and `SESSION_STORE_INVARIANT_VIOLATION`.
6. `getAgentResult` returns recap notes from `projectNodeOutputsV2` and artifacts from `projectArtifactsV2`.
7. `spawnAndAwait` calls the shared `awaitSessions` + `fetchChildSessionResult` instead of duplicating the loop.
8. `trigger-listener.ts` no longer constructs or passes a `consoleService` to `createCoordinatorDeps`.
9. All existing tests pass. New tests cover IO_ERROR retry and CORRUPTION_DETECTED fail-fast paths.

## Non-goals

- CLI coordinator path (`cli-worktrain.ts`) -- stays HTTP-based, separate problem.
- ConsoleService itself -- untouched, still used by the console UI.
- DaemonEventEmitter-based push notifications to replace polling -- separate change.
- Performance optimization of the polling loop -- out of scope.

## Philosophy-driven constraints

- *Make illegal states unrepresentable*: `consoleService === null` must not be representable after this change.
- *Errors are data*: `await_degraded` is removed; store errors surface as `failed` result with explicit message.
- *Validate at boundaries, trust inside*: error code dispatch (`IO_ERROR` retry vs `CORRUPTION_DETECTED` fail) happens at the store boundary, once.
- *Functional core, imperative shell*: pure projections (`projectRunDagV2`, `projectNodeOutputsV2`, `projectArtifactsV2`) called inline; I/O (`sessionStore.load`, `snapshotStore.getExecutionSnapshotV1`) is the explicit shell.

## Invariants

1. Completion requires `snapshotStore.getExecutionSnapshotV1(snapshotRef)` -- `engineState.kind === 'complete'` lives in the CAS snapshot, not the event log alone.
2. `SESSION_STORE_IO_ERROR` on a newly spawned session is expected (event log not yet on disk) -- must retry.
3. `SESSION_STORE_CORRUPTION_DETECTED` and `SESSION_STORE_INVARIANT_VIOLATION` are hard failures -- must fail fast, not loop until timeout.
4. snapshotRef for the tip node is derived via `asSnapshotRef(asSha256Digest(tip.snapshotRef))` -- pattern from `console-service.ts` line 597.

## Selected approach + rationale

Replace `fetchAgentResult`, `fetchChildSessionResult`, and `awaitSessions` with direct store calls:

1. **`loadSessionTruth(handle)`** private helper: `ctx.v2.sessionStore.load(asSessionId(handle))` → `LoadedSessionTruthV2`.
2. **Completion detection**: `asSortedEventLog(truth.events)` → `projectRunDagV2(sorted)` → tip node's `snapshotRef` → `ctx.v2.snapshotStore.getExecutionSnapshotV1(snapshotRef)` → check `engineState.kind === 'complete'`.
3. **`isBlocked` detection**: `projectRunStatusSignalsV2(sorted)` → `signals.byRunId[runId]?.isBlocked`.
4. **Recap notes**: `projectNodeOutputsV2(events)` → tip node's recap channel → latest entry `notesMarkdown`.
5. **Artifacts**: `projectArtifactsV2(events)` → ALL node IDs from the DAG (not just the tip) → collect `content` from each. WHY: a verdict artifact may be emitted on any step, not just the final one. Pattern mirrors ConsoleService line 142 (`nodeIdsToFetch = allNodeIds || [tipNodeId]`).
6. **Error dispatch in `awaitSessions`**: `IO_ERROR`/`LOCK_BUSY` → continue; `CORRUPTION_DETECTED`/`INVARIANT_VIOLATION` → mark failed.
7. **`spawnAndAwait`**: remove inline await loop; call `awaitSessions([handle], timeoutMs)` then `fetchChildSessionResult(handle)`.

**Runner-up:** Make ConsoleService non-nullable (hard-fail at startup). Rejected: leaves the UI abstraction dependency intact.

## Vertical slices

### Slice 1: Remove consoleService from types and call sites
**Scope:** `CoordinatorDepsDependencies` interface (`coordinator-deps.ts`), `trigger-listener.ts` call site, `coordinator-deps.ts` factory destructuring.
**Done:** `consoleService` field absent from the type; `trigger-listener.ts` no longer constructs or passes it; factory no longer destructures it.
**Verification:** `npx tsc --noEmit` passes with no type errors on these files.

### Slice 2: Replace fetchAgentResult with direct store calls
**Scope:** `fetchAgentResult` function inside `createCoordinatorDeps` (~30 lines).
**Done:** Function calls `ctx.v2.sessionStore.load()` + projections to return `{ recapMarkdown, artifacts }`. No ConsoleService reference. Recap from tip node only (`currentByChannel['recap']?.at(-1)?.payload?.notesMarkdown`). Artifacts collected from ALL node IDs in the DAG (not just tip) via `projectArtifactsV2(events).byNodeId[nodeId]?.artifacts.map(a => a.content)`.
**Verification:** Unit test for `fetchAgentResult`-equivalent: given a seeded event log with a `node_output_appended` recap and artifact, returns the correct notes and artifact content.

### Slice 3: Replace awaitSessions with direct store polling
**Scope:** `awaitSessions` method body (~55 lines). Includes error code dispatch.
**Done:** Method calls `sessionStore.load()` per handle, determines terminal status via snapshotStore, dispatches on error codes correctly.
**Verification:** Unit tests:
- `IO_ERROR` → retries
- `CORRUPTION_DETECTED` → marks failed immediately
- complete session → `outcome: 'success'`
- blocked session → `outcome: 'failed'`
- timeout → `outcome: 'timeout'`

### Slice 4: Remove await_degraded from ChildSessionResult
**Scope:** `coordinators/types.ts`, `coordinator-chaining.test.ts`.
**Done:** `await_degraded` variant removed from `ChildSessionResult` discriminated union. Tests updated.
**Verification:** `npx tsc --noEmit` passes. `coordinator-chaining.test.ts` updated and passing.

### Slice 5: Fix spawnAndAwait deduplication
**Scope:** `spawnAndAwait` method body (~80 lines with the inline loop).
**Done:** Inline `consoleService` polling loop removed; replaced with call to `awaitSessions([handle], timeoutMs)` + `fetchChildSessionResult(handle)`.
**Verification:** Existing spawnAndAwait behavior tests pass. No duplicate await logic.

## Test design

**New unit tests** in `tests/unit/coordinator-direct-store.test.ts`:

1. `awaitSessions`: `SESSION_STORE_IO_ERROR` → continues polling (retries)
2. `awaitSessions`: `SESSION_STORE_CORRUPTION_DETECTED` → returns `outcome: 'failed'` immediately
3. `awaitSessions`: complete session (tip snapshot `engineState.kind === 'complete'`) → `outcome: 'success'`
4. `awaitSessions`: blocked session (`isBlocked: true` from `projectRunStatusSignalsV2`) → `outcome: 'failed'`
5. `fetchAgentResult`: seeded recap + artifact events → correct notes and artifact returned
6. `fetchAgentResult`: empty event log → returns `{ recapMarkdown: null, artifacts: [] }`

**Updated tests** in `tests/unit/coordinator-chaining.test.ts`:
- Remove `await_degraded` test cases
- Update `fakeGetChildSessionResult` to remove `consoleServiceNull` parameter and `await_degraded` branch

**Regression:** `npx vitest run` must pass with 0 failures.

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Error code dispatch wrong (IO_ERROR vs CORRUPTION_DETECTED) | Low | High | Unit tests for each code (Slice 3) |
| snapshotRef lookup pattern wrong (asSnapshotRef/asSha256Digest) | Low | High | Mirrors console-service.ts line 597 exactly |
| asSortedEventLog fails on valid events | Low | Medium | Treat as retry (same as ConsoleService internal behavior) |
| SESSION_STORE_LOCK_BUSY causing spurious failures | Low | Medium | Treat as retry, same as IO_ERROR |

## PR packaging strategy

**SinglePR.** All five slices are in `coordinator-deps.ts` + type cleanup + tests. Atomic: the type change (`await_degraded` removal) and the implementation change must ship together to avoid intermediate states where the type exists but is never produced.

## Philosophy alignment per slice

| Slice | Principle | Status |
|---|---|---|
| 1: Remove consoleService | Make illegal states unrepresentable | Satisfied: null no longer representable |
| 2: fetchAgentResult | Functional core, imperative shell | Satisfied: projections are pure, store.load() is the shell |
| 3: awaitSessions | Validate at boundaries | Satisfied: error dispatch at the store boundary only |
| 4: Remove await_degraded | Errors are data | Satisfied: misconfiguration surfaces as startup failure not result variant |
| 5: spawnAndAwait | DRY / compose with small functions | Satisfied: deduplication removed |
