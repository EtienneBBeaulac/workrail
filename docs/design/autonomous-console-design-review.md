# Design Review Findings: WorkRail Autonomous Console Live View

> Concise, actionable findings for main-agent synthesis. Companion to `autonomous-console-design-candidates.md`.
> Generated: 2026-04-14 as part of wr.discovery workflow.

---

## Tradeoff Review

| Tradeoff | Acceptable under expected conditions? | What makes it unacceptable |
|----------|--------------------------------------|---------------------------|
| DaemonRegistry `lastHeartbeatMs` is ephemeral (lost on restart) | Yes -- liveness requires both `is_autonomous` (event log, durable) AND `lastHeartbeatMs < 60s` (registry, ephemeral). Post-restart: registry empty → lastHeartbeatMs null → no LIVE badge → correct behavior (daemon is also dead) | Daemon and console server run in separate processes (separate containers); daemon can survive a console restart |
| Cancelled sessions become dormant after 1 hour (no explicit `cancelled` status) | Acceptable for MVP single-user. LIVE badge disappears within 60s of cancel. Session shows `dormant` after 1h. | Multi-user reporting requirements; users need explicit `cancelled` status for filtering |
| LIVE badge is best-effort (users can spoof `is_autonomous` via context_set) | Yes for localhost single-user MVP | Multi-user/multi-tenant deployment where badge is a trust signal |
| Autonomous mode requires HTTP transport (not STDIO) | Yes -- the daemon requires the console and a persistent process. STDIO mode unchanged for human-driven sessions | WorkRail deprecates HTTP mode or autonomous users prefer STDIO; unlikely |
| Heartbeat timer cannot write to event log (session lock) | Resolved by hybrid approach -- heartbeat freshness stored in registry, not event log | N/A -- already resolved |

---

## Failure Mode Review

| Failure Mode | Design handling | Missing mitigation | Risk level |
|--------------|-----------------|--------------------|------------|
| LLM call exceeds 60s with no tool calls -- LIVE badge disappears | Accepted -- badge reappears after step completes and next heartbeat fires | Softer indicator for `is_autonomous + in_progress + last_heartbeat < 10min` (not 60s) for UX clarity | LOW |
| Daemon crash -- session in_progress for 1 hour | LIVE badge disappears in 60s; dormant after 1h | Shorter dormancy threshold for autonomous sessions (5-10 min vs. 1 hour) | MEDIUM |
| Cancel → POST succeeds but daemon checks pause flag after long step | Badge transitions to `pausing`; user sees intermediate state | UI must show `Pausing after current step...` not `Paused` immediately | MEDIUM (UX trust) |
| Daemon orphan on crash leaves session stuck in_progress | Mitigated by dormancy. No corruption, just display ambiguity | Configure autonomous dormancy threshold separately from human-session threshold | MEDIUM (UX) |

**Highest-risk failure mode:** Daemon crash creating 1-hour ambiguity window. Mitigation: shorten dormancy threshold for autonomous sessions (configurable via `WORKRAIL_AUTONOMOUS_DORMANCY_MS` env var, default 5 minutes vs. the 1-hour default for human sessions).

---

## Runner-Up / Simpler Alternative Review

**Runner-up (C3 Autonomous History Reframe) strengths absorbed:**
- `confidenceSignal: 'green' | 'yellow' | 'red' | null` on `ConsoleSessionSummary` -- derives from `isAutonomous + status` -- directly serves primary job (post-execution verification)
- `statusFilter: 'autonomous'` option in session list filter chips -- one-click batch review

**Simpler variant (C1 + C3 only, no DaemonRegistry) analysis:**
- Fails the "pause/cancel as safety net" acceptance criterion
- Without human control plane, WorkRail autonomous mode is indistinguishable from any other black-box autonomous agent
- The control plane is the product differentiator -- it cannot be deferred past MVP

**Hybrid DaemonRegistry implementation:** Module-level Map in `console-routes.ts` (like `sseClients`) is marginally simpler but harder to test. Proper class is ~10 more lines but injectable and testable. Class is the right choice.

---

## Philosophy Alignment

| Principle | Satisfied? | Notes |
|-----------|-----------|-------|
| Errors are data | YES | All registry methods and POST routes use `ResultAsync`/`.match()` |
| Make illegal states unrepresentable | YES | `DaemonEntry.status` is a 4-value closed union |
| Immutability by default | YES (with tension) | Registry state is mutable but confined behind class methods; callers receive `Readonly<DaemonEntry>` |
| Validate at boundaries | YES | POST endpoints validate before calling registry |
| YAGNI with discipline | YES | No trigger system, chaining, or multi-model routing in MVP |
| Type safety as first line | YES | Typed new fields, typed SSE event union |
| Compose with small pure functions | YES | `projectIsAutonomous()`, `isSessionLive()` are separate testable functions |
| Determinism | TENSION (acceptable) | `lastHeartbeatMs` is real-time clock state; `is_autonomous` in event log is deterministic |

**Tension that matters:** The hybrid liveness design (event log for `is_autonomous`, registry for `lastHeartbeatMs`) has a determinism tension. The event log path is fully deterministic; the registry path is not. This is explicitly accepted because the session lock prevents the fully-deterministic event log approach from working for freshness signals.

---

## Findings

### RED (blocking)

None. No finding requires blocking the selected direction.

### ORANGE (revise before implementation)

**ORANGE-1: Autonomous dormancy threshold must be configurable and set to 5 minutes by default**

The 1-hour default dormancy threshold (`DORMANCY_THRESHOLD_MS`) was designed for human-driven sessions. Autonomous sessions should have a much shorter threshold (5-10 minutes). A daemon that crashes should show `dormant` within minutes, not an hour. Revise: add `AUTONOMOUS_DORMANCY_THRESHOLD_MS` constant (default: 5 minutes) alongside the existing `DORMANCY_THRESHOLD_MS`. When `isAutonomous && nowMs - lastModifiedMs > AUTONOMOUS_DORMANCY_THRESHOLD_MS`, use the shorter threshold for `dormant` detection.

**ORANGE-2: Pause UX must show intermediate `pausing` state, not immediate `paused`**

If the POST /pause route returns 200 before the daemon acknowledges pause (which it will, since acknowledgment requires the current step to complete), the frontend must show `Pausing after current step...` as an intermediate state. Optimistic UI must transition to `pausing` status (not `paused`) immediately after the POST. Transition to `paused` only on receipt of `daemon-status-changed` SSE event with `status: "paused"`. Without this, users will think their pause button was ignored during long steps.

### YELLOW (monitor)

**YELLOW-1: LIVE badge false negative during long LLM calls**

The 60-second window is tight for steps with long LLM responses and no tool calls. Users may see the LIVE badge disappear and reappear for normal operation. Monitor for user confusion. If this causes issues, widen the detection window to 3-5 minutes (at the cost of slower crash detection). The widening can be done with a constant change.

**YELLOW-2: Registry-event-log divergence in multi-process deployments**

If a future deployment separates the daemon from the console server, the DaemonRegistry will be empty in the console server while the daemon is running. This will cause the LIVE badge to not show (false negative) and control actions to fail. Monitor for deployment scenarios that separate these processes.

---

## Recommended Revisions

1. **Add `AUTONOMOUS_DORMANCY_THRESHOLD_MS` to `console-service.ts`** (default 5 minutes). Use it when `isAutonomous === true` for dormant detection instead of `DORMANCY_THRESHOLD_MS`. Impact: ~5 lines in `projectSessionSummary()`.

2. **Implement `pausing` as an intermediate status in `AutonomousControlStrip`**. The component's local state tracks `'idle' | 'pausing' | 'paused' | 'cancelling'`. Optimistic update on POST → `pausing`. Transition to `paused` on `daemon-status-changed` SSE event. Impact: ~20 lines in `AutonomousControlStrip.tsx`.

3. **Absorb C3 features: add `confidenceSignal` to `ConsoleSessionSummary` and `statusFilter: 'autonomous'` to session list filter chips**. These directly serve the primary user job (post-execution verification) at near-zero cost.

4. **Add ORANGE-1 and ORANGE-2 revisions to the implementation plan** before coding begins. Both are ~10-20 lines each.

---

## Residual Concerns

1. **The heartbeat interval is implicit.** The daemon emits heartbeats "at each tool call result boundary" -- but this is a behavioral contract between the daemon and the console, not enforced by the schema. If the daemon implementation misses a heartbeat, the LIVE badge degrades silently. Consider making the heartbeat frequency a documented invariant in the daemon's implementation spec.

2. **The `DaemonEntry` type is in the backend.** The frontend's `ConsoleSessionSummary` has `isAutonomous: boolean` and the SSE event carries `status: DaemonEntryStatus` -- but the frontend has no way to validate that the status values it receives match the backend enum. A shared type definition or string literal union in `api/types.ts` would enforce this without a code generation step.

3. **Control endpoint idempotency is unspecified.** POST /pause on an already-paused session: should return 200 (idempotent) or 409 (conflict)? POST /cancel on an already-cancelling session: same question. The implementation should define and document these edge cases before coding. Recommendation: 200 for idempotent same-state requests; 409 for impossible transitions (e.g., resume a cancelling session).
