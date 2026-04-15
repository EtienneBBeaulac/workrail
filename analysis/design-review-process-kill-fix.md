# Design Review: WorkRail Process Kill Fix

**Design reviewed**: Candidate A -- remove health check and SIGTERM from `reclaimStaleLock()` Path A  
**Date**: 2026-04-08

---

## Tradeoff Review

**T1: Zombie primary (SIGKILL) waits up to 2 min for eviction**  
Acceptable. MCP sessions are unaffected. Dashboard is a local dev tool, not load-bearing. TTL eviction via Path B handles this correctly after 2 minutes. Becomes unacceptable only if dashboard becomes team-facing infrastructure.

**T2: No recycled-PID identity check in Path A**  
Acceptable. A non-WorkRail process cannot have written the heartbeat file -- the assumption is structurally guaranteed. If recycling somehow occurred, consequence is console unavailable for up to 2 min, not session corruption.

---

## Failure Mode Review

| Mode | Handling | Severity | Gap |
|------|----------|----------|-----|
| SIGKILL + stale lockfile | TTL eviction after 2min | Low | None |
| Recycled PID within heartbeat window | Secondary yields; TTL evicts after 2min | Low | None |
| Two simultaneous secondaries racing | Atomic wx write unchanged; now correctly neither kills the winner | N/A | None |

No failure modes identified that are unhandled or require additional mitigation.

---

## Runner-Up / Simpler Alternative Review

**Candidate C (heartbeat re-read)**: Reduces zombie window from 2min to ~60s. Not worth adding ~15 lines of async FS I/O for an edge case that only affects console availability, not MCP functionality. Viable future enhancement if 2-min window generates user complaints.

**Simpler variant of A**: Already at minimum complexity -- 10 lines deleted, 1 line net. No further simplification possible.

**Hybrid (A + C)**: Could add heartbeat re-read as a diagnostic log without SIGTERM. YAGNI. Add later if needed.

---

## Philosophy Alignment

| Principle | Status |
|-----------|--------|
| Make illegal states unrepresentable | SATISFIED -- `reclaim=false` + SIGTERM made structurally unreachable |
| Architectural fixes over patches | SATISFIED -- gate removed, not tuned |
| Compose with small, pure functions | SATISFIED -- `shouldReclaimLock()` pure-function contract restored |
| YAGNI with discipline | SATISFIED -- speculative fast-failover optimization removed |
| Validate at boundaries, trust inside | SATISFIED -- internal lockfile state trusted over external HTTP |

No conflicts. All five relevant principles unambiguously support this change.

---

## Findings

**GREEN** -- No RED, ORANGE, or YELLOW findings.  

The design is correct, minimal, and fully consistent with the codebase's stated invariants. The primary concern (zombie eviction delay) is a known and accepted tradeoff with low real-world impact.

---

## Recommended Revisions

1. **Update the comment on `shouldReclaimLock()`** (line 542) to explicitly state that the health check is intentionally absent from the reclaim=false branch, and why. Prevents future developers from "fixing" the missing check.

2. **Add a test** for the Path A fix: a secondary that starts with a valid lock (same version, fresh heartbeat, live PID) should yield without sending SIGTERM regardless of health check behavior.

---

## Residual Concerns

None blocking. One monitoring suggestion: add a `console.error('[Dashboard] Secondary mode: primary lock valid, yielding')` log line so operators can verify the fix is working in production without digging into the lock file.
