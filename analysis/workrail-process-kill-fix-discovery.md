# WorkRail Process Kill Fix -- Discovery

**Status**: In progress  
**Author**: Main agent (Claude, via wr.discovery workflow)  
**Date**: 2026-04-08

---

## Problem Understanding

### Core Tensions
1. **Fast dashboard failover vs MCP session safety**: The health check in Path A was added to speed up failover from a zombie primary (~5s vs 2min). But MCP sessions are critical; the dashboard is a dev tool. Trading session safety for faster console failover is the wrong tradeoff.
2. **HTTP responsiveness as liveness signal**: Node.js is single-threaded. The event loop that serves `/api/health` also handles MCP tool calls. A busy tool call blocks health responses. Using HTTP latency as a kill gate conflates 'busy' with 'dead'.
3. **Two SIGTERM paths, one SIGTERM implementation**: SIGTERM in Path A and Path B serve structurally different purposes. Path B (reclaim=true) needs SIGTERM to free the port. Path A (reclaim=false) has no valid use case for it.

### Likely Seam
`reclaimStaleLock()` in `src/infrastructure/session/HttpServer.ts`, specifically the `if (!reclaim)` branch (lines 593-611). The bug is in control flow composition: `shouldReclaimLock()` returns false (lock valid), then `checkHealth()` overrides that result and produces SIGTERM.

### What Makes This Hard
- The zombie-primary edge case (alive PID, fresh heartbeat, but HTTP genuinely dead) looks like a valid use case for the health check. It is not: the 2-min TTL handles it within an acceptable window, and no MCP functionality is lost -- only console dashboard availability degrades.
- The version-mismatch SIGTERM in Path B is necessary and correct, making 'remove all SIGTERMs' an overcorrection. The fix must be surgical.

---

## Philosophy Constraints

Key principles in play:
- **Make illegal states unrepresentable**: `shouldReclaimLock()=false` + SIGTERM is an illegal state combination. The fix should make it structurally unreachable.
- **Architectural fixes over patches**: Increasing the timeout is a patch. Removing the incorrect gate is architectural.
- **Compose with small, pure functions**: `shouldReclaimLock()` is documented as a pure function (line 542 comment). Path A violates this by using a side-effecting HTTP call to override it.
- **YAGNI with discipline**: The zombie-primary fast-failover optimization is speculative. Remove it; add it back if evidence demands it.

No philosophy conflicts found. Stated principles and codebase patterns agree.

---

## Impact Surface

- `tryBecomePrimary()` calls `reclaimStaleLock()` -- its boolean return is unchanged by the fix.
- `startAsPrimary()`, `setupPrimaryCleanup()`, `DashboardHeartbeat.ts` -- not touched.
- Tests mocking `checkHealth` in Path A -- existing tests unaffected; a new test for the Path A fix is needed.
- Path B (reclaim=true) -- entirely unchanged by Candidate A.

---

## Candidates

### Candidate A: Remove the health check gate from Path A entirely
**Summary**: Delete lines 594-611 in `reclaimStaleLock()`. When `shouldReclaimLock()` returns false, yield unconditionally: `return false`.

**Tensions resolved**: HTTP-as-liveness eliminated. False kills made structurally impossible.  
**Tensions accepted**: Zombie-primary eviction degrades from ~5s to 2-min TTL.

**Boundary**: `reclaimStaleLock()`, Path A branch only (~10 lines deleted, 1 line net change).

**Why this boundary**: `shouldReclaimLock()` already embeds the correct liveness contract. The health check in Path A is an override with no valid justification.

**Failure mode**: A process SIGKILLed without running exit handlers leaves a stale lockfile. Next secondary waits up to 2 min for TTL eviction. **Severity: low** -- affects only dashboard availability, not MCP sessions.

**Repo-pattern relationship**: Restores alignment with the existing heartbeat/TTL liveness pattern. Restores `shouldReclaimLock()` pure-function contract.

**Gain**: Eliminates bug entirely. -10 lines. Illegal state removed.  
**Give up**: 2-min zombie window (acceptable for dev console).

**Scope judgment**: Best-fit.  
**Philosophy fit**: Full alignment. Honors 'architectural fixes', 'make illegal states unrepresentable', 'YAGNI'.

---

### Candidate B: Retry health check with backoff before SIGTERM
**Summary**: Replace single `checkHealth()` in Path A with 3 attempts (2s/4s/6s intervals). Only SIGTERM after all retries fail.

**Tensions resolved**: Reduces false positives. Zombie evicted in ~14s.  
**Tensions accepted**: Still kills under sustained load (tool call > 14s). Adds startup latency.

**Failure mode**: False kills still possible under sustained load. 12s startup delay when primary is genuinely dead.

**Scope judgment**: Too narrow (patches symptom).  
**Philosophy fit**: Conflicts with 'architectural fixes over patches', 'compose with small pure functions'.

---

### Candidate C: Replace health check with heartbeat re-read
**Summary**: Re-read lockfile and compare `lastHeartbeat` to initial read. SIGTERM only if heartbeat has not advanced in >60s despite a live PID.

**Tensions resolved**: Distinguishes 'busy' (heartbeat advancing) from 'zombie' (heartbeat frozen). Not dependent on HTTP event loop.  
**Tensions accepted**: More complex. 60s zombie window.

**Failure mode**: A process that stops writing heartbeats but stays alive (main thread spun but timer blocked). 60s eviction is acceptable.

**Relation to existing patterns**: Follows the heartbeat pattern in `DashboardHeartbeat.ts`. Consistent with existing design.

**Scope judgment**: Best-fit but more complex than needed.  
**Philosophy fit**: Partial. Mild conflict with 'YAGNI with discipline'.

---

## Comparison and Recommendation

| Criterion | A (remove gate) | B (retry health) | C (heartbeat re-read) |
|-----------|----------------|-----------------|----------------------|
| Eliminates false kills | Yes, fully | No, reduces only | Yes, fully |
| EADDRINUSE safe | Yes | Yes | Yes |
| Zombie eviction time | 2min (TTL) | ~14s | ~60s |
| Code delta | -10 lines | +20 lines | +15 lines |
| Failure severity | Low (console only) | Medium (kills possible) | Low (console only) |
| Philosophy alignment | Full | Conflicts | Partial |

**Recommendation: Candidate A.**

The zombie-primary scenario is already handled by `setupPrimaryCleanup()` which registers `process.on('exit')` to delete the lockfile synchronously. True zombies (SIGKILL without exit handler) are rare, and the 2-min TTL backstop is acceptable for a dev console. Candidate A is the only option that makes the illegal state structurally impossible.

---

## Self-Critique

**Strongest counter-argument**: A SIGKILL leaves a stale lockfile, causing a 2-min dashboard recovery delay. Valid -- but this is a rare edge case and the tradeoff is explicit.

**What would tip toward C**: Users regularly SIGKILL WorkRail processes and file issues about 2-min dashboard recovery. Not justified pre-emptively.

**What would tip toward B**: Nothing. B still allows false kills under sustained load.

**Invalidating assumption**: If `setupPrimaryCleanup()` is unreliable (e.g., OOM crashes skip exit handlers). Even then, the TTL backstop handles it within 2 minutes.

---

## Decision Log

**Winner: Candidate A**  
Remove lines 594-611 from `reclaimStaleLock()`. Replace with `return false`.

**Why A won**: `shouldReclaimLock()` already provides three independent, reliable liveness signals (version, TTL, PID). Adding HTTP as a fourth that can false-positive under load -- and treating it as grounds to SIGTERM -- is architecturally incorrect. The fix makes the illegal state (`reclaim=false` + SIGTERM) structurally unreachable.

**Why C lost**: Valid future enhancement but YAGNI. `setupPrimaryCleanup()` already handles the zombie scenario via lockfile deletion on exit. The 2-min TTL backstop is acceptable for a dev console.

**Why B lost**: Patches the symptom. False kills still possible under sustained load. Adds complexity with no correctness gain.

**Confidence**: High. Four adversarial challenges ran; none materially weakened Candidate A.

**Residual risk**: One. SIGKILL without exit handler leaves stale lockfile; 2-min wait for next secondary to reclaim. Low severity (console only, not MCP).

## Final Recommendation

**Fix**: In `src/infrastructure/session/HttpServer.ts`, `reclaimStaleLock()`, replace the `if (!reclaim)` branch (lines 593-611) with:

```typescript
if (!reclaim) {
  console.error('[Dashboard] Secondary mode: primary lock valid, yielding');
  return false;
}
```

**Also do**:
1. Add a comment on `shouldReclaimLock()` noting that health checks are intentionally absent from the `reclaim=false` path
2. Add a test: secondary with valid lock yields without SIGTERM regardless of HTTP health

**What NOT to do**: Do not touch Path B (the `reclaim=true` branch). SIGTERM there is correct and necessary to free the port for version upgrades.
