# Bug Handoff: WorkRail MCP Server Disconnections

**Date:** 2026-04-18
**Severity:** High (production-impacting, kills live sessions)
**Diagnosis type:** `root_plus_downstream`

---

## Bug Summary

The WorkRail MCP stdio server crashes within 2 seconds of startup due to an unhandled
asynchronous EPIPE error on `process.stderr`. When Claude Code closes an MCP connection
quickly (e.g., during `/mcp` reconnect), both `stdout` and `stderr` pipes break. The code
has `try/catch` guards around all `process.stderr.write()` calls, but those guards only
protect against *synchronous* exceptions. The actual EPIPE is delivered as an async
`'error'` event on the stderr Socket after the call frame exits. Since no
`process.stderr.on('error')` listener exists, Node.js promotes it to `uncaughtException`,
which `registerFatalHandlers` catches and routes to `fatalExit()` -> `process.exit(1)`.

The user experiences this as a "mid-session disconnect" because:
1. User does `/mcp` reconnect (or Claude Code auto-reconnects).
2. New MCP server starts, begins `HttpServer.start()` / `tryBecomePrimary()` / `reclaimStaleLock()`.
3. The startup sequence writes to stderr (status messages, lock reclaim notification).
4. If Claude Code's reconnect was fast (common during rapid `/mcp` retries), stderr is already
   broken when the write is queued.
5. Async EPIPE on stderr -> crash -> user must do `/mcp` again.
6. Repeat until a clean startup window is hit.

---

## Repro Summary

- **Symptom:** Claude Code requires `/mcp` reconnects multiple times per day.
- **Environment:** macOS, Claude Code, WorkRail installed from npm
  (`/opt/homebrew/bin/workrail`, v3.32.0), MCP server in stdio mode.
- **Trigger:** User does `/mcp` reconnect, or Claude Code auto-reconnects. If the reconnect
  is fast enough that Claude Code moves on while the new server is still initializing
  (~0-2 seconds window), the next `process.stderr.write()` call in the new server crashes it.
- **Evidence:** `~/.workrail/crash.log` contains 15 production crash entries:
  - 100% have `message: "write EPIPE"`
  - 100% have `transport: "stdio"`
  - 100% have `uptimeMs < 2200ms` (all crash during startup)
  - Crash sites: `HttpServer.reclaimStaleLock` (line 436), `HttpServer.printBanner`,
    `HttpServer.start`, `shutdown-hooks.js:50` -- all inside `try/catch` blocks

---

## Diagnosis: Confirmed Root Cause

**The specific bug:** `process.stderr` has no `'error'` event listener anywhere in the
MCP transport layer. This is verifiable:

```
grep -r "stderr.*\.on" src/mcp/transports/    # zero matches
grep -r "stderr.*\.on" src/infrastructure/    # zero matches
node -e "console.log(process.stderr.listenerCount('error'))"  # outputs: 0
```

`stdout` has protection via `wireStdoutShutdown()` which registers:
```ts
process.stdout.on('error', (err) => { ... shutdownEvents.emit({kind:'shutdown_requested',...}) })
```

`stderr` has *no equivalent*. The fix is to add one.

**Why the `try/catch` does not protect:**
Node.js `Socket.write()` (and by extension `process.stderr.write()`) does NOT throw
synchronously on EPIPE on macOS. It enqueues the write and returns a boolean. The OS-level
EPIPE signal arrives asynchronously and is delivered as a `'error'` event on the Socket
*outside* the current JavaScript call frame -- beyond the reach of any `try/catch`.

**Cascade after crash:**
- `fatalExit()` runs, tries to write to stderr (fails silently), writes crash.log entry.
- `process.exit(1)` kills the MCP server.
- Claude Code loses the MCP connection.
- User does `/mcp` -> new server spawns -> may crash again if the retry is fast.
- Eventually a stable startup window is hit and the server persists indefinitely
  (PID 90392: 1+ day runtime, 46MB RSS, 38 fds -- completely healthy once started).

---

## Secondary Finding: Bridge Spawn Loop Resilience Regression (H2)

**Separate issue, not the primary user-facing bug.**

`~/.workrail/bridge.log` shows 109 bridge sessions (from sessions that use the
bridge/HTTP-primary architecture) all following this exact pattern:

```
reconnected(attempt:0) -> budget_exhausted(budgetUsed:8, respawnBudget:0) ->
spawn_lock_acquired -> spawn_lock_skipped -> spawn_primary x3
```

**Mechanism:** When the primary dies and the bridge reconnects:
1. Reconnect Loop A starts (state: reconnecting, budget=3).
2. `detect(attempt=0)` finds the primary immediately -> Loop A returns `'reconnected'`.
3. `buildConnectedTransport()` sets state to `'connected'`.
4. Primary dies again immediately (`t.onclose` fires).
5. `t.onclose` sets state to `'reconnecting'` (new state, budget=3) and starts Loop B.
6. Loop A's `.then()` fires: it sees Loop B's `reconnecting` state, logs `reconnected(attempt:0)`
   (using Loop B's `attempt` field which is 0), and returns.
7. Loop B runs 8 reconnect attempts with ECONNREFUSED (<1ms each), exhausts budget,
   cycles through 3 spawn attempts (budget 3->2->1->0), then hits `budget_exhausted`.

**Effect:** Bridges spend their entire spawn budget in one rapid burst when the primary
dies at exactly the wrong moment. The zero `'waiting_for_primary'` events in the log
suggests bridges are dying (likely via EPIPE crash) before the wait loop log entry is
written, or the spawned HTTP primaries are not maintaining stable connections.

This is a resilience regression but does NOT directly affect current stdio-mode MCP sessions.

---

## Alternatives Ruled Out

| Hypothesis | Ruling |
|---|---|
| Standalone console competing for port 3456 | Graceful fallback to port 3457+, not a crash |
| File watchers from standalone console interfering | Different process, no crash mechanism |
| Memory exhaustion from conversation logging (PR #528) | Daemon-only feature; MCP server RSS=46MB healthy |
| Daemon crash corrupting shared DI singletons | Daemon and MCP server are separate processes with separate DI containers |
| EPIPE from daemon writing to MCP stdio | Daemon on port 3200 has no stdio connection to the MCP server |

---

## High-Level Fix Direction

### Fix 1 (Primary -- Critical): Add stderr error listener

**File:** `src/mcp/transports/fatal-exit.ts`
**Where:** Inside `registerFatalHandlers()`, BEFORE any async work, at the very top.

Add a no-op error handler on `process.stderr` to absorb async EPIPE events:
```ts
process.stderr.on('error', () => { /* absorb async EPIPE -- see wireStdoutShutdown for pattern */ });
```

This mirrors the `wireStdoutShutdown()` pattern that already protects `process.stdout`.
The no-op is sufficient because `process.stderr` is write-only diagnostics -- there is
nothing to recover. The goal is only to prevent Node.js from promoting the unhandled
error event to `uncaughtException`.

`registerFatalHandlers()` is called first in every entry point (stdio-entry.ts, http-entry.ts,
bridge-entry.ts), so registering here protects all transport types.

**Alternative placement:** Could also go in each entry point before `composeServer()`, but
`registerFatalHandlers()` is the single earliest call and the most defensible location.

### Fix 2 (Secondary -- Medium): Bridge reconnect race condition

**File:** `src/mcp/transports/bridge-entry.ts`
**Issue:** When the primary dies immediately after the bridge connects, the bridge can
have two concurrent reconnect loops (A and B). Loop A's outcome handler reads Loop B's
state snapshot, causing `reconnected` to be logged for what is actually Loop B's first
attempt, and Loop B's budget to be consumed rapidly.

**Direction:** The `handleReconnectOutcome` guard
(`if (stateAtOutcome.kind !== 'reconnecting') return`) should use the state snapshot
captured at *loop start*, not re-read at outcome time. Or: ensure `startReconnectLoop()`
is idempotent when called from `t.onclose` while a loop is already completing.

---

## Likely Files Involved

- `src/mcp/transports/fatal-exit.ts` -- **primary fix location** (`registerFatalHandlers`)
- `src/mcp/transports/shutdown-hooks.ts` -- existing stdout protection pattern to reference
- `src/mcp/transports/bridge-entry.ts` -- secondary fix (reconnect loop race)
- `src/infrastructure/session/HttpServer.ts` -- call sites that use `process.stderr.write()`
  (no code change needed here; they work correctly once stderr has an error listener)

---

## Verification Recommendations

1. **Unit test:** Add a test in `fatal-exit.test.ts` or a new `stderr-epipe.test.ts`:
   - Call `registerFatalHandlers()` on a mock stderr with an `'error'` listener count check.
   - Confirm that emitting `'error'` on stderr does NOT trigger `uncaughtException`.

2. **Manual repro before fix:** Run `workrail` stdio server, immediately close the pipe
   (e.g., via `workrail | head -0`) -- should produce a crash.log EPIPE entry.
   After fix, the same command should NOT produce a crash.log entry and should exit cleanly.

3. **Crash log regression:** After deploy, confirm `~/.workrail/crash.log` stops receiving
   `write EPIPE` + `transport: stdio` entries during normal /mcp reconnect cycles.

4. **Bridge resilience:** Observe `~/.workrail/bridge.log` -- after bridge fix, expect to see
   `waiting_for_primary` events appear when budget is exhausted (currently never logged).

---

## Residual Uncertainty

- **Why HTTP primaries spawned by bridges disconnect immediately** (H2 sub-cause): Confirmed
  they are not crashing (no crash.log entries). Root sub-cause of rapid disconnect (wrong
  port, StreamableHTTP handshake issue, or another process claiming port 3100) was not
  directly observable without live instrumentation. This is a secondary issue and does not
  affect the primary crash fix.
