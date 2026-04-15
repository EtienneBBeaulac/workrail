# Design Review Findings: WorkRail Process Kill Fix

---

## Tradeoff Review

### T1: Dashboard failover may take up to 2 minutes for alive-but-unresponsive primary
With SIGTERM removed from `reclaimStaleLock()`, a process that is alive but permanently non-responsive to HTTP will hold the dashboard lock until its heartbeat expires (2-minute TTL). During this window, new processes become secondary (no dashboard port bound) or fall into legacy mode (port 3457+).

**Verdict:** Acceptable. Affects dashboard availability, not MCP session continuity. The dashboard is a dev tool, not a production SLA.

**Failure condition:** Would become unacceptable if WorkRail processes routinely enter a permanently non-responsive state. No evidence of this.

### T2: Version mismatch path no longer force-upgrades the dashboard
Previously, when a newer version started, it SIGTERMed the old version to immediately serve fresh assets. With SIGTERM removed, the old version continues serving the dashboard until its heartbeat expires or its stdin closes.

**Verdict:** Acceptable. Dashboard shows a 'stale' version for up to 2 minutes. Session continuity matters more than dashboard asset freshness.

### T3: No test coverage improvement for election logic
The testability gap (`checkHealth()` not injected) is not addressed in this PR.

**Verdict:** Acceptable deferral. Tracked as runner-up (C2).

---

## Failure Mode Review

### FM1: Zombie process holds port 3456 (Medium)
Alive PID but permanently non-responsive. With no SIGTERM, new process reclaims lock but gets EADDRINUSE on port 3456, falls to legacy mode. Old process eventually exits or heartbeat expires.

**Handled?** Partially - legacy fallback exists. Dashboard degrades gracefully. MCP unaffected.
**Missing mitigation:** None required for MCP safety. Dashboard-in-legacy acceptable.

### FM2: Lock file not cleaned up on SIGKILL crash (Low)
PID check in `shouldReclaimLock()` catches dead PIDs immediately. New process reclaims and starts primary. No SIGTERM needed.

**Handled?** Yes, fully.

### FM3: Concurrent reclaim race (Low)
Atomic rename is winner-takes-all. Already handled correctly.

**Handled?** Yes, fully.

### FM4: Long-running session, never exits, old version persists (Low)
Old process becomes secondary after lock reclaim. MCP session continues. Dashboard serves from new process (if port available) or legacy mode.

**Handled?** Gracefully. No MCP impact.

### Highest-risk failure mode
FM1 (zombie holds port) - limited to dashboard degradation, no MCP impact.

---

## Runner-Up / Simpler Alternative Review

### Simplification discovered during review
Removing SIGTERM makes the `checkHealth()` calls in `reclaimStaleLock()` entirely unnecessary. They were only used to inform the SIGTERM decision. Without SIGTERM, there is no decision to inform.

**Revised design:** Remove both `checkHealth()` calls AND all `process.kill()` calls from `reclaimStaleLock()`. The function becomes: `shouldReclaimLock()` -> if false return false, if true do atomic lock reclaim. ~30 lines of code removed total.

This is simpler than the original recommendation and satisfies all 5 acceptance criteria.

### Runner-up (C2: inject health checker)
Good for testability, not required for the fix. Defer to follow-up PR.

---

## Philosophy Alignment

| Principle | Verdict |
|---|---|
| Architectural fixes over patches | Satisfied - removes broken mechanism |
| Make illegal states unrepresentable | Satisfied - removes misclassification of 'busy' as 'must die' |
| YAGNI with discipline | Satisfied - removes ~30 lines |
| Compose with small, pure functions | Satisfied - respects `shouldReclaimLock()` boundary |
| Determinism over cleverness | Acceptable tension - failover timing slightly less predictable |
| Document 'why' not 'what' | Requires action - update comments when removing SIGTERM |

---

## Findings

### RED - Session continuity violated by health check false positives
**Location:** `HttpServer.reclaimStaleLock()` lines 593-637
**Description:** A healthy WorkRail process serving an active MCP session can be SIGTERMed and killed if it fails a 2-second health check. This is the primary cause of repeated user-visible "WorkRail killed" events.
**Fix:** Remove `process.kill(lockData.pid, 'SIGTERM')` from both branches of `reclaimStaleLock()`.

### RED - Version mismatch trigger kills processes on every npm release
**Location:** `HttpServer.reclaimStaleLock()` lines 615-637
**Description:** Every npm release triggers a SIGTERM to any running WorkRail primary when a new session starts. Given 159 versions published (multiple per day), this is a frequent kill trigger for auto-update users.
**Fix:** Same as above - remove all SIGTERM calls from `reclaimStaleLock()`.

### ORANGE - `checkHealth()` calls become dead code after fix
**Location:** `HttpServer.reclaimStaleLock()` lines 595, 608, 627
**Description:** Once SIGTERM is removed, the health check serves no purpose in `reclaimStaleLock()`. Should be removed to avoid confusion about why the health check exists.
**Fix:** Remove `checkHealth()` calls from `reclaimStaleLock()` in the same PR.

### YELLOW - Election logic has no automated test coverage
**Location:** `HttpServer.reclaimStaleLock()` and `shouldReclaimLock()`
**Description:** The 'process alive but health check fails' path has no tests. The fix removes code, reducing the untested surface, but the `shouldReclaimLock()` pure function still lacks tests.
**Fix:** Follow-up PR to inject `checkHealth` and add election tests. Not blocking.

---

## Recommended Revisions

### Required (unblocking)
1. Remove `process.kill(lockData.pid, 'SIGTERM')` from the non-reclaim path (lines ~603-606)
2. Remove the 2s wait and `stillHealthy` check from non-reclaim path (lines ~604-610)
3. Remove the SIGTERM guard (lines ~626-635) from reclaim path entirely
4. Remove `checkHealth()` call from non-reclaim path (line ~595)
5. Remove `checkHealth()` call from reclaim path guard (line ~627)
6. Update comments to explain why no SIGTERM: "respects active MCP sessions; heartbeat TTL is the eviction mechanism"

### Recommended (same PR)
7. Simplify `reclaimStaleLock()` non-reclaim path to: `if (!reclaim) { return false; }` with a clear comment.

### Deferred (follow-up)
8. C2: Extract `checkHealth()` to injected interface for testability

---

## Residual Concerns

1. **Dashboard legacy mode UX:** When primary is alive and holds port, new processes use legacy mode (different port, single-project view). Users with multiple Claude tabs may see inconsistent dashboard ports. Low priority - better than losing an MCP session.

2. **Temp lock file cleanup:** `dashboard.lock.29380.1765094471551` (empty, from Dec 7) is a stale artifact of a failed past reclaim. Not related to the kill bug but worth cleaning up.

3. **`shouldReclaimLock()` version mismatch logic after fix:** After removing SIGTERM, version mismatch still causes lock reclaim. The old process's HTTP server may still hold port 3456. The new process will get EADDRINUSE and fall to legacy mode (same as FM1). Acceptable.
