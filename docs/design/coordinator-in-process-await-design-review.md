# Design Review: In-Process awaitSessions and getAgentResult

**Date:** 2026-04-19
**Candidate reviewed:** Candidate A from `coordinator-in-process-await-candidates.md`

---

## Tradeoff Review

**Tradeoff: `port` field made optional in `CoordinatorDeps`**
- Verified: `deps.port` is unused by all coordinator logic (grep returns zero results)
- Condition that invalidates: TypeScript errors showing `port` required elsewhere
- Mitigation: Run `npm run build` immediately; pivot to `port: 0` sentinel if errors appear
- **Verdict: Acceptable**

**Tradeoff: `null consoleService` fallback for missing `ctx.v2` ports**
- Verified: `createToolContext()` always provides non-null values in production
- Condition that invalidates: Not applicable in production path
- Mitigation: Warn on stderr + degrade gracefully to same all-failed behavior as current HTTP failure
- **Verdict: Acceptable**

**Tradeoff: Pending-Set polling over check-all-handles-every-poll**
- Verified: Terminal state transitions are monotonic (event log is append-only)
- Condition that invalidates: Not possible given ConsoleRunStatus projection semantics
- **Verdict: Correct and more efficient**

---

## Failure Mode Review

| Failure Mode | Handled? | Risk |
|---|---|---|
| `ctx.v2.dataDir`/`directoryListing` null | Yes -- null guard + graceful fallback | Low |
| Session not yet visible after spawnSession | Yes -- SESSION_LOAD_FAILED treated as retry | Low |
| TypeScript error from port optional | Partially -- pivot to sentinel if needed | Low |
| ConsoleService circular dependency | Yes -- dynamic import pattern | Low |
| getSessionDetail/getNodeDetail unexpected throw | Yes -- ResultAsync + outer try/catch | Low |

**Highest-risk**: TypeScript port optional change causing build failure. Pivot defined and trivial.

---

## Runner-Up / Simpler Alternative Review

**Candidate B** (port: 0 sentinel): Nothing worth borrowing. The only advantage was zero interface changes, but it introduces a dead required field with a misleading sentinel value.

**Simpler variant** (keep `port: DAEMON_CONSOLE_PORT`): Insufficient -- leaves dead code after removing the HTTP deps that needed it. Design doc explicitly lists port removal as required.

**No hybrid needed.**

---

## Philosophy Alignment

| Principle | Status |
|---|---|
| Architectural fixes over patches | SATISFIED -- root-cause fix, not workaround |
| Make illegal states unrepresentable | SATISFIED -- no sentinel, optional instead |
| Dependency injection for boundaries | SATISFIED -- ConsoleService gets ports injected |
| Immutability by default | SATISFIED -- minimal mutable state (pending Set only) |
| Errors are data | SATISFIED -- ResultAsync.isOk()/isErr() throughout |
| YAGNI with discipline | SATISFIED -- no speculative abstractions |
| Document "why", not "what" | REQUIRED -- add WHY comments in implementation |

One acceptable tension: null consoleService uses nullable variable rather than Result type. Acceptable at initialization boundary (not domain logic).

---

## Findings

**No Red (blocking) findings.**

**Orange (should address before shipping):**
- None identified.

**Yellow (advisory):**
- Y1: The `ctx.v2` null guard creates a nullable `consoleService` variable. If `ctx.v2` is ever null in production, the stderr warning may be missed. Recommend making the warning prominent: `[CRITICAL trigger-listener:reason=consoleService_unavailable]` prefix.

---

## Recommended Revisions

1. Add `[CRITICAL]` prefix to the `ctx.v2` null guard warning to make it visible in logs.
2. Add WHY comment on new `awaitSessions` explaining the in-process approach (mirrors the spawnSession WHY comment pattern).
3. Add WHY comment on `ConsoleService` construction explaining it avoids the HTTP race condition.

---

## Residual Concerns

- **None blocking.** The design is sound, the tradeoffs are acceptable, and the failure modes are covered.
- Build verification (`npm run build`) will immediately catch any TypeScript issues from the `port` optional change.
- The implementation is a near-direct transcription of the design doc pseudocode, reducing creative risk.
