# Design Review: Coordinator Direct Store Access

Replace ConsoleService with direct `ctx.v2.sessionStore` + `ctx.v2.snapshotStore` calls in `coordinator-deps.ts` (in-process daemon path).

---

## Tradeoff Review

**T1: Polling loop retained (3s interval)**
Acceptable. DaemonEventEmitter fires `session_completed` in-process, but wiring it to the coordinator is a larger refactor. Polling is correct and bounded by per-phase timeout caps (25–65 min). Would become problematic only if timeouts were very short or sessions had very large event logs.

**T2: SESSION_STORE_IO_ERROR treated as retry**
Requires refinement: only `SESSION_STORE_IO_ERROR` and `SESSION_STORE_LOCK_BUSY` should retry. `SESSION_STORE_CORRUPTION_DETECTED` and `SESSION_STORE_INVARIANT_VIOLATION` must fail fast -- marking the session as failed rather than looping until timeout.

**T3: Loss of ConsoleService terminal-state cache**
Benign. Cache only benefits repeated polls of the same terminal session. Coordinator removes sessions from `pending` on first terminal status -- no repeated terminal polls occur in practice.

---

## Failure Mode Review

**FM1: Corrupt session loops until timeout**
Mitigated by T2 refinement -- `CORRUPTION_DETECTED` and `INVARIANT_VIOLATION` fail fast.

**FM2: snapshotStore returns null for valid tip node**
Handled: treat as not-yet-complete, continue polling. Mirrors ConsoleService `orElse(() => false)` graceful degradation.

**FM3: asSortedEventLog returns err (events out of order)**
Handled: treat as retry. Same behavior ConsoleService had internally.

---

## Runner-Up / Simpler Alternative

**Runner-up:** Make ConsoleService non-nullable (hard-fail at startup). ~20 lines of change. Eliminates `await_degraded` and null guard.

Rejected: doesn't address the root issue. Coordinator still routes through a UI projection abstraction. The user explicitly asked "what doesn't actually need the console?" -- leaving ConsoleService in place doesn't answer that.

**Hybrid:** One element from the runner-up is worth keeping -- the startup-assertion pattern. Already satisfied by TypeScript: `sessionStore` and `snapshotStore` are required fields on `V2Dependencies`.

---

## Philosophy Alignment

**Clearly satisfied:**
- *Make illegal states unrepresentable* -- `consoleService === null` removed
- *Errors are data* -- `await_degraded` encoded misconfiguration as a result value; removed
- *Functional core, imperative shell* -- pure projections at center, `sessionStore.load()` is the explicit I/O shell
- *Single source of state truth* -- event log is authoritative; ConsoleService was a redundant derived layer
- *Capability-based architecture* -- coordinator gets what it needs, not what the UI needs
- *YAGNI with discipline* -- no new abstractions

**Under tension (acceptable):**
- *Compose with small pure functions* -- completion check inline rather than extracted; acceptable for 50-line scope
- *Validate at boundaries* -- retry/fail-fast logic in the polling loop; acceptable, that loop is the boundary

---

## Findings

**Orange: T2 retry/fail-fast split must be tested**
`SESSION_STORE_IO_ERROR` (retry) vs. `CORRUPTION_DETECTED`/`INVARIANT_VIOLATION` (fail fast) is new behavior relative to the old path. Getting it wrong causes either: (a) corrupt sessions hang until timeout, or (b) just-spawned sessions fail immediately before their event log appears on disk. Both are functional regressions. Must be covered by unit tests.

**Yellow: Polling performance**
Direct `sessionStore.load()` reads and parses the full JSONL event log from disk every 3s. For sessions with many events this is more expensive than ConsoleService (which had a cache). Acceptable for now; if it becomes a bottleneck, a local terminal-state cache can be added.

---

## Recommended Revisions

1. In `awaitSessions` error handling, distinguish error codes explicitly:
   - `SESSION_STORE_IO_ERROR`, `SESSION_STORE_LOCK_BUSY` → continue (retry)
   - `SESSION_STORE_CORRUPTION_DETECTED`, `SESSION_STORE_INVARIANT_VIOLATION` → mark failed, remove from pending

2. Add unit tests covering:
   - `awaitSessions` with IO_ERROR → retries
   - `awaitSessions` with CORRUPTION_DETECTED → fails fast
   - `fetchAgentResult` with complete session → returns recap + artifacts
   - `fetchAgentResult` with in-progress session (tip snapshot not `complete`) → returns empty

---

## Residual Concerns

- No cross-session locking: `sessionStore.load()` outside the engine's lock mechanism. Safe for reads (the store is append-only and reads are non-destructive), but worth noting that two concurrent polls could both read the same event log at slightly different offsets during an active session. Not a correctness issue -- the polling loop just gets an "in-progress" result and retries.
- `spawnAndAwait` duplication: the inline await loop in `spawnAndAwait` should be removed and the shared `awaitSessions` implementation called instead. This is in scope for the change.
