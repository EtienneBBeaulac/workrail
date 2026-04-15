# Design Review Findings: WorkRail Process Kill Fix (v2)

Supersedes `design-review-findings.md`. Covers the full candidate set (C1/C2/C3) with updated tradeoff, failure mode, and philosophy analysis.

---

## Tradeoff Review

### T1: Dashboard failover may take up to 2 minutes for alive-but-unresponsive primary

With SIGTERM removed from `reclaimStaleLock()`, a process that is alive but permanently non-responsive to HTTP will hold the dashboard lock until its heartbeat expires (2-minute TTL). During this window, new processes fall into legacy mode (port 3457+).

**Verdict:** Acceptable. Affects dashboard availability only - not MCP session continuity. The dashboard is a dev inspection tool, not a production SLA.

**Failure condition:** Would become unacceptable if WorkRail processes routinely enter permanently non-responsive states. No evidence of this. The observed 192% CPU was transient load, not an infinite loop.

### T2: Version mismatch path no longer force-upgrades the dashboard immediately

With SIGTERM removed, an old-version process continues serving the dashboard until its heartbeat expires (up to 2 minutes) or its stdin closes. New-version process falls to legacy mode if old process holds port 3456.

**Verdict:** Acceptable. Dashboard shows stale assets for up to 2 minutes. Session continuity matters more than dashboard asset freshness.

**Hidden assumption:** Old-version dashboard API remains backward-compatible with session files written by any version. The dashboard is read-only and session files are append-only JSON. No version gate on session file format observed in codebase.

### T3: checkHealth() private method becomes dead code

Once SIGTERM is removed from both branches, `checkHealth()` has no callers in `reclaimStaleLock()`. It is a private method with no other callers.

**Verdict:** Not a tradeoff - it is a cleanup opportunity. `checkHealth()` should be deleted in the same PR.

---

## Failure Mode Review

### FM1: Zombie process holds port 3456 (Medium risk)

**Scenario:** Alive process with blocked event loop. Lock expires (heartbeat stops). New secondary reclaims lock. `startAsPrimary()` gets EADDRINUSE. Falls to `startLegacyMode()` on port 3457+.

**Handled?** Yes - EADDRINUSE fallback in `startAsPrimary()` (lines 484-490) is the pre-existing safety net. Dashboard degrades to legacy mode, not unavailable.

**Missing mitigation:** None required. User can run `workrail cleanup` (`fullCleanup()`) as escape hatch.

### FM2: Lock file not cleaned up on SIGKILL crash (Low risk)

**Handled?** Fully. `shouldReclaimLock()` dead-PID check (`process.kill(pid, 0)`) correctly reclaims locks from killed processes.

### FM3: Concurrent reclaim race (Low risk)

**Handled?** Fully. Atomic rename (`fs.rename`) is winner-takes-all on POSIX. Windows retry loop handles EPERM.

### FM4: Old-version process continues as secondary after lock reclaim (Low risk)

**Handled?** Gracefully. With C1, old process loses primary role but MCP session continues via stdio. This is the correct behavior.

### Highest-risk failure mode

FM1 (zombie holds port) - bounded to dashboard degradation. No MCP impact. Escape hatch exists. Manageable.

---

## Runner-Up / Simpler Alternative Review

### Runner-Up (C3: Remove SIGTERM from non-reclaim path only, keep on version-mismatch with retry)

C3's non-reclaim path change is identical to C1 for that branch. C3 loses because the version-mismatch SIGTERM is the higher-frequency trigger for auto-update users (every npm release, 159+ versions published). Keeping it with retry still kills active sessions during npm upgrades. The retry only delays the kill.

No elements of C3 are worth borrowing into C1.

### Simplest possible fix considered

Remove only the `process.kill()` calls, leaving `checkHealth()` calls with unused return values. This leaves dead code that misleads future readers. C1's full removal (checkHealth + process.kill + wait blocks) is the right scope. No simpler variant satisfies acceptance criteria while remaining coherent.

---

## Philosophy Alignment

| Principle | Verdict |
|---|---|
| Architectural fixes over patches | Satisfied - removes broken mechanism entirely |
| Make illegal states unrepresentable | Satisfied - election cannot kill any process after fix |
| YAGNI with discipline | Satisfied - removes ~30 lines, adds zero |
| Compose with small, pure functions | Satisfied - respects shouldReclaimLock() authority |
| Determinism over cleverness | Acceptable tension - failover timing bounded at 2 min max |
| Validate at boundaries | Acceptable tension - TTL is passive validation; active health check was producing false positives |
| Document 'why' not 'what' | Requires action - update comments in reclaimStaleLock() explaining why no SIGTERM |

---

## Findings

### RED - Session continuity violated by health check false positives

**Location:** `HttpServer.reclaimStaleLock()` non-reclaim path (lines 593-611)

**Description:** When primary fails the 2s health check despite having a valid lock (alive, fresh heartbeat, same version), SIGTERM is sent. This fires when primary is under CPU load (Node.js event loop blocked, HTTP response delayed). The 192% CPU observed on an active process confirms this is realistic.

**Fix:** Remove lines 598-610: the `checkHealth()` call, the SIGTERM, the 2s wait, and the `stillHealthy` check. Replace the entire non-reclaim path with `return false` plus an explanatory comment.

### RED - Version mismatch trigger kills processes on every npm release

**Location:** `HttpServer.reclaimStaleLock()` reclaim path (lines 615-637)

**Description:** Every npm release triggers a SIGTERM to any running WorkRail primary when a new session starts. 159+ versions published, multiple per day during active development. This is the highest-frequency kill trigger for `npx -y` users.

**Fix:** Remove lines 615-637: the dead-PID guard (`process.kill(pid, 0)`), the `checkHealth()` call, the SIGTERM, and the 2s wait. Proceed directly to the atomic lock reclaim.

### ORANGE - checkHealth() becomes dead code after fix

**Location:** `HttpServer.checkHealth()` (lines 711-730)

**Description:** Once both SIGTERM-sending code paths are removed, `checkHealth()` has no callers. The private method serves no purpose.

**Fix:** Delete `checkHealth()` in the same PR. If future use is anticipated, leave a comment on the `shouldReclaimLock()` or `reclaimStaleLock()` methods explaining why health check was removed.

### YELLOW - Election logic has no automated test coverage

**Location:** `HttpServer.reclaimStaleLock()` and `shouldReclaimLock()`

**Description:** The 'process alive but health check fails' path has no tests. `shouldReclaimLock()` is a pure function with no tests. The fix removes the untested path, reducing surface, but the pure function remains untested.

**Fix:** Follow-up PR to add unit tests for `shouldReclaimLock()` (pure function, easy to test). Inject `checkHealth` via port if future health-check-based decisions are needed (C2 pattern). Not blocking.

---

## Recommended Revisions

### Required (unblocking)

1. Remove non-reclaim path body: delete the `checkHealth(lockData.port)` call (line ~595), the `process.kill(lockData.pid, 'SIGTERM')` call (line ~603), the 2s wait (line ~604), and the `stillHealthy` check (lines ~607-610)
2. Simplify non-reclaim path to: `if (!reclaim) { return false; }` with comment: `// Primary is alive. Do not send SIGTERM -- it would kill an active MCP session. Rely on heartbeat TTL for eviction.`
3. Remove reclaim path SIGTERM guard: delete the entire try/catch block at lines ~625-635 (dead-PID check + checkHealth + SIGTERM + 2s wait)
4. Delete the `checkHealth()` private method (lines ~711-730, now dead code)
5. Update the `reclaimStaleLock()` JSDoc comment to explain the simplified contract

### Recommended (same PR)

6. Add `// Why no SIGTERM: see docs/plans/... or analysis/workrail-process-kill-discovery.md` reference comment so future readers can find the rationale

### Deferred (follow-up)

7. Add unit tests for `shouldReclaimLock()` pure function
8. C2 pattern: inject `checkHealth` as a port if election logic tests are needed in the future

---

## Residual Concerns

1. **Dashboard legacy mode UX:** When primary holds port 3456, new processes use port 3457+. Users with multiple Claude tabs may see dashboard at different ports. Low priority relative to MCP session continuity.

2. **Temp lock file orphan:** `dashboard.lock.29380.1765094471551` (empty, from Dec 7) exists in `~/.workrail/`. Not related to this bug. Cleanup is cosmetic.

3. **Version mismatch lock reclaim timing:** After fix, old-version process continues holding port 3456 even after its lock is reclaimed by new version. New version falls to legacy mode until old process exits. This is expected and acceptable per T2 above.
