# Design: Daemon-Owned HTTP Console

**Status:** Discovery complete, ready for implementation
**Date:** 2026-04-16

---

## Problem Understanding

### Core tensions

1. **Daemon-owned console vs. DI-managed HttpServer**: The `HttpServer` class in DI is a singleton with primary/secondary election, heartbeat, and lock logic. The daemon already uses DI. But `HttpServer` has `SessionManager` injected as a required dependency -- the daemon's use case is different (it needs `ConsoleService` routes from `console-routes.ts`, not the old V1 session routes). Tension: use the existing `HttpServer` class (complex, unneeded deps) vs. a minimal standalone server (simpler, parallel infrastructure).

2. **`mountRoutes()` called before `start()` in `composeServer()`**: Today the MCP server calls `mountRoutes()` in `composeServer()` before the transport entry point calls `start()`. If the daemon holds port 3456, `start()` returns `null` (secondary), but `mountRoutes()` was already called -- the SSE file watcher and enrichment callback are already running on a server that will never serve traffic. This causes file descriptor waste and potential `MaxListenersExceededWarning` on stderr (which corrupts the MCP stdio channel).

3. **Lock file reliability vs. complexity**: A `daemon-console.lock` file is the most explicit signal, but it adds a new file, a new lifecycle, and a new failure mode (stale lock after daemon crash). The existing `dashboard.lock` in `HttpServer.ts` already handles this pattern. The lock file check must include a pid-liveness probe (same pattern as `HttpServer.shouldReclaimLock()`) to handle stale locks after daemon crash.

4. **AUTO dispatch queue ownership**: `POST /api/v2/auto/dispatch` uses `triggerRouter.dispatch()` when a `TriggerRouter` is provided. If the daemon owns the console, it should pass its `TriggerRouter` instance (from `TriggerListenerHandle.router`) so dispatched workflows go through the daemon's serialized queue, not direct `runWorkflow()`.

### What makes this hard

`mountConsoleRoutes()` registers `fs.watch` on the sessions directory **immediately** on call -- not just when the server starts listening. So even in the MCP server's secondary path (where it never serves HTTP traffic), the watcher is live. A naive fix (guard on whether `start()` returns null) doesn't work because `start()` is called from the transport entry point, after `composeServer()` has already called `mountRoutes()`.

The correct fix requires preventing `mountRoutes()` from being called at all in the secondary path, which means the mount guard must live in `composeServer()` or the mount call must move to after `start()` in the transport entry point.

### Likely seam

- Daemon console startup: `cli.ts daemon` command action (composition root)
- MCP server mount guard: `composeServer()` in `server.ts` OR `stdio-entry.ts` after `httpServer.start()`

---

## Philosophy Constraints

From `CLAUDE.md` (authoritative):
- **YAGNI with discipline**: don't create elaborate abstractions, but fix real seams when they're wrong
- **Errors are data**: new `startDaemonConsole()` should return a `Result` type, not throw
- **Explicit domain types**: `DaemonConsoleHandle = { port: number; stop(): Promise<void> }` mirrors `TriggerListenerHandle`
- **Validate at boundaries**: port-conflict and lock-check are boundary validations, belong in the composition root

Repo patterns (consistent with CLAUDE.md):
- `trigger-listener.ts` uses `http.createServer(express())` directly -- the daemon console follows this pattern
- Lock files use `~/.workrail/` base directory (`DashboardHeartbeat.ts`, `HttpServer.ts`)
- Result types (`ok`/`err`) used consistently

No philosophy conflicts observed.

---

## Impact Surface

Changes that must stay consistent:
- `TriggerListenerHandle` (no change -- the daemon console handle is a separate type)
- `mountConsoleRoutes()` signature (no change -- all params remain optional)
- `composeServer()` return type (no change -- `mountRoutes()` call moves or is guarded)
- `stdio-entry.ts` transport entry point (requires `mountRoutes()` + `finalize()` after `start()` if daemon not live)
- Any other transport entry points that call `httpServer.start()` must be checked

Other transport entry points to check: `src/mcp/transports/` -- need to enumerate to ensure none are missed.

---

## Candidates

### Candidate A: Minimal inline console in daemon, no MCP guard

**Summary:** In `cli.ts daemon`, after `startTriggerListener()`, inline `express()` + `mountConsoleRoutes()` + `http.createServer().listen(3456)`. No changes to `server.ts` or `HttpServer.ts`.

**Tensions resolved:** Daemon owns the console. Console stays up as long as daemon runs.

**Tensions accepted:** Double SSE watcher problem persists (MCP server still calls `mountRoutes()` unconditionally). Port 3456 EADDRINUSE if MCP server is already running -- daemon console silently fails unless error is surfaced.

**Boundary:** `cli.ts daemon` action -- correct composition root.

**Failure mode:** EADDRINUSE when MCP server starts before daemon. Silent watcher accumulation in secondary MCP server processes.

**Repo pattern:** Follows `trigger-listener.ts` inline Express pattern exactly.

**Gains/losses:** Minimal diff (~25 lines, 1 file). Loses: no error handling, no watcher guard.

**Scope:** Too narrow -- leaves watcher leak unfixed.

**Philosophy:** Honors YAGNI. Conflicts with "validate at boundaries" (no EADDRINUSE feedback).

---

### Candidate B: `startDaemonConsole()` + `daemon-console.lock` + move `mountRoutes()` to transport entry (RECOMMENDED)

**Summary:** New `src/trigger/daemon-console.ts` exports `startDaemonConsole(ctx, options)` returning `Result<DaemonConsoleHandle, DaemonConsoleError>`. Writes `~/.workrail/daemon-console.lock` with `{ pid, port }`. In `stdio-entry.ts` (and other transports), move `mountRoutes()` + `finalize()` to after `httpServer.start()`; skip when daemon-console.lock has a live pid. `cli.ts daemon` calls `startDaemonConsole()` after trigger listener starts.

**Tensions resolved:** Daemon owns 3456 with explicit lifecycle. MCP server SSE watcher is never registered when daemon is live. Clean error handling on port conflict. Testable via extracted function.

**Tensions accepted:** More surface area -- new file, new lock convention, change to transport entry points.

**Boundary:** `cli.ts` for daemon startup, `stdio-entry.ts` for MCP mount guard.

**Failure mode:** Stale lock after daemon crash -> MCP server perpetually skips console mount. Mitigated by pid-liveness check (same pattern as `HttpServer.shouldReclaimLock()`).

**Repo pattern:** `DaemonConsoleHandle` mirrors `TriggerListenerHandle`. Lock file follows `dashboard.lock` pattern. Moving `mountRoutes()` to transport entry is an architectural improvement, not a new pattern.

**Gains/losses:** Clean lifecycle, no double watchers, testable, proper error reporting. Loses: 4 files changed instead of 1.

**Scope:** Best-fit.

**Philosophy:** Honors YAGNI with discipline (seam was architecturally wrong, fixing it is correct), errors as data, explicit domain types, validate at boundaries.

---

### Candidate C: Daemon uses full `HttpServer` class with env var gate

**Summary:** Daemon starts the `HttpServer` DI singleton. Sets `WORKRAIL_DAEMON_CONSOLE=3456`; MCP server checks this in `composeServer()` and skips `mountRoutes()`.

**Tensions resolved:** Reuses existing `HttpServer` infrastructure. No new lock file.

**Tensions accepted:** `HttpServer` requires `SessionManager` injection (unneeded). Env var check is less reliable than a lock file (inherited by child processes, not owned by a specific process). Daemon must run full primary election machinery unnecessarily.

**Failure mode:** `SessionManager` initialization overhead. Env var persists after daemon death if MCP server is a subprocess.

**Repo pattern:** Forces `HttpServer` into a use case it wasn't designed for. Env-var coupling between processes is an antipattern in this codebase.

**Scope:** Too broad.

**Philosophy:** Conflicts with YAGNI (forces unneeded `SessionManager` dep), conflicts with "make illegal states unrepresentable" (env var as cross-process signal is fragile).

---

## Comparison and Recommendation

| | A | B | C |
|---|---|---|---|
| Daemon owns 3456 | Yes | Yes | Yes |
| No MCP watcher leak | No | Yes | Fragile |
| Error handling | No | Yes | Partial |
| Testable | Poor | Good | Poor |
| Files changed | 1 | 4 | 5+ |
| Follows repo patterns | Yes | Yes | Forced fit |

**Recommendation: Candidate B**

The watcher leak is the key differentiator. `fs.watch` in secondary-mode MCP server processes doesn't serve traffic but wastes file descriptors and generates `MaxListenersExceededWarning` to stderr -- which is the MCP stdio channel, and stderr writes corrupt it. This is a real crash driver (referenced in the backlog). Candidate A leaves it unfixed.

Candidate B moves `mountRoutes()` to after `httpServer.start()` in the transport entry point, which is architecturally correct (the routes should only be mounted if the server is actually listening). This is not speculative -- it fixes a real seam that was wrong.

### Concrete implementation shape

**New file: `src/trigger/daemon-console.ts`**
```typescript
export interface DaemonConsoleHandle { port: number; stop(): Promise<void>; }
export type DaemonConsoleError = { kind: 'port_conflict'; port: number } | { kind: 'io_error'; message: string };
export async function startDaemonConsole(
  ctx: V2ToolContext,
  options: { port?: number; triggerRouter?: TriggerRouter; serverVersion?: string }
): Promise<Result<DaemonConsoleHandle, DaemonConsoleError>>
```
- Creates `ConsoleService` from `ctx.v2`
- Creates Express app, calls `mountConsoleRoutes(app, consoleService, ctx.workflowService, undefined, undefined, serverVersion, ctx, triggerRouter)`
- Writes `~/.workrail/daemon-console.lock: { pid, port }`
- Binds to port 3456 (default) on `127.0.0.1`
- Returns handle with `stop()` that closes server + deletes lock file + calls stopWatcher disposer

**Modified: `src/mcp/server.ts` `composeServer()`**
- Remove the `if (ctx.v2 && ctx.httpServer && ...) { ctx.httpServer.mountRoutes(...); ctx.httpServer.finalize(); }` block
- Export a new `mountConsoleRoutesIfOwner(httpServer, ctx, timingRingBuffer, toolCallsPerfFile, serverVersion): void` function that performs the lock check and mount

**Modified: `src/mcp/transports/stdio-entry.ts`**
- After `httpServer.start()` call, invoke `mountConsoleRoutesIfOwner(httpServer, ctx, ...)`

**Modified: `src/cli.ts` daemon command**
- After `startTriggerListener()` succeeds, call `startDaemonConsole(ctx, { triggerRouter: handle.router })`
- In `shutdown()`, call `await consoleHandle.stop()` before `handle.stop()`

---

## Self-Critique

**Strongest counter-argument against B:**
Moving `mountRoutes()` from `composeServer()` to transport entry points creates a contract where every transport entry point must remember to call `mountConsoleRoutesIfOwner()` after `start()`. If a new transport entry point is added and misses this call, the console silently doesn't mount. Candidate A avoids this risk entirely.

**Pivot condition:** If there are more than 2 transport entry points (stdio + HTTP), or if any transport entry point has complex branching that makes inserting the mount call risky, fall back to a lock-file check inside `composeServer()` (without moving `mountRoutes()`). The check would be: read `daemon-console.lock` before `mountRoutes()`; if daemon pid is live, skip. This is slightly worse (the watcher leak persists in the race window at startup) but avoids modifying transport entry points.

**Narrower option (A) loses because:** The double-watcher problem is a real bug that corrupts the MCP stdio channel. Leaving it unfixed would mean the daemon-console feature creates a new crash scenario (MCP server logs watchers to stderr while the daemon console is up, corrupting the JSON channel).

**Assumption that would invalidate this design:** If `MaxListenersExceededWarning` from `fs.watch` accumulation is NOT the actual mechanism for MCP stdio corruption, then Candidate A's simplicity wins. But the watcher accumulation is observable (each `mountConsoleRoutes()` call adds one watcher), so the fix is correct regardless.

---

## Open Questions for the Main Agent

1. **Transport entry points inventory**: Are there transport entry points beyond `stdio-entry.ts`? Check `src/mcp/transports/` for all files that call `httpServer.start()`. Any missed entry point will silently drop console mounting.

2. **Lock file name convention**: Use `daemon-console.lock` (new, explicit) or repurpose/extend `dashboard.lock` (existing, but conflates daemon console with MCP primary)? The latter avoids a new file but creates coupling between two different ownership concepts.

3. **`timingRingBuffer` for daemon console**: The daemon doesn't create a `ToolCallTimingRingBuffer`. Pass `undefined` to `mountConsoleRoutes()` for this param. The `WORKRAIL_DEV=1` perf endpoint will be unavailable from the daemon console -- is this acceptable?

4. **CORS for daemon console**: The standalone Express server in `startDaemonConsole()` should add CORS headers (same as `HttpServer.setupMiddleware()`). The `mountConsoleRoutes()` function doesn't add CORS itself -- it relies on the caller's Express app middleware.
