# Implementation Plan: SessionReader Split + Double-DAG Fix

## Problem statement

`coordinator-deps.ts` (699 lines) has three architecture violations:
1. **Double-DAG**: `deriveSessionStatus` calls `projectRunDagV2` directly then `projectRunStatusSignalsV2` which calls it again internally -- two full DAG projections per poll cycle.
2. **Illegal state**: `dispatch: null` private field can be used before `setDispatch()` is called.
3. **Conflation**: session-reading (store access), session-spawning (dispatch), and coordinator infrastructure (git/gh/outbox/pipeline context) bundled in one class -- violates capability-based architecture.

## Acceptance criteria

1. `SessionReader` class is exported from `coordinator-deps.ts` with injected `SessionEventLogReadonlyStorePortV2` + `SnapshotStorePortV2` -- no other deps.
2. `SessionReader.deriveSessionStatus`, `SessionReader.fetchAgentResult`, `SessionReader.awaitSessions` are public methods testable via fake stores without constructing `CoordinatorDepsImpl`.
3. `deriveSessionStatus` calls `projectRunDagV2` exactly once per invocation. `projectRunStatusSignalsV2` is not called.
4. `isBlocked` check inlined from dag + `projectGapsV2`: `tipNodeKind === 'blocked_attempt' || hasBlockingCategoryGap`, guarded by `prefs.autonomy !== FULL_AUTO_NEVER_STOP`.
5. `CoordinatorDepsImpl` takes `SessionReader` as a constructor parameter.
6. `createCoordinatorDeps` factory builds `SessionReader` from `ctx.v2` and passes it to `CoordinatorDepsImpl`.
7. `dispatch: null` confined to `spawnSessionCore` -- one null check, one typed err return.
8. All existing tests pass. New unit tests: `deriveSessionStatus` returns `blocked` for `blocked_attempt` tip node.

## Non-goals

- Changing `AdaptiveCoordinatorDeps` interface
- Changing `trigger-listener.ts` beyond construction call
- Breaking the circular dep between TriggerRouter and coordinatorDeps
- Removing `spawnAndAwait` (dead code -- separate follow-up)
- Adding a `projectRunStatusSignalsV2` overload

## Philosophy-driven constraints

- *Capability-based*: `SessionReader` gets only what it needs. `CoordinatorDepsImpl` delegates session-reading to injected `SessionReader`.
- *DI for boundaries*: Both classes take their dependencies as constructor params. Both testable with fakes.
- *Make illegal states unrepresentable*: `dispatch: null` stays (structural) but is confined to one method.
- *Compose with small pure functions*: `deriveSessionStatus` is a focused, single-responsibility method.
- *Functional core, imperative shell*: `deriveSessionStatus` is the decision function; `awaitSessions` is the polling shell.

## Invariants

1. `deriveSessionStatus` calls `projectRunDagV2` exactly once -- no call to `projectRunStatusSignalsV2`.
2. `isBlocked` inline must exactly match run-status-signals.ts lines 68-78: `prefs.autonomy !== FULL_AUTO_NEVER_STOP && (blockedByTopology || hasBlockingCategoryGap)`.
3. `SESSION_STORE_IO_ERROR` / `LOCK_BUSY` → retry. `CORRUPTION_DETECTED` / `INVARIANT_VIOLATION` → hard_fail. (unchanged)
4. `SNAPSHOT_STORE_CORRUPTION_DETECTED` / `INVARIANT_VIOLATION` → hard_fail. `IO_ERROR` → in_progress. (unchanged)
5. `SessionSource pre_allocated` prevents double `executeStartWorkflow`. (unchanged)
6. `parentSessionId` passed via `internalContext` to `executeStartWorkflow`. (unchanged)

## Selected approach

**Three-unit structure in `coordinator-deps.ts`:**

### SessionReader class
```
constructor(sessionStore: SessionEventLogReadonlyStorePortV2, snapshotStore: SnapshotStorePortV2)

public async deriveSessionStatus(handle: string): Promise<SessionStatus>
public async fetchAgentResult(handle: string): Promise<{ recapMarkdown, artifacts }>
public async fetchChildSessionResult(handle: string): Promise<ChildSessionResult>
public async awaitSessions(handles, timeoutMs): Promise<AwaitResult>
```

`deriveSessionStatus` body: `sessionStore.load` → `asSortedEventLog` → `projectRunDagV2` → (get run, tip, tip node) → `projectGapsV2` → inline `isBlocked` → `snapshotStore.getExecutionSnapshotV1` → return status.

### CoordinatorDepsImpl class
```
constructor(reader: SessionReader, execFileAsync, dispatch: null initially)

private dispatch: DispatchFn | null
private reader: SessionReader
setDispatch(fn): void
private spawnSessionCore(opts): Promise<{kind, handle|error}>

// Delegates:
getAgentResult(handle) → this.reader.fetchAgentResult(handle)
getChildSessionResult(handle) → this.reader.fetchChildSessionResult(handle) [via accessor]
awaitSessions(handles, ms) → this.reader.awaitSessions(handles, ms)
spawnSession(...) → this.spawnSessionCore(...)
spawnAndAwait(...) → this.spawnSessionCore + this.reader.awaitSessions + this.reader.fetchChildSessionResult
// All infrastructure methods stay in CoordinatorDepsImpl directly
```

### Factory
```typescript
export function createCoordinatorDeps(deps: CoordinatorDepsDependencies): CoordinatorDepsWithDispatch {
  const reader = new SessionReader(deps.ctx.v2.sessionStore, deps.ctx.v2.snapshotStore);
  return new CoordinatorDepsImpl(reader, deps.execFileAsync);
}
```

**Runner-up**: projection overload. Rejected -- wrong layer.

## Vertical slices

### S1: Extract SessionReader class
**Scope**: New `SessionReader` class in `coordinator-deps.ts`. Contains `deriveSessionStatus`, `fetchAgentResult`, `fetchChildSessionResult`, `awaitSessions`. Fixes double-DAG.
**Done**: `SessionReader` constructor takes two port interfaces. `deriveSessionStatus` calls `projectRunDagV2` exactly once. `projectRunStatusSignalsV2` import removed.
**Verification**: `npx tsc --noEmit` clean. `npx vitest run tests/unit/coordinator-direct-store.test.ts` passes.

### S2: Update CoordinatorDepsImpl to inject SessionReader
**Scope**: `CoordinatorDepsImpl` constructor takes `SessionReader`. Delegation methods (`getAgentResult`, `getChildSessionResult`, `awaitSessions`) call `this.reader.*`. `pollUntilTerminal` removed -- `spawnAndAwait` calls `this.reader.awaitSessions` directly.
**Done**: No private session-reading logic in `CoordinatorDepsImpl`. All session-reading delegated.
**Verification**: `npx tsc --noEmit` clean. All tests pass.

### S3: Update factory and add SessionReader unit tests
**Scope**: `createCoordinatorDeps` builds `SessionReader` from `ctx.v2`. New tests in `coordinator-direct-store.test.ts`: construct `SessionReader` directly with fake stores, test `blocked_attempt` → `blocked`.
**Done**: Factory builds reader from ctx.v2 ports. New test passes.
**Verification**: `npx vitest run tests/unit/coordinator-direct-store.test.ts` passes with new test.

## Test design

**Existing tests** (must all pass):
- `tests/unit/coordinator-direct-store.test.ts` (7 tests)
- `tests/unit/coordinator-chaining.test.ts` (17 tests)

**New tests in `coordinator-direct-store.test.ts`**:
1. `SessionReader.deriveSessionStatus`: blocked_attempt tip node → `{ kind: 'blocked' }`
2. `SessionReader` constructed directly (not via `createCoordinatorDeps`) with fake stores -- confirms testable in isolation

**Construct `SessionReader` directly**:
```typescript
const reader = new SessionReader(fakeSessionStore, fakeSnapshotStore);
const result = await reader.deriveSessionStatus(SESSION_ID);
```
This is the key new capability: no `ctx` needed, no `execFileAsync`, no `dispatch`.

## Risk register

| Risk | Mitigation |
|---|---|
| isBlocked inline diverges from projection | Unit test for blocked_attempt path |
| SessionReader missing a port | tsc enforces at compile time |
| dispatch:null before setDispatch | One null check in spawnSessionCore, typed err |

## PR packaging

**SinglePR**. All three slices are in one file. Type changes (SessionReader export) and test changes ship together.

## Philosophy alignment per slice

| Slice | Principle | Status |
|---|---|---|
| S1: SessionReader | Capability-based architecture | Satisfied: only two ports injected |
| S1: SessionReader | DI for boundaries | Satisfied: testable with fake stores |
| S1: SessionReader | Functional core / imperative shell | Satisfied: deriveSessionStatus is decision function |
| S2: CoordinatorDepsImpl | Compose with small functions | Satisfied: delegates session-reading entirely |
| S2: CoordinatorDepsImpl | Make illegal states unrepresentable | Tension: dispatch:null (structural) |
| S3: Factory | Single source of state truth | Satisfied: SessionReader built once, injected |
