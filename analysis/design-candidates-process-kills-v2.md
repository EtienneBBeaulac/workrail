# Design Candidates: WorkRail Process Kill Fix (v2)

**Note:** This is raw investigative material for main agent review, not a final decision.
Supersedes `design-candidates-process-kills.md` with updated candidate analysis.

---

## Problem Understanding

### Core Tensions

1. **Dashboard freshness vs. session continuity:** Version mismatch reclaim wants the dashboard to always serve the newest binary. But the process serving the newest binary also serves an active MCP session. Killing it for freshness destroys the session.

2. **Fast failover vs. false-positive kill:** 2s health check gives fast recovery from a crashed primary. But on a CPU-loaded Node.js event loop, 2s is not enough. HTTP response is blocked, `checkHealth` returns false, SIGTERM fires. The check cannot distinguish 'dead' from 'busy'.

3. **Election simplicity vs. lifecycle isolation:** Every WorkRail process participates in the election. This is operationally simple but means the election mechanism and MCP transport share the same process lifecycle. An election side effect (SIGTERM) destroys the transport.

4. **Observable failure vs. silent kill:** When SIGTERM fires, the user sees 'WorkRail killed' with no indication the election mechanism caused it. The failure is invisible until the session is gone.

### Likely Seam

`HttpServer.reclaimStaleLock()` in `src/infrastructure/session/HttpServer.ts`, specifically:
- Lines 593-611: non-reclaim path - fires when `shouldReclaimLock()` returns false but health check fails
- Lines 615-637: reclaim path - fires on version mismatch after `checkHealth()` confirms WorkRail on port

Both branches contain `process.kill(lockData.pid, 'SIGTERM')`. Both are the immediate trigger.

`shouldReclaimLock()` (lines 544-574) is a pure function and is NOT the bug. It correctly classifies lock states.

### What Makes This Hard

1. Two kill triggers with different causes and frequencies. Easy to fix one and miss the other.
2. The version mismatch SIGTERM has legitimate intent ('serve fresh assets'). It is easy to not question whether the intent justifies the mechanism.
3. The EADDRINUSE fallback in `startAsPrimary()` (lines 484-490) is the critical safety net for any fix that removes SIGTERM. Without it, removing SIGTERM would leave the new primary unable to bind port 3456 when the old process is alive. The fallback already exists and already works.
4. The fix removes code - counterintuitive as a 'bug fix' in many developers' mental model.
5. No tests exist for the `reclaimStaleLock()` path or the `shouldReclaimLock()` pure function.

---

## Philosophy Constraints

**Principles under active pressure:**
- `Architectural fixes over patches` - strongly favors removing the broken mechanism, not patching it
- `Make illegal states unrepresentable` - 'process under load' and 'process dead' are being collapsed to the same SIGTERM action; the fix must make 'kill a busy process' structurally impossible, not just less likely
- `YAGNI with discipline` - push back against over-engineering; no injected health checker interface or active-session marker files unless simpler options fail
- `Compose with small, pure functions` - `shouldReclaimLock()` is already the correct decision boundary; the imperative SIGTERM logic should be removed, not wrapped

**Conflicts in repo:**
- Stated: architectural fixes. Practiced: HttpServer.ts has 5+ 'BUG FIX' comment blocks accumulated over time.
- Stated: DI for boundaries. Practiced: `checkHealth()` uses hardcoded `fetch()`, not injected.

Architecture principle wins for this fix. The simplest architectural fix (remove SIGTERM) also removes the most code and introduces no new mechanism.

---

## Impact Surface

Must stay consistent:
- `tryBecomePrimary()` - only caller of `reclaimStaleLock()`. No change needed.
- `setupPrimaryCleanup()` - already handles 'received SIGTERM' gracefully via shutdownEvents. No change needed.
- `DashboardHeartbeat` - independent. No change needed.
- `startAsPrimary()` EADDRINUSE fallback (lines 484-490) - the safety net. Already exists. No change needed.
- Tests: `HttpServer.reclaimStaleLock()` has no direct tests. `shouldReclaimLock()` also has no tests. Fix must not break the broader `start()` test path.

---

## Candidates

### Candidate 1: Remove all SIGTERM and checkHealth from reclaimStaleLock()

**Summary:** Delete both `process.kill(pid, 'SIGTERM')` calls and all `checkHealth()` calls from `reclaimStaleLock()`. The function becomes: read lock -> `shouldReclaimLock()` -> if false return false, if true do atomic rename. Approximately 30 lines deleted.

**Tensions resolved:** Eliminates both kill triggers (load-based + version-mismatch). No new failure modes introduced.

**Tensions accepted:** Dashboard failover for alive-but-unresponsive primary takes up to 2 minutes (heartbeat TTL). Version-mismatched old primary may serve dashboard for up to 2 minutes.

**Boundary:** `HttpServer.reclaimStaleLock()` only. Two `process.kill()` calls (lines 603 and 630), three `checkHealth()` calls (lines 595, 608, 627), plus 2s wait blocks.

**Failure mode:** Zombie process holds port 3456. New secondary reclaims lock, gets EADDRINUSE, falls to legacy mode (port 3457+). Dashboard degrades but is functional. MCP is unaffected. This is handled by the existing EADDRINUSE fallback in `startAsPrimary()`.

**Repo pattern:** Adapts existing pattern - `shouldReclaimLock()` already expresses the full reclaim decision as a pure function. This candidate makes `reclaimStaleLock()` actually defer to that pure function rather than second-guessing it with a health check.

**Gain:** Eliminates entire class of proactive-kill bugs. Removes ~30 lines. `checkHealth()` private method becomes fully dead code and can also be removed.

**Give up:** Fast dashboard failover for alive-but-unresponsive primary (2s was never reliable anyway due to CPU load blocking).

**Scope:** best-fit. Touches only the two buggy code paths in the single function where both bugs live.

**Philosophy:** Honors 'architectural fixes over patches', 'make illegal states unrepresentable', 'YAGNI', 'compose with small pure functions'. Mild conflict with 'determinism over cleverness' (failover timing is max-bounded at 2 minutes but not instantly predictable).

---

### Candidate 2: Increase timeout to 10s + retry 3x

**Summary:** Change `checkHealth()` to retry 3 times with 10s timeout each (max ~30s total) before SIGTERMing. Both branches use the same retry logic. No structural change.

**Tensions resolved:** Reduces false-positive kills for load-based trigger (protects process under sustained load for <30s).

**Tensions accepted:** Does NOT address version mismatch trigger. In the reclaim path (lines 625-634), `checkHealth()` is used as a guard to confirm the port is still WorkRail BEFORE SIGTERM, not to decide WHETHER to SIGTERM. The version mismatch decision is already made by `shouldReclaimLock()`. Retrying the health check only delays the SIGTERM, it does not prevent it.

**Boundary:** `checkHealth()` method body only.

**Failure mode:** A process CPU-bound for >30s (long LLM operation) is still killed. The 192% CPU scenario that triggered the bug would be protected if the operation completes within 30s, but not otherwise. Version mismatch kills continue unaffected.

**Repo pattern:** Follows existing `checkHealth()` pattern. Minimal deviation.

**Gain:** Reduces load-based kill frequency. Easy to understand. Minimal code change.

**Give up:** Does not fix version mismatch trigger (the higher-frequency trigger for auto-update users). Adds up to 30s startup latency. Still fundamentally a point-in-time check.

**Scope:** Too narrow. Addresses only 1 of 2 kill triggers. Fails criterion 5.

**Philosophy:** Conflicts with 'architectural fixes over patches' (pure patch). Conflicts with 'make illegal states unrepresentable'. Honors 'YAGNI'.

---

### Candidate 3: Remove SIGTERM from non-reclaim path only; keep SIGTERM on version-mismatch with 3x retry (hybrid)

**Summary:** Non-reclaim path (`!reclaim` branch) becomes `return false` immediately. Version-mismatch reclaim path retains SIGTERM but retries `checkHealth()` 3x with 5s timeout each (max ~15s) before killing.

**Tensions resolved:** Eliminates load-based kill entirely. Reduces (but does not eliminate) version-mismatch kill frequency.

**Tensions accepted:** Version-mismatch SIGTERM still fires on every npm release, just after a longer delay (max ~15s). Active MCP sessions during npm upgrades are still at risk.

**Boundary:** `HttpServer.reclaimStaleLock()` non-reclaim branch + `checkHealth()` call in reclaim branch.

**Failure mode:** User is mid-workflow when a new npm version is picked up by `npx -y`. After a 15s health check retry window, SIGTERM fires and kills the session. Less frequent than current behavior but still happens for auto-update users.

**Repo pattern:** Partially adapts existing checkHealth guard pattern with retry. Departs from C1's full-removal approach.

**Gain:** Addresses the more obvious (load-based) trigger immediately. Preserves version-mismatch reclaim semantics if dashboard asset freshness is valued.

**Give up:** Active MCP sessions during npm upgrades are still at risk. More complex logic than C1. Does not satisfy criterion 5 (both triggers).

**Scope:** Slightly narrow - misses the version mismatch kill trigger.

**Philosophy:** Partially honors 'architectural fixes'. Does not honor 'make illegal states unrepresentable' (version mismatch can still kill a busy process). Conflicts with stated criterion 5.

---

## Comparison and Recommendation

### Matrix

| Criterion | C1 (remove all) | C2 (retry/timeout) | C3 (hybrid) |
|---|---|---|---|
| No active MCP session killed (non-negotiable) | YES | NO (version mismatch path) | PARTIAL (version mismatch path) |
| Dead processes still evicted | YES (TTL + PID) | YES | YES |
| Dashboard continues in some mode | YES (legacy fallback) | YES | YES |
| Fix is deletion not addition | YES (~30 lines removed) | NO (more code added) | PARTIAL |
| Addresses both kill triggers | YES | NO | NO |

### Recommendation: Candidate 1

C1 is the only candidate that fully satisfies all 5 decision criteria.

**Why C1 over C3:** C3 retains the version mismatch SIGTERM. For auto-update users, this is the higher-frequency trigger (fires on every npm release; 159+ versions published, multiple per day during active development). The intent of version-mismatch reclaim (fresh dashboard assets) does not justify killing an active MCP session. The 2-minute wait is acceptable.

**Why C1 over C2:** C2 does not address version mismatch at all. It only tunes a parameter within the broken mechanism. For users on `npx -y`, they continue losing sessions on every npm release.

**Convergence signal:** Three independent prior analysis rounds in `/Users/etienneb/git/personal/workrail/analysis/` all converge on this direction. The prior `design-review-findings.md` document also identified that `checkHealth()` becomes dead code once SIGTERM is removed - a secondary clean-up benefit.

---

## Self-Critique

**Strongest counter-argument:** The version mismatch reclaim has legitimate intent. With C1, a user running `npx -y workrail` in one tab will see the old-version dashboard for up to 2 minutes after a new version starts. During active development (multiple releases per day), the dashboard may often be slightly stale.

**Response:** Stale dashboard is a degradation; lost MCP session is data loss / work interruption. The tradeoff is clear.

**Pivot condition:** If the user confirms that dashboard freshness IS a hard requirement (e.g., a breaking schema change that makes old dashboard non-functional), then C3 (keep version-mismatch SIGTERM with retry) becomes justified. The question to ask: can an old-version dashboard process still serve sessions correctly even when the lock is held by a different version?

**Narrower option that lost (C2):** Fails criterion 5. Not a real option.

**Broader option that might be justified (separate dashboard process):** Would require proof that dashboard-embedded election is fundamentally incompatible with MCP session continuity even after SIGTERM removal. Current evidence does not show this.

**Assumption that would invalidate this design:** If WorkRail processes routinely enter permanently non-responsive states (infinite loop, deadlock blocking event loop for >2 minutes) without the heartbeat stopping. No evidence of this pattern. The observed 192% CPU was transient load, not an infinite loop.

---

## Open Questions for Main Agent

1. Is a 2-minute maximum dashboard failover gap acceptable? (This is the pivoting question)
2. Is dashboard asset freshness a hard requirement when a new npm version releases? Could an old-version dashboard serve sessions correctly?
3. Should the `checkHealth()` private method be deleted entirely (it becomes dead code) or left in place for possible future use?
4. Should test coverage for `shouldReclaimLock()` be added in the same PR as the fix, or deferred?
