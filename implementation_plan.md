# Implementation Plan: LocalSessionLockV2 workerId Fix

## 1. Problem Statement

`LocalSessionLockV2` uses `process.kill(pid, 0)` to detect stale locks. When two callers share a PID (same process), a crashed daemon permanently locks sessions because the PID check always returns "process alive." Adding a `workerId` discriminant allows per-worker identity tracking so a crashed daemon's stale lock is correctly identified and cleared, while a live different-worker lock in the same process is correctly preserved.

## 2. Acceptance Criteria

- `npm run typecheck` exits clean (0 errors).
- `npx vitest run tests/unit/v2/session-lock-stale.test.ts` passes all existing 7 tests + 1 new test.
- All existing tests pass without modification (default `workerId` param = backward compat).
- New test: same-PID + different-workerId lock is NOT cleared (returns `SESSION_LOCK_BUSY`).
- Lock file written by `acquire()` includes `workerId` field in the JSON.
- DI container wires `'mcp-server'` as the workerId for the MCP server instance.
- Zero behavior change when workerId is `'default'` (backward compat default).

## 3. Non-Goals

- No changes to `SessionLockPortV2` port interface.
- No changes to `InMemorySessionLock` fake.
- No refactoring of surrounding code.
- No new DI token for workerId.
- No changes to `FakeTimeClockV2`.
- Do not add a daemon instance - the fix is wiring infrastructure for when the daemon is built.

## 4. Philosophy-Driven Constraints

From `CLAUDE.md` (`/Users/etienneb/CLAUDE.md`):
- **Errors as values**: `SESSION_LOCK_BUSY` must remain a Result err value, not a thrown exception.
- **Immutability by default**: `workerId` must be `private readonly` in constructor.
- **Constructor injection**: workerId injected at construction, not accessed from globals.
- **YAGNI**: String literal `'mcp-server'` in factory, no DI token.
- **Document 'why' not 'what'**: JSDoc must explain the self-eviction intent for restart recovery.

## 5. Invariants

1. Same PID + same workerId: own lock, treat as stale (self-evict for restart recovery).
2. Same PID + different workerId: NOT stale, return SESSION_LOCK_BUSY.
3. Different PID, process dead (ESRCH): stale, clear it.
4. Different PID, process alive: SESSION_LOCK_BUSY.
5. No workerId in file (old format): fall back to PID-only logic (backward compat).
6. `clearIfStaleLock` must remain `ResultAsync<void, never>` - never fails.
7. Default `workerId = 'default'` must produce identical behavior to current implementation.

## 6. Selected Approach

**Candidate 1: Inline 5-case branching in `clearIfStaleLock`.**

Add `workerId: string = 'default'` as 4th constructor param to `LocalSessionLockV2`. In `clearIfStaleLock`'s `.map()` lambda, parse both `pid` and `workerId` from lock file JSON using a local `LockFileData` interface, implement 5-case decision as inline `if/else` with comments naming each case. Write `workerId` to lock file JSON in `acquire`. Wire `'mcp-server'` in `container.ts`.

**Runner-up:** Extract `decideStaleness()` pure function. Lost to YAGNI - task says surgical; the inline 20-line branch with named comments achieves equivalent readability.

**Rationale:** Purely additive, no interface changes, backward compat via optional default param. All 3 tensions resolved: same-PID discrimination, backward compat, per-instance constructor injection.

## 7. Vertical Slices

### Slice 1: Update `LocalSessionLockV2`

**File:** `src/v2/infra/local/session-lock/index.ts`

**Changes:**
- Add `workerId: string = 'default'` as 4th constructor param (private readonly)
- Add local `interface LockFileData { pid?: unknown; workerId?: unknown }` inside `clearIfStaleLock`
- Update JSON parse cast from `{ pid?: unknown }` to `LockFileData`
- Implement 5-case staleness logic in `.map()` lambda with inline comments
- Update `acquire()` to include `workerId: this.workerId` in the lock file JSON
- Add JSDoc to `clearIfStaleLock` documenting all 5 cases

**Acceptance:** TypeScript compiles clean. `clearIfStaleLock` returns `ResultAsync<void, never>` unchanged.

### Slice 2: Update DI container

**File:** `src/di/container.ts`

**Changes:**
- Line 404: `return new LocalSessionLockV2(dataDir, fs, clock, 'mcp-server')`

**Acceptance:** TypeScript compiles clean. Factory call includes 4th argument.

### Slice 3: Add new test

**File:** `tests/unit/v2/session-lock-stale.test.ts`

**Changes:**
- Add test: "does NOT clear a live lock from a different worker in the same process"
- Setup: `FakeTimeClockV2.setPid()` to match lock file PID, create lock file with same PID but different workerId
- Assertion: `acquireExpectBusy(lock)`

**Acceptance:** All 8 tests pass (7 existing + 1 new).

## 8. Test Design

### Existing tests (7) - must pass unchanged

All use `new LocalSessionLockV2(fakeDataDir, fs, clock)` (no 4th arg). Default workerId = `'default'`. All pass without modification.

### New test

```
it('does NOT clear a lock from a different worker sharing the same PID', async () => {
  const fs = new InMemoryFileSystem();
  const clock = new FakeTimeClockV2();
  // Create lock instance for workerId 'mcp-server'
  const lock = new LocalSessionLockV2(fakeDataDir, fs, clock, 'mcp-server');

  const sharedPid = clock.getPid(); // 12345 (same as what clock.getPid() returns)
  vi.spyOn(process, 'kill').mockReturnValue(true); // process is alive

  // Plant a lock file with the SAME PID but a DIFFERENT workerId ('daemon')
  await fs.mkdirp(SESSION_DIR);
  await fs.writeFileBytes(
    LOCK_PATH,
    new TextEncoder().encode(
      JSON.stringify({ v: 1, sessionId: SESSION_ID, pid: sharedPid, workerId: 'daemon', startedAtMs: Date.now() })
    )
  );

  // Acquire should fail -- different worker holds this lock, even though PID matches
  await acquireExpectBusy(lock);
});
```

Note: `FakeTimeClockV2.getPid()` returns `12345` by default. The test plants a lock file with `pid: 12345` (same PID) but `workerId: 'daemon'` (different worker). The `LocalSessionLockV2` instance has workerId `'mcp-server'`. The lock should be treated as BUSY.

## 9. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Double-acquire self-eviction | Low | Medium | Documented in JSDoc; ExecutionSessionGateV2 prevents it at higher level |
| PID reuse + different workerId = stale treated as BUSY | Very low | Low | Conservative behavior (BUSY is safe); inherent PID-reuse limitation |
| Existing tests break due to default param | None | N/A | 4th param has default value; all existing constructor calls remain valid |

## 10. PR Packaging Strategy

**Single PR** on a new branch (e.g., `feat/session-lock-worker-id`). Commit on the branch, do NOT push to main.

Commit message format (per CLAUDE.md): `feat(mcp): add workerId discriminant to session lock for same-process isolation`

## 11. Philosophy Alignment Per Slice

### Slice 1: `LocalSessionLockV2`
- Errors as values -> Satisfied: SESSION_LOCK_BUSY stays Result err, clearIfStaleLock stays ResultAsync<void, never>
- Immutability by default -> Satisfied: workerId is private readonly
- Constructor injection -> Satisfied: workerId injected at construction
- Document why not what -> Satisfied: JSDoc documents self-eviction intent
- Make illegal states unrepresentable -> Minor tension: local LockFileData interface mitigates runtime parse looseness

### Slice 2: `container.ts`
- YAGNI -> Satisfied: string literal, no new DI token
- Constructor injection -> Satisfied: follows existing factory pattern

### Slice 3: Tests
- Prefer fakes over mocks -> Satisfied: InMemoryFileSystem + FakeTimeClockV2 used; only process.kill is mocked (no alternative)
- Determinism -> Satisfied: FakeTimeClockV2 provides fixed pid=12345

---

**implementationPlan:** Complete. 3 files, ~55 lines total.
**slices:** 3 (lock impl, DI wiring, new test)
**testDesign:** 7 existing tests pass unchanged; 1 new test for same-PID+different-workerId
**estimatedPRCount:** 1
**followUpTickets:** None
**unresolvedUnknownCount:** 0
**planConfidenceBand:** High
