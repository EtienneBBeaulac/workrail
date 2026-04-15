# Design Candidates: WorkRail Process Kill Investigation

**Note:** This is raw investigative material for main agent review, not a final decision.

---

## Problem Understanding

### Core tensions
1. **Dashboard freshness vs. session continuity:** Version mismatch reclaim wants the dashboard to always run the latest binary. But 'latest binary' means killing the process serving an active workflow session.
2. **Fast failover vs. false-positive kill:** 2s health check allows fast dashboard recovery when primary dies, but triggers on any transient CPU load spike.
3. **Embedded simplicity vs. lifecycle isolation:** Dashboard embedded in every MCP process is operationally simple. Isolating it (separate process) is correct but a large refactor.
4. **Observable failure vs. silent degradation:** When primary doesn't respond in 2s, it is silently killed with no log visible to the user whose session died.

### Likely seam
`HttpServer.reclaimStaleLock()` in `src/infrastructure/session/HttpServer.ts`, specifically:
- Lines 593-611: 'process alive but not responding' branch (non-reclaim path)
- Lines 615-637: version mismatch branch (reclaim path, includes checkHealth guard)

Both branches send SIGTERM to a running process. Both are the immediate trigger for the user-visible bug.

### What makes this hard
1. The version mismatch trigger has legitimate intent (fresh assets) but wrong mechanism (kill vs. graceful handoff). The 'right' fix requires roles to be more decoupled, which is a larger change.
2. Junior developer trap: just increase the timeout. Does not address version mismatch trigger, which is independent and potentially more frequent (159 npm versions, multiple per day).
3. The fix touches safety-critical code - same code that prevents zombie dashboard processes. Any change must preserve the 'dead process gets evicted' behavior.
4. No existing test coverage for the 'process alive but health check fails' path.

---

## Philosophy Constraints

**Principles under active pressure:**
- `Architectural fixes over patches` - push toward removing the broken mechanism, not patching it
- `YAGNI with discipline` - push back against over-engineering; smallest satisfying fix
- `DI for boundaries` - `checkHealth()` uses hardcoded `fetch()`, not injected; violates the established port pattern
- `Make illegal states unrepresentable` - 'process under load' and 'process dead' are being collapsed to the same SIGTERM action

**Conflicts in repo:**
- Stated: architectural fixes. Practiced: HttpServer.ts has 5+ "BUG FIX" boolean flags accumulated over time.
- Stated: DI for boundaries. Practiced: `checkHealth()` is not injectable.

---

## Impact Surface

Must stay consistent:
- `tryBecomePrimary()` and `reclaimStaleLock()` - only callers of `checkHealth()`
- `setupPrimaryCleanup()` - already handles 'received SIGTERM from election', no change needed
- `DashboardHeartbeat` - independent, no change needed
- Tests that mock/test `HttpServer.start()` will need updating if election logic changes
- The EADDRINUSE fallback path in `startAsPrimary()` - this is the safety net if port is held

---

## Candidates

### Candidate 1: Targeted dual-trigger fix
**Summary:** In `reclaimStaleLock()`, change the 'process alive but not responding' branch to retry `checkHealth()` 3 times with 5s timeout each (total max ~15s) before SIGTERMing. For version mismatch, extend the existing `checkHealth()` guard to also retry before SIGTERMing.

- Tensions resolved: health check false-positives (retries absorb transient load), version mismatch kill timing
- Tensions accepted: dashboard takeover may take up to 15s; version-mismatched primary may serve briefly
- Boundary: `HttpServer.reclaimStaleLock()` only
- Failure mode: primary stuck for >15s never evicted via health check; must wait for heartbeat TTL (2 min max)
- Repo pattern: extends existing `checkHealth()` guard pattern already at lines 626-634
- Gain: eliminates both kill triggers with minimal code change
- Give up: slower dashboard failover; version bump dashboard freshness delayed by retry window
- Scope: best-fit
- Philosophy: honors 'architectural fixes' (fixes decision logic, not just timeout); mild YAGNI tension

### Candidate 2: Inject `checkHealth` as a port
**Summary:** Extract `checkHealth()` to an injected `IDashboardHealthChecker` interface. Concrete implementation uses `fetch` with configurable timeout (default 10s) and 3 retries. Both election branches use the same injected checker.

- Tensions resolved: health check false-positives, testability gap
- Tensions accepted: version mismatch still SIGTERMs (just with better checker)
- Boundary: `HttpServer.ts` + `di/container.ts` + `di/tokens.ts` + new `dashboard-health-checker.ts`
- Failure mode: misconfigured timeout in production makes failover very slow
- Repo pattern: follows `ProcessSignals`/`ProcessTerminator` pattern exactly
- Gain: full testability of election logic; consistent with stated DI philosophy
- Give up: larger PR surface; more DI wiring
- Scope: slightly broad vs. C1 but justified by the DI philosophy gap it closes
- Philosophy: honors DI, type safety, fakes over mocks; conflicts with YAGNI

### Candidate 3: Remove proactive SIGTERM entirely
**Summary:** Delete both SIGTERM-sending code paths from `reclaimStaleLock()`. When lock is stale, atomically reclaim the lock file and start the dashboard. Old process continues as orphaned secondary.

- Tensions resolved: both kill triggers eliminated entirely; simplest code
- Tensions accepted: requires old process to release port 3456 for new primary to bind it
- **Critical problem:** If old process is alive and holds port 3456, new process gets EADDRINUSE and falls back to legacy mode. This is degraded behavior.
- Boundary: `HttpServer.ts` only - removes ~15 lines
- Failure mode: EADDRINUSE means new primary cannot bind dashboard port unless old process exits
- Repo pattern: departs from current proactive eviction pattern
- Gain: eliminates entire class of proactive-kill bugs; removes code
- Give up: dashboard failover becomes passive/degraded when old process is alive
- Scope: best-fit in theory, but the EADDRINUSE problem makes it incomplete as a standalone fix
- Philosophy: honors 'architectural fixes'; conflicts with 'determinism over cleverness'

### Candidate 4: Active-session marker file gates SIGTERM
**Summary:** Write an 'active-session' marker file (`~/.workrail/active-sessions/{pid}.json`) when stdio MCP server receives first tool call. Before SIGTERMing a PID, check if it has an active-session marker. If it does, wait for the session to end.

- Tensions resolved: both kill triggers; most semantically correct model
- Tensions accepted: marker file orphan risk; new I/O path in hot MCP tool call path
- Boundary: `stdio-entry.ts` + `HttpServer.ts` + new `active-session-store.ts` + DI wiring
- Failure mode: orphaned marker files cause permanent SIGTERM immunity for that PID slot
- Repo pattern: new mechanism; no direct precedent
- Gain: makes MCP session explicit first-class citizen in election logic
- Give up: most complex; cross-cutting concern; new failure modes
- Scope: too broad given simpler options exist
- Philosophy: honors 'make illegal states unrepresentable'; conflicts with YAGNI

---

## Comparison and Recommendation

### Matrix: tensions x candidates

| Tension | C1 (retry) | C2 (inject) | C3 (no SIGTERM) | C4 (marker) |
|---|---|---|---|---|
| Health check false positive | Resolves | Resolves | Eliminates | Protects |
| Version mismatch SIGTERM | Partially (timing) | Partially | Eliminates | Protects |
| Dashboard failover speed | Slower (15s) | Slower (configurable) | Broken on alive-process | Deferred |
| Test coverage gap | No | Yes | Simplifies | No |
| Code complexity | Low | Medium | Lowest (minus EADDRINUSE fix) | Highest |

### Recommendation: Candidate 1 with C3 logic applied selectively

**Remove SIGTERM only from the 'alive but not responding' branch (non-reclaim path).**

The 'process alive but not responding' branch (lines 593-611) should NOT send SIGTERM. If the process is alive and the heartbeat is fresh, it is under load serving an active session. Return false (yield to existing primary). The heartbeat TTL is the actual eviction mechanism.

The version mismatch branch (reclaim path) can retain SIGTERM but add retry: `checkHealth()` 3 times with 3s timeout each (max 9s) before killing. This gives a loaded process time to respond before being killed for a version upgrade.

**Specific code changes in `reclaimStaleLock()`:**
1. Lines 593-611 (`!reclaim` path): Remove `process.kill(lockData.pid, 'SIGTERM')` and the `stillHealthy` check. Just `return false` when health check fails on a live process.
2. Lines 627-631 (`reclaim` path, version mismatch): Change `checkHealth(lockData.port)` call to retry 3x with 3s timeout each before proceeding to SIGTERM.

---

## Self-Critique

**Strongest counter-argument:** If a process is in an infinite loop that blocks HTTP for >2 minutes, it holds port 3456 forever and the new primary falls back to legacy mode. The heartbeat also won't update (event loop blocked), so after 2 min the lock becomes stale and the next process will reclaim it correctly. But the dashboard gap is 2 minutes.

**Response:** Acceptable tradeoff. The current behavior (instant failover but kills active sessions) is worse than a 2-minute gap.

**Narrower option that lost:** Just increase timeout to 10s. Loses because: doesn't fix version mismatch trigger, still a point-in-time check.

**Broader option that might be justified:** C2 (inject health checker) is justified if improving test coverage is a priority. Not required for the fix.

**Invalidating assumption:** If WorkRail frequently enters infinite loops (blocking event loop for >2 minutes), removing SIGTERM from the health-check path causes dashboard outages. Current evidence does not support this.

---

## Open Questions for Main Agent

1. Is a 2-minute maximum dashboard failover gap acceptable for the user's workflow?
2. Should we also address the test coverage gap (C2) in the same PR or defer it?
3. The version mismatch reclaim with SIGTERM: is 'dashboard freshness' worth killing an active session? Could we instead just reclaim the lock and let the old process exit naturally when its stdin closes?
