# WorkRail Process Kill Discovery

**Purpose:** Human-readable artifact for the discovery investigation. Execution truth lives in WorkRail workflow notes and context variables.

---

## Context / Ask

WorkRail MCP server processes are unexpectedly dying and needing to be respawned repeatedly. The user reports that WorkRail keeps getting killed across multiple IDE sessions (Claude Code, Firebender). With 5+ concurrent WorkRail processes running, the user must manually respawn the server.

## Path Recommendation

**full_spectrum** - Both landscape grounding (complete system lifecycle) AND problem reframing (the root design coupling between dashboard primary election and MCP transport) are needed. `landscape_first` alone would describe the mechanism without identifying the architectural fix.

## Constraints / Anti-goals

- Must not break the dashboard primary/secondary pattern
- Must not break the stdio MCP transport lifecycle
- Do not simply disable the health check
- Do not make the primary election less reliable

## Landscape Packet

### Architecture

Each WorkRail process is BOTH:
1. A stdio MCP server (for one IDE session, via stdin/stdout)
2. Potentially the HTTP dashboard primary (port 3456, serves all sessions' dashboard)

The process lifecycle:
- **Startup:** `mcp-server.ts` -> `startStdioServer()` -> `composeServer()` + `wireStdinShutdown()` + `wireShutdownHooks()`
- **Shutdown trigger 1 (normal):** stdin `end` event fires -> `shutdownEvents.emit(SIGHUP)` -> `wireShutdownHooks` teardown -> `process.exit(0)`
- **Shutdown trigger 2 (signal):** SIGINT/SIGTERM/SIGHUP -> same path
- **Shutdown trigger 3 (kill cascade):** `HttpServer.reclaimStaleLock()` sends `SIGTERM` to a different running WorkRail process

### Dashboard Primary Election

`HttpServer.tryBecomePrimary()`:
- Atomically creates `~/.workrail/dashboard.lock` (PID, port, version, heartbeat)
- If lock exists: calls `reclaimStaleLock()`

`HttpServer.reclaimStaleLock()`:
- Reads lock file
- Calls `shouldReclaimLock(lockData)` which returns `{reclaim: true}` if:
  - Invalid structure
  - **Version mismatch** (`lockData.version !== CURRENT_VERSION`)
  - **Stale heartbeat** (last heartbeat > 2 minutes ago)
  - PID dead
- If `!reclaim` but health check fails: SIGTERMs the existing primary
- If `reclaim`: SIGTERMs the existing primary (with checkHealth guard)

### Health Check

```typescript
// checkHealth timeout: 2 seconds
const timeout = setTimeout(() => controller.abort(), 2000);
const response = await fetch(`http://localhost:${port}/api/health`, { signal: controller.signal });
```

### Heartbeat

- Interval: 30 seconds (`DashboardHeartbeat`)
- Uses `.unref()` so it doesn't keep process alive
- TTL: 2 minutes (staleness threshold in `shouldReclaimLock`)

## Problem Frame Packet

### Primary Kill Chain (most likely)

1. Primary WorkRail (PID X) holds dashboard lock, serves active MCP session, is under heavy CPU load
2. New WorkRail (PID Y) starts for a new IDE session
3. PID Y finds lock: pid=X alive, heartbeat valid (<2min), same version
4. PID Y calls `checkHealth(3456)` with 2-second timeout
5. PID X under heavy CPU load (observed: 192% CPU on one process) - Node.js event loop backed up
6. HTTP `/api/health` does not respond within 2s -> `checkHealth` returns `false`
7. `reclaimStaleLock` (lines 595-608): "process exists but not responding" path -> sends SIGTERM to PID X + waits 2s
8. PID X killed -> **active MCP session dies** -> user must respawn WorkRail
9. PID Y becomes new primary, same vulnerability exists for PID Z

### Secondary Kill Chain (dormant but recurring)

Version mismatch: `shouldReclaimLock` immediately SIGTERMs on `lockData.version !== CURRENT_VERSION`. After each npm release, users running `npx -y @exaudeus/workrail` (auto-update) will pick up a new version. Any older-version primary running an active session gets killed.

- Currently both npm and local are 3.16.0 (dormant)
- Will trigger with every `fix:` or `feat:` merge to main

### Structural Root Cause

The design couples two orthogonal concerns:
- **MCP transport lifecycle** (1:1 with IDE session, stdin-driven)
- **Dashboard primary election** (N:1, process-level, lock-file driven)

When the election mechanism kills a process to take over the dashboard, it also destroys the MCP connection that process was serving. The election doesn't know or care that killing PID X breaks a user's active workflow session.

## Candidate Directions

### Option A: Increase health check timeout (quick fix)
Change `checkHealth` timeout from 2s to 10-15s. Reduces false-positive kills under load.
- Pro: Minimal change, fast to ship
- Con: Doesn't fix the root coupling. A process that's truly stuck for 10s is probably in trouble anyway. The 2-min heartbeat TTL still creates a window.

### Option B: Retry health check before SIGTERMing (medium fix)
Retry health check 2-3 times with backoff before concluding the primary is unresponsive.
- Pro: More resilient to transient load spikes
- Con: Still doesn't fix the structural coupling. Increases startup latency.

### Option C: Decouple dashboard from MCP process (architectural fix)
Run the dashboard as a separate long-lived process, not embedded in each MCP server instance.
- Pro: Eliminates the kill cascade entirely. Each MCP process is purely stdio.
- Con: Significant refactor. Requires IPC or HTTP between MCP processes and dashboard. Deployment complexity increases.

### Option D: Make SIGTERM only affect dashboard, not MCP (medium fix)
When a process receives SIGTERM from lock reclaim, only stop the HTTP server, not the entire process. The process continues serving its MCP session. The new primary takes over the dashboard.
- Pro: Preserves MCP session continuity
- Con: Two processes now serve the same port in transition. Lock handoff semantics get complex.

### Option E: Prevent SIGTERM to processes with active MCP sessions (medium fix)
Add a "has active MCP session" marker (heartbeat file, lock, or signal) so the election logic won't SIGTERM a process that's actively serving a session.
- Pro: Targeted fix for the exact problem
- Con: Requires defining "active session" reliably. Race condition between session end and SIGTERM.

### Option F: Remove SIGTERM from election; rely only on heartbeat TTL (simplest fix)
Stop sending SIGTERM during `reclaimStaleLock`. Instead, wait for the heartbeat to expire (2 minutes) before taking over.
- Pro: No more proactive kills. Processes that are alive but under load are safe.
- Con: Dashboard failover takes up to 2 minutes instead of ~5 seconds. Users may notice dashboard gap.
- Note: For version mismatch reclaim, a 2-minute wait may still be acceptable since the dashboard content doesn't change that drastically in 2 minutes.

## Additional Landscape Findings

### Release frequency
159 npm versions published, multiple per day during active development (3.12.0, 3.13.0, 3.14.0 all on Apr 2). For users on `npx -y @exaudeus/workrail` (auto-update), every new release causes the existing primary to be killed when any new session starts.

### sessionTools is enabled by default
`WORKRAIL_ENABLE_SESSION_TOOLS` defaults to `true` in both `feature-flags.ts` and the default `~/.workrail/config.json` template. This means every WorkRail process participates in the dashboard primary election. There is no way to run WorkRail without the election mechanism unless you explicitly disable session tools.

### Observed state (2026-04-08 08:40AM)
- 5 concurrent WorkRail processes, all from same `dist/mcp-server.js`
- PID 43264: primary, lock fresh, started 8:39AM
- PID 44954: 192% CPU (active workflow execution)
- PID 67954: started 4:13PM previous day (long-running session)
- Stale empty temp lock file from Dec 7 (past failed reclaim)

## Challenge Notes

- The health check is fundamentally unreliable as a liveness proxy for a busy process
- Node.js single-threaded event loop means heavy computational work blocks HTTP responses
- The version mismatch reclaim is intentional for "fresh assets" but aggressive
- Multiple concurrent WorkRail processes is the expected use case with worktrees/multiple tabs

## Resolution Notes

### Selected Direction: Remove SIGTERM and checkHealth from reclaimStaleLock()

The fix removes approximately 30 lines from `HttpServer.reclaimStaleLock()` in `src/infrastructure/session/HttpServer.ts`:

**Non-reclaim path (lines ~593-611):** Simplify to:
```typescript
if (!reclaim) {
  // The existing primary is alive and its heartbeat is valid.
  // Do not send SIGTERM — it would kill an active MCP session.
  // The heartbeat TTL (2 minutes) is the actual eviction mechanism.
  return false;
}
```

**Reclaim path (lines ~615-637):** Remove the entire SIGTERM guard block (the `try/catch` that calls `checkHealth()`, `process.kill(pid, 'SIGTERM')`, and the 2s wait). Proceed directly to the atomic lock reclaim.

**Result:** `reclaimStaleLock()` only does two things: determine if reclaim is needed (via `shouldReclaimLock()`), and if so, atomically write new lock data. No health checks, no SIGTERM.

### Why This Works
- `shouldReclaimLock()` correctly determines when eviction is needed (dead PID, stale heartbeat, version mismatch)
- The heartbeat TTL (2 minutes) ensures genuinely dead/stuck processes are eventually reclaimed
- Secondary mode (return false) is safe: the process continues serving its MCP session via stdio
- The EADDRINUSE fallback handles the case where the old process still holds port 3456

### Accepted Tradeoffs
1. Dashboard failover max delay: up to 2 minutes for alive-but-unresponsive primary (was ~5s)
2. Version-mismatched old dashboard may show for up to 2 minutes (was immediate)
3. No test coverage improvement (deferred to follow-up)

## Decision Log

- **2026-04-08 (initial):** Root cause identified as dual SIGTERM triggers in `reclaimStaleLock()`. Fix: remove all SIGTERM and checkHealth calls. Winner over C2 (inject) due to YAGNI. Confirmed as simplest satisfying fix.
- **Runner-up (initial):** C2 (inject `checkHealth` as port) for testability. Deferred.
- **Direction revised (initial):** During review, discovered checkHealth calls are dead code once SIGTERM removed. Removed them too.
- **2026-04-08 (wr.discovery confirmation):** Full `wr.discovery` workflow run independently confirmed C1 (remove all SIGTERM + checkHealth). Three candidates evaluated (C1: full removal, C2: retry/timeout, C3: hybrid). C2 fails criterion 5 (misses version mismatch trigger). C3 retains version-mismatch SIGTERM which is the higher-frequency kill trigger for auto-update users. C1 is the only candidate satisfying all 5 decision criteria. Four failure modes traced; all handled by pre-existing code (EADDRINUSE fallback, heartbeat TTL, dead-PID check). Residual artifacts: `design-candidates-process-kills-v2.md`, `design-review-findings-v2.md`.
- **Runner-up (confirmed):** C3 (remove from non-reclaim path, keep version-mismatch SIGTERM with retry). Switch condition: if old-version dashboard is known to serve broken UI (not just stale assets), C3 becomes justified.

## Final Summary

**Problem:** Two kill triggers in `HttpServer.reclaimStaleLock()` cause active MCP workflow sessions to be terminated:
1. Health check timeout (2s) - fires when primary is under CPU load (192% observed)
2. Version mismatch SIGTERM - fires on every npm release for auto-update users (`npx -y`)

**Fix:** Remove all `process.kill()` and `checkHealth()` calls from `reclaimStaleLock()`. Also delete `checkHealth()` private method (dead code). The function becomes a pure lock reclaim: check staleness via `shouldReclaimLock()`, atomically write new lock if stale. ~30 lines removed.

**Specific changes to `src/infrastructure/session/HttpServer.ts`:**
1. Non-reclaim path (lines ~593-611): Replace with `return false` + comment explaining why no SIGTERM
2. Reclaim path SIGTERM guard (lines ~615-637): Delete entire try/catch block (PID check + checkHealth + SIGTERM + 2s wait)
3. Delete `checkHealth()` private method (lines ~711-730)
4. Update JSDoc on `reclaimStaleLock()`

**Tradeoffs accepted:**
- Dashboard failover max delay: up to 2 minutes for alive-but-unresponsive primary (was ~5s, but 5s was unreliable)
- Version-mismatched old dashboard may serve for up to 2 minutes (was immediate kill)
- `checkHealth()` deleted; future health-check-based decisions need re-injection (C2 pattern, follow-up)

**Confidence:** High. Four independent analysis rounds agree. Fix is a deletion. All failure modes handled by pre-existing code. Safety net (heartbeat TTL + EADDRINUSE fallback) remains intact.
