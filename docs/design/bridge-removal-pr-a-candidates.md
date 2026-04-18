# PR-A Bridge Removal -- Design Candidates

**Status:** Implementation ready. Single candidate; no genuine alternatives.
**Date:** 2026-04-17
**Scope:** PR-A only -- delete bridge-entry.ts, primary-tombstone.ts, bridge-events.ts; remove auto-bridge block from mcp-server.ts; remove tombstone/bridge-events call sites from stdio-entry.ts and http-entry.ts.

---

## Problem Understanding

### Core Tensions

**T1: Delete all bridge files vs keep http-entry transport intact**

`http-entry.ts` imports from both `primary-tombstone.ts` and `bridge-events.ts`. The task requires keeping `http-entry.ts` transport logic untouched while removing tombstone/bridge-events call sites from it. The seam is at the import level, not the file level.

**T2: Self-referential risk**

This MCP server is the tool running this workflow. A broken build would kill the active session. All changes must be made, build verified, then committed.

**T3: Logging loss**

`logBridgeEvent({ kind: 'primary_started', ... })` in both stdio-entry.ts and http-entry.ts records primary server startup for bridge forensics. After bridge removal this logging has no consumer. Removing it is correct but it is the only usage of bridge-events.ts in those files -- confirms the module is entirely removable.

### Likely Seam

The `import` statements at the tops of `mcp-server.ts`, `stdio-entry.ts`, and `http-entry.ts`. Removing those imports is what makes the TypeScript compiler verify that nothing references the deleted files at compile time. Any missed call site produces a build error rather than silent breakage.

### What Makes This Hard

Nothing architecturally hard. The main risk is a missed import or call site in a file not in the primary list (e.g. `src/mcp/index.ts` re-exporting from bridge-entry.ts). Must grep for all three module names before deleting. The `mcp-server.test.ts` test reads the source file as a string and checks for specific export patterns -- need to verify no assertion references `startBridgeServer` or `detectHealthyPrimary`.

---

## Philosophy Constraints

Sources: `/Users/etienneb/CLAUDE.md` and `docs/design/stdio-simplification-design-candidates.md` (philosophy table, lines 68-75).

| Principle | Constraint |
|---|---|
| Architectural fixes over patches | Delete the root cause (bridge block). No feature flag. |
| YAGNI with discipline | bridge-entry, primary-tombstone, bridge-events are all YAGNI once auto-bridge block is removed. |
| Determinism over cleverness | 150ms stdin probe, reconnect backoff, spawn coordinator lock -- all eliminated. |
| Make illegal states unrepresentable | `waitForStdinReadable` and `STDIO_CLIENT_PROBE_MS` have no callers after removal; deleting them prevents future misuse. |

**No conflicts** between CLAUDE.md and design doc for PR-A.

---

## Impact Surface

| Surface | Action | Reason |
|---|---|---|
| `src/mcp/transports/http-entry.ts` | Modify (tombstone/bridge-events call sites only) | Transport logic must stay intact |
| `src/mcp/transports/http-listener.ts` | No change | No bridge imports |
| `tests/integration/mcp-http-transport.test.ts` | No change | Tests MCP-over-HTTP, not bridge |
| `tests/unit/mcp/http-listener.test.ts` | No change | Tests createHttpListener lifecycle |
| `tests/unit/mcp-server.test.ts` | Review only | Checks source file exports as strings; confirmed no assertion for startBridgeServer |
| `src/mcp/index.ts` | Review before deleting | May re-export from bridge-entry.ts |

---

## Candidates

Only one genuine candidate. All alternatives (feature flag, deprecation shim, alias re-exports) contradict the explicit design doc and repo direct-deletion pattern. Noting this honestly.

### Candidate 1 (Only Candidate): Direct deletion with targeted import removal

**Summary:** Delete the 3 source files and 3 test files outright. Remove their imports and call sites from mcp-server.ts, stdio-entry.ts, and http-entry.ts. Update mcp-server.ts to call `startStdioServer()` unconditionally for stdio mode.

**Tensions resolved:** T1 (boundary is at import level, not file level -- transport logic untouched), T2 (minimal blast radius -- 6 files deleted, 3 modified), T3 (logging call sites removed along with the module).

**Tensions accepted:** None.

**Boundary solved at:** Import statements at the tops of mcp-server.ts, stdio-entry.ts, http-entry.ts.

**Why that boundary is best fit:** TypeScript compiler enforces correctness. Any missed call site produces a build error rather than silent breakage. The boundary is compiler-verified, not grep-and-hope.

**Failure mode:** A missed import in an unexpected file (e.g. `mcp/index.ts` re-exporting `startBridgeServer`). Mitigation: grep `src/ tests/` for `bridge-entry`, `primary-tombstone`, `bridge-events` before deleting.

**Repo-pattern relationship:** Follows direct-deletion pattern exactly. No flags, no shims. Every refactor in the git log (including PR #512) removes code directly.

**Gains:** ~1127 lines of dead code deleted. Startup becomes deterministic. No 150ms probe delay. No spawn coordinator lock files. No tombstone files.

**Gives up:** Nothing. Bridge functionality is superseded by standalone `worktrain console`.

**Scope judgment:** Best-fit. Exactly matches PR-A specification from design doc.

**Philosophy:** Honors architectural fixes over patches, YAGNI, determinism, make illegal states unrepresentable. No conflicts.

---

## Comparison and Recommendation

**Recommendation: Candidate 1.**

Only candidate. All alternative shapes add complexity without benefit and contradict the explicit design doc. Direct deletion is both the simplest and the architecturally correct approach.

---

## Self-Critique

**Strongest argument against:** Could keep `bridge-events.ts` as a general-purpose process lifecycle log (it does log `primary_started` which is not bridge-specific). Counter: the file's event vocabulary is overwhelmingly bridge-specific (`reconnected`, `spawn_primary`, `budget_exhausted`, `waiting_for_primary`). Keeping it would require renaming, refactoring the event union, and updating callers. Scope creep. Delete it.

**Narrower option:** Keep `primary-tombstone.ts` in place with no callers. Rejected: dead file with no callers is dead code; deleting makes the absence unrepresentable.

**Broader option:** Also clean up `worktrain-spawn.ts` and `worktrain-await.ts` which have a `dashboard.lock` fallback that will now be permanently dead code. Evidence from design doc: "No behavioral change, but the fallback is now permanently dead code." The design doc explicitly calls this a follow-up chore PR. Not in PR-A scope.

**Assumption that would invalidate:** `src/mcp/index.ts` re-exports `startBridgeServer` as part of public library API. Must verify with grep before deleting.

---

## Open Questions

None requiring human decision. All scoped by design doc. The single pre-implementation check (grep for unexpected importers) is a mechanical verification step, not a decision.
