# Design Review Findings: Daemon-Owned HTTP Console

**Design doc:** `docs/design/daemon-owns-console.md`
**Review date:** 2026-04-16

---

## Tradeoff Review

### T1: Async file I/O in startup path
**Status:** Acceptable.
`composeServer()` already does far heavier I/O at startup (keyring load, token alias store). A `fs.readFile` on a ~100-byte lock file is negligible on local disk. Edge case: NFS home directory. Mitigated by try-catch with graceful fallback (treat missing/unreadable lock as no-daemon).

### T2: New lock file convention
**Status:** Acceptable.
Pattern is identical to `dashboard.lock`. Stale lock after daemon crash fully mitigated by pid-liveness check (`process.kill(pid, 0)`). Directory creation must use `{ recursive: true }` to handle fresh installs.

### T3: `timingRingBuffer` unavailable in daemon console
**Status:** Acceptable.
Perf endpoint (`/api/v2/perf/tool-calls`) mounts but returns empty observations in daemon console context. This is dev-mode only. A log note at daemon console startup makes the limitation visible.

---

## Failure Mode Review

### FM1: Stale lock after daemon crash
**Coverage:** Fully handled by pid-liveness check. MCP server proceeds to mount normally after crash.

### FM2: EADDRINUSE when daemon starts after MCP server (most likely in practice)
**Coverage:** Handled -- `startDaemonConsole()` returns `err({ kind: 'port_conflict' })`. Daemon still runs (trigger listener on 3200 works). Console unavailable until MCP server releases port.
**Gap:** No user-facing log message explaining how to recover. Needs: `[DaemonConsole] Port 3456 held by MCP server; restart the MCP server with the daemon already running to enable the daemon console.`

### FM3: Startup race (daemon writes lock, MCP reads stale state)
**Coverage:** Accepted as cosmetic -- MCP server mounts routes on a server that never listens (secondary path). One extra file watcher per concurrent MCP start. Bounded, not accumulating.

### FM4: `stopWatcher` disposer not called on daemon stop
**Coverage:** Implementation requirement: `DaemonConsoleHandle.stop()` must call the disposer returned by `mountConsoleRoutes()`. Same pattern as `HttpServer._runStop()` calling `_routeDisposers`.

---

## Runner-Up / Simpler Alternative Review

**Revised recommendation:** The simpler hybrid (Candidate B minus `composeServer()` lock check) is sufficient:
- Extracts `startDaemonConsole()` with Result type and clean stop lifecycle
- Writes `daemon-console.lock` (available for future tooling)
- Does NOT add lock check to `composeServer()` -- deferred (YAGNI)
- 2 files changed (new `daemon-console.ts`, modified `cli.ts`) instead of 3

The cosmetic double-watcher from the startup race is acceptable. MaxListenersExceededWarning would require 10+ simultaneous MCP server starts -- implausible.

---

## Philosophy Alignment

| Principle | Status |
|-----------|--------|
| Errors are data | Satisfied -- `Result<DaemonConsoleHandle, DaemonConsoleError>` |
| YAGNI with discipline | Satisfied -- deferred `composeServer()` lock check |
| Immutability by default | Satisfied -- readonly handle properties |
| Dependency injection | Satisfied -- `ctx: V2ToolContext` injected at composition root |
| Make illegal states unrepresentable | Acceptable tension -- process-boundary invariants cannot be type-enforced |
| Validate at boundaries | Minor tension -- `composeServer()` skips daemon check. Consequence is cosmetic. |

---

## Findings

### Yellow: Missing user-facing log on port conflict
When `startDaemonConsole()` returns `port_conflict`, the daemon CLI should log a clear message explaining the start-order dependency. Without this, users will be confused why the console isn't available.

### Yellow: `stopWatcher` disposer must be called in `stop()`
Implementation-level requirement: the disposer returned by `mountConsoleRoutes()` must be stored in the `DaemonConsoleHandle` closure and called in `stop()`. Missing this leaks an `fs.watch` on the sessions directory.

### Yellow: CORS headers needed on daemon console Express app
`mountConsoleRoutes()` does not add CORS headers -- that's the caller's responsibility. The daemon console's Express app must add CORS middleware (same as `HttpServer.setupMiddleware()`) or browser clients will be blocked when accessing from a dev tool that runs on a different origin.

---

## Recommended Revisions

1. In `startDaemonConsole()`, add CORS middleware (`cors({ origin: '*', methods: ['GET', 'HEAD', 'OPTIONS'] })`) to the Express app before calling `mountConsoleRoutes()`.
2. In `cli.ts daemon`, log a clear message when `startDaemonConsole()` returns `port_conflict`.
3. Ensure `DaemonConsoleHandle.stop()` calls the `stopWatcher` disposer before closing the server.

---

## Residual Concerns

1. **NFS home directory latency**: If `~/.workrail/` is on a slow network filesystem, the lock file write at daemon startup may add visible latency. Not a correctness concern.
2. **No integration test**: The daemon startup path (`workrail daemon` command) is not covered by existing automated tests. The new `startDaemonConsole()` function should have unit tests, but end-to-end daemon startup testing is out of scope for this task.
3. **Future: when to add the `composeServer()` lock check**: If `MaxListenersExceededWarning` is observed in practice during daemon+MCP co-runs, the lock check should be added to `composeServer()` at that point.
