# pi-mono Integration: Design Review Findings

**Review date:** 2026-04-14
**Design reviewed:** Candidate A hybrid (per-run Agent, subscribe once, mutable runState, steer() step injection)
**Status:** Actionable findings for main agent decision.

---

## Tradeoff Review

| Tradeoff | Verdict | Condition for failure |
|---|---|---|
| abort() best-effort for synchronous engine operations | ACCEPTABLE at MVP. Operations <200ms typical. | Network-dependent engine handlers added post-MVP |
| Per-run Agent construction ~1-5ms | ACCEPTABLE. MVP has 5 tools. Well under 1% of step time. | Tool set grows to 20+ tools post-MVP |
| KeyedAsyncQueue re-entry invariant documentation-enforced | ACCEPTABLE at MVP. No re-entrant calls in current design. | Developer adds queue-acquiring call inside tool execute() |

---

## Failure Mode Review

| Failure mode | Coverage | Missing mitigation | Risk |
|---|---|---|---|
| steer() called after isComplete | FULLY HANDLED by isComplete flag in runState | None needed | LOW |
| KeyedAsyncQueue re-entry deadlock | PARTIALLY HANDLED by documented invariant | Type-safe structural guarantee (post-MVP) | MEDIUM -- unrecoverable if triggered |
| abort() delayed by synchronous SQLite transaction | PARTIALLY HANDLED as best-effort | signal.aborted checks at I/O boundaries in engine handlers | LOW at MVP |

---

## Runner-Up / Simpler Alternative Review

**Runner-up (Candidate B: per-session + reset()):**
One strength worth adopting: subscribe once at session creation (not per run). Incorporated into the hybrid design.

**Simpler alternative (no subscribe/beforeToolCall):**
Saves ~50 LOC but loses evidence gating and console live view -- both MVP features. Not simpler enough to justify.

**Hybrid improvement adopted:** Agent created once per daemon session. subscribe() called once. mutable `runState` reference reset at start of each `runWorkflow()` call. This is mom's createRunner() pattern exactly.

---

## Philosophy Alignment

| Principle | Status | Notes |
|---|---|---|
| Immutability by default | SATISFIED | runState fresh per run; no cross-run contamination |
| Make illegal states unrepresentable | TENSION | isComplete + steer() is illegal state; boolean flag is weaker than type-safe state machine |
| Errors are data | ACCEPTABLE TENSION | throw/Result boundary explicitly managed in execute() wrapper |
| Determinism over cleverness | SATISFIED | No hidden shared state across sessions |
| Validate at boundaries, trust inside | SATISFIED | Engine handler validates token; daemon trusts the Result |
| Compose with small pure functions | SATISFIED | Three composable factories: createDaemonAgent, createContinueWorkflowTool, runWorkflow |
| YAGNI with discipline | SATISFIED | No compaction/retry at MVP; clear seams for later |

---

## Findings

### RED (Must fix before MVP ships)

None identified. No findings block the MVP design.

### ORANGE (Should fix before external users)

**O1: KeyedAsyncQueue re-entry constraint lacks structural enforcement**
The invariant "tool execute() must not call daemon handlers that queue on same sessionId" is documentation-only. A single violation causes an unrecoverable deadlock. For internal use, this is acceptable. For external users (workflow authors writing custom tools), structural enforcement is required.
**Recommended fix:** Type-safe wrapper that makes it impossible to acquire a queue slot from inside a tool execute() context. Alternative: reentrant queueing with ref counting.

**O2: isComplete state not type-safe**
The illegal state (isComplete=true + steer() call attempted) is prevented by a boolean flag but not by the type system.
**Recommended fix:** `WorkflowRunState` discriminated union (`running | complete | error`). Prevents isComplete=true + steer() at compile time.

### YELLOW (Polish before v1 release)

**Y1: abort() best-effort not documented in public API**
The daemon's `cancelSession()` REST endpoint should document that cancellation is best-effort and that the current synchronous operation will complete before the session stops.

**Y2: AbortSignal threading to engine handlers**
Engine handlers should accept an optional `AbortSignal` parameter and check `signal.aborted` before SQLite writes. This is a one-line addition per handler but requires signature changes.

---

## Recommended Revisions

**For MVP (ship as-is with these additions):**
1. Add `isComplete` boolean flag to runState (prevents steer() after completion)
2. Document KeyedAsyncQueue re-entry invariant in src/daemon/README.md or equivalent
3. Document abort() best-effort behavior in REST API response schema

**Post-MVP (before external users):**
1. Implement `WorkflowRunState` discriminated union (O2)
2. Implement structural KeyedAsyncQueue re-entry protection (O1)
3. Add AbortSignal parameters to engine handler signatures (Y2)

---

## Residual Concerns

1. **Tool set growth**: If WorkRail Auto tool set grows to 20+ tools, per-run Agent construction will exceed acceptable overhead. Monitor construction time in profiling. Pivot trigger: >10ms construction overhead in production config.

2. **Long-running engine handlers**: The best-effort abort() assumption holds only for fast synchronous operations. If future engine handlers make network calls, a dedicated async abort() protocol is needed.

3. **One Agent per trigger source vs one per run**: The hybrid design assumes one Agent per daemon session (trigger source). If multiple users share a daemon instance, session isolation requires one Agent per user (or per sessionId). This architectural question is deferred to the multi-tenancy design.
