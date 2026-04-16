# Implementation Plan: Daemon-Owned HTTP Console

**Status:** Ready for implementation
**Branch:** `feat/daemon-owns-console`
**Date:** 2026-04-16

---

## 1. Problem Statement

The console dashboard (`localhost:3456`) goes down whenever the MCP server crashes or Claude Code restarts, because the console is hosted by whichever MCP server wins the primary election. The daemon -- the actual long-running process -- has no role in hosting the console today. The fix: the daemon starts and owns the HTTP console on port 3456.

---

## 2. Acceptance Criteria

- [ ] When `workrail daemon` starts, the console dashboard is available at `http://localhost:3456/console`
- [ ] The console stays available as long as the daemon process is running
- [ ] The console goes down when the daemon stops (SIGTERM or SIGINT)
- [ ] `POST /api/v2/auto/dispatch` on the daemon console dispatches through the daemon's `TriggerRouter` queue
- [ ] When port 3456 is already held by an MCP server, the daemon logs a clear human-readable message and continues (trigger listener on 3200 still starts)
- [ ] When the daemon is running, the MCP server's `HttpServer` becomes secondary (no port conflict, no double console)
- [ ] The `workrail daemon` process does NOT exit on port 3456 conflict -- only the console is degraded

---

## 3. Non-Goals

- Merging port 3200 (webhook) and port 3456 (console) into a single port
- Modifying `HttpServer.ts` class internals
- Streaming live agent output in the console (separate backlog item)
- Adding token auth to `POST /api/v2/auto/dispatch` (filed as a TODO in console-routes.ts)
- Adding an integration test for the full daemon startup flow (out of scope, complex process harness needed)
- Exposing the `timingRingBuffer` / perf endpoint on the daemon console (dev-only, acceptable gap)

---

## 4. Philosophy-Driven Constraints

| Constraint | Source |
|------------|--------|
| `startDaemonConsole()` must return `Result<DaemonConsoleHandle, DaemonConsoleError>`, not throw | CLAUDE.md: errors are data |
| `DaemonConsoleHandle` properties are `readonly` | CLAUDE.md: immutability by default |
| `ctx: V2ToolContext` is injected at the composition root, not read from env inside the function | CLAUDE.md: dependency injection for boundaries |
| No `composeServer()` lock check (deferred) -- accept cosmetic double-watcher | CLAUDE.md: YAGNI with discipline |
| Port conflict is surfaced to the user via log message, not silently swallowed | CLAUDE.md: validate at boundaries |

---

## 5. Invariants

1. The daemon console and MCP server console never both serve traffic on port 3456 simultaneously (enforced by OS port exclusivity -- EADDRINUSE)
2. When `DaemonConsoleHandle.stop()` is called, the `fs.watch` disposer from `mountConsoleRoutes()` is called before the HTTP server closes
3. `daemon-console.lock` contains `{ pid: number, port: number }` and is deleted by `stop()` or on daemon exit
4. The trigger listener on port 3200 starts regardless of whether the daemon console starts successfully

---

## 6. Selected Approach

**Simpler hybrid of Candidate B:** Extract `startDaemonConsole()` with Result type and lifecycle handle. Write `daemon-console.lock`. Do NOT add lock check to `composeServer()` (deferred).

**Runner-up:** Candidate A (inline, no guard). Lost because it doesn't extract the function (poor testability) and doesn't write the lock file (useful for future tooling).

**Rationale:** Follows established `TriggerListenerHandle` pattern exactly. Minimal surface area (2 files). Clean error handling. Deferred `composeServer()` optimization avoids premature complexity.

---

## 7. Vertical Slices

### Slice 1: `src/trigger/daemon-console.ts` (new file)

**Scope:** New module that starts a standalone Express HTTP server on port 3456, mounts console routes, writes the lock file.

**Acceptance criteria:**
- Exports `DaemonConsoleHandle: { readonly port: number; stop(): Promise<void> }`
- Exports `DaemonConsoleError: { kind: 'port_conflict'; port: number } | { kind: 'io_error'; message: string }`
- Exports `startDaemonConsole(ctx: V2ToolContext, options: StartDaemonConsoleOptions): Promise<Result<DaemonConsoleHandle, DaemonConsoleError>>`
  where `StartDaemonConsoleOptions = { port?: number; triggerRouter?: TriggerRouter; serverVersion?: string; workflowService?: WorkflowService }`
- Creates Express app with CORS middleware (`cors({ origin: '*', methods: ['GET', 'HEAD', 'OPTIONS', 'POST'], allowedHeaders: ['Content-Type'] })`)
- Creates `ConsoleService` from `ctx.v2`
- Calls `mountConsoleRoutes(app, consoleService, workflowService, undefined, undefined, serverVersion, ctx, triggerRouter)`
- Binds to `127.0.0.1:port` (default 3456)
- On bind success: writes `~/.workrail/daemon-console.lock = JSON.stringify({ pid: process.pid, port: actualPort })`
- Returns `{ port: actualPort, stop: async () => { stopWatcher(); server.close(); await releaseLock(); } }`
- On EADDRINUSE: returns `err({ kind: 'port_conflict', port })`
- On other bind error: returns `err({ kind: 'io_error', message })`
- Lock file write failures are non-fatal: log warning, proceed

**Files changed:** `src/trigger/daemon-console.ts` (new)

### Slice 2: `src/cli.ts` daemon command wiring

**Scope:** After `startTriggerListener()` succeeds, call `startDaemonConsole()`. Handle port conflict with clear log. Add shutdown cleanup.

**Acceptance criteria:**
- `startDaemonConsole(ctx, { triggerRouter: handle.router, workflowService: rawCtx.workflowService })` is called after trigger listener starts
- On `ok(consoleHandle)`: log `WorkRail console available at http://localhost:${consoleHandle.port}/console`
- On `err({ kind: 'port_conflict' })`: log `[DaemonConsole] Port ${port} is already held (likely by an MCP server). The daemon is running but the console is unavailable. Restart the MCP server while the daemon is running to enable the daemon console.`
- On `err({ kind: 'io_error' })`: log the error, continue (non-fatal)
- In `shutdown()`: if `consoleHandle` exists, `await consoleHandle.stop()` before `await handle.stop()`

**Files changed:** `src/cli.ts`

---

## 8. Test Design

### Unit tests for `startDaemonConsole()`

**File:** `src/trigger/daemon-console.test.ts`

**Test cases:**
1. **Happy path**: `startDaemonConsole()` with a mock `V2ToolContext` and port=0 (OS-assigned). Verify returns `ok(handle)`, handle.port is non-zero, `GET /api/v2/sessions` returns 200.
2. **Port conflict**: Start two instances on the same port. Second returns `err({ kind: 'port_conflict' })`.
3. **stop() cleans up**: After `handle.stop()`, the port is released (can bind again). Verify `stopWatcher` was called (spy).
4. **Lock file written**: After start, `~/.workrail/daemon-console.lock` exists with correct `{ pid, port }`.
5. **Lock file deleted on stop**: After `handle.stop()`, lock file is deleted.

**Pattern:** Follow `trigger-listener.test.ts` for test structure. Use `port: 0` for OS-assigned ports to avoid conflicts.

---

## 9. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| EADDRINUSE because MCP server starts before daemon | High | Low -- daemon still works on 3200 | Clear log message (Slice 2) |
| stopWatcher disposer not called in stop() | Low | Low -- fd leak | Implementation requirement, verified by test 3 |
| Lock file on NFS home directory (latency) | Very low | None -- lock write is fire-and-forget | Non-fatal lock write (log warning, proceed) |
| CORS headers missing on daemon Express app | Was a risk | None | Fixed in Slice 1 |

---

## 10. PR Packaging Strategy

Single PR: `feat/daemon-owns-console`
- Slice 1 and Slice 2 together (they're co-dependent -- no value without both)
- Include test file
- PR description links to `docs/design/daemon-owns-console.md`

**estimatedPRCount:** 1

---

## 11. Philosophy Alignment

| Slice | Principle | Status |
|-------|-----------|--------|
| Slice 1 | Errors are data | Satisfied -- `Result<DaemonConsoleHandle, DaemonConsoleError>` |
| Slice 1 | Immutability by default | Satisfied -- `readonly port` |
| Slice 1 | Dependency injection | Satisfied -- ctx injected, no env reads inside function |
| Slice 1 | Compose with small pure functions | Satisfied -- delegates to `mountConsoleRoutes()` |
| Slice 2 | Validate at boundaries | Satisfied -- port conflict logged with clear UX message |
| Slice 2 | YAGNI with discipline | Satisfied -- no composeServer() lock check |

---

## 12. Follow-up Tickets

1. **Add token auth to `POST /api/v2/auto/dispatch`** -- the daemon console makes the always-up no-auth endpoint more exposed (existing TODO in console-routes.ts)
2. **Add `composeServer()` lock check** -- if MaxListenersExceededWarning is observed in practice during daemon+MCP co-runs, add the lock file check to prevent watcher accumulation
3. **NFS latency mitigation** -- if someone reports slow daemon startup on NFS home dir, add a 100ms timeout on the lock file write

---

**planConfidenceBand:** High
**unresolvedUnknownCount:** 0
