# Design Candidates: WorkRail Autonomous Console Live View

> Raw investigative material for main-agent synthesis. Not a final decision.
> Generated: 2026-04-14 as part of wr.discovery workflow.

---

## Problem Understanding

### Core Tensions

**Tension 1: Ephemeral daemon state vs. durable event log**
The daemon is a running process -- inherently ephemeral. Its liveness can change at any moment (crash, pause, restart). The console's architectural invariant is that the event log is the source of truth. An in-memory registry that tracks liveness as process state will drift from the event log on any disruption. Resolution direction: derive liveness from the event log via timestamped heartbeat context events; use the registry only for ephemeral process handles (AbortController).

**Tension 2: Read-only console architecture vs. write operations needed for control**
The console server (`console-routes.ts`, `ConsoleService`) is stateless and read-only by design. All existing routes are GETs. The control actions (pause/resume/cancel) require write operations -- specifically, writing to the DaemonRegistry (in-process state), not to the event log. The event log must remain write-only from the daemon's perspective. The question is whether the console's read-only invariant is "never write anything" or "never write to the event log."

**Tension 3: Cooperative pause semantics vs. user expectation of immediate effect**
"Pause" in a cooperative model means "stop before the next step." If the current step is a 10-minute LLM API call, the button produces no visible effect for up to 10 minutes. This creates a trust gap. The design must communicate the difference between "pause command received" and "session is paused" with explicit intermediate state.

**Tension 4: Primary job (asynchronous verification) vs. secondary job (live control)**
The user research reframe: autonomous mode is an asynchronous verification problem, not a real-time monitoring problem. Users are not at the console when the daemon runs. They need "what happened while I was away," not "watch it happen live." The MVP risks over-indexing on the live monitoring UX (real-time tool call streaming, live badge) at the expense of the post-execution verification UX (session summary, confidence indicator, batch review).

### Likely Seam

**Primary:** `ConsoleService.projectSessionSummary()` in `console-service.ts` -- already reads `context_set` events via `projectRunContextV2()`. Heartbeat detection is 5 lines here. Additive, pure, no new ports required.

**Secondary:** `mountConsoleRoutes()` in `console-routes.ts` -- already the function that mounts all console routes. Control endpoints mount here. Same pattern as the existing session/workflow/worktree routes.

**Frontend:** `SessionCard` and `SessionDetail` in `console/src/views/` -- render `ConsoleSessionSummary` and `ConsoleSessionDetail` props. Both already handle the status/health badge rendering pattern that `[ LIVE ]` follows.

### What Makes This Hard

1. **The heartbeat frequency problem:** If the daemon only emits a heartbeat on each `continue_workflow` advance, long steps (10-minute LLM calls) leave a 10-minute gap. The 60-second detection window requires the daemon to emit heartbeats within a step -- via a timer, not just at step transitions.

2. **The `in_progress` ambiguity:** An `in_progress` session could be (a) human at keyboard, (b) daemon running, (c) human stepped away, (d) daemon crashed. The naive approach of adding a new `ConsoleSessionStatus` variant `'autonomous'` breaks existing consumers. The correct approach is an additive `isAutonomous: boolean` alongside the existing status.

3. **The session lock + pause interaction:** Pausing does not release the session lock. The daemon holds the lock while executing a step. Pause only prevents the next `continue_workflow` call. A developer who tries to "pause" by releasing the lock early would break the gate invariant (`ExecutionSessionGateV2` tracks re-entrance via `activeSessions`).

4. **The control endpoint authorization gap:** Any process with localhost access can cancel any session. For MVP (single-user localhost), this is acceptable. For production multi-user deployments, this is a security hole. The design must explicitly accept this limitation for MVP.

---

## Philosophy Constraints

**Relevant principles (from `/Users/etienneb/CLAUDE.md`):**

- **Errors are data** -- all new `DaemonRegistry` methods and POST route handlers must return `ResultAsync<T, E>` not throw exceptions. Pattern already established: `ConsoleService` uses `neverthrow` throughout.
- **Make illegal states unrepresentable** -- `DaemonEntry.status` must be a discriminated union `'running' | 'pausing' | 'paused' | 'cancelling'`. A `'paused'` session that then receives a `resume` command must transition through `'running'` -- not stay in `'paused'`.
- **Immutability by default** -- `DaemonEntry` should be immutable; updates create new entries. The registry's `set(sessionId, newEntry)` replaces entries, never mutates them in place.
- **Validate at boundaries, trust inside** -- the POST endpoint validates: session exists, is registered in DaemonRegistry, has status compatible with the requested action. Inside the registry method, no re-validation.
- **YAGNI with discipline** -- do not add trigger system, task flow chaining, or multi-model routing to MVP. These are explicitly `Later` items.
- **Type safety as first line of defense** -- the new `daemon-status-changed` SSE event type must be added to the SSE event union in `useWorkspaceEvents()` in a type-safe way. The frontend currently parses `msg.type` as `string` -- this should grow to a typed union or at minimum be handled exhaustively.

**Philosophy conflicts:**

1. **Immutability vs. registry state management:** The DaemonRegistry is inherently stateful and mutable. Resolved by: confine all mutation to the registry's own methods; callers receive `Readonly<DaemonEntry>` only.
2. **Read-only console invariant vs. control endpoints:** The console is read-only today by convention, not by architectural constraint. The POST control endpoints write to in-process DaemonRegistry state (not the event log). This is a bounded and acceptable departure: the console's API must be read-only with respect to durable state.

---

## Impact Surface

**Files that must stay consistent:**
- `src/v2/usecases/console-service.ts` -- primary change target (add `isAutonomous`, `lastHeartbeatMs` to projection)
- `src/v2/usecases/console-types.ts` -- `ConsoleSessionSummary` type change (add fields)
- `src/v2/usecases/console-routes.ts` -- add POST endpoints, new SSE event type
- `console/src/api/types.ts` -- frontend mirror of `ConsoleSessionSummary` (add `isAutonomous`)
- `console/src/views/SessionList.tsx` -- add `[ LIVE ]` badge to `SessionCard`
- `console/src/views/SessionDetail.tsx` -- add `AutonomousControlStrip`
- `console/src/api/hooks.ts` -- add `daemon-status-changed` SSE handling + POST mutation hooks

**Nearby consumers that must stay consistent:**
- `useSessionListRepository.ts` -- wraps `useSessionList()`, reads sessions; no change required if `isAutonomous` is additive
- `useSessionDetailViewModel.ts` -- wraps session detail; must pass `isAutonomous` and `daemonStatus` to `SessionDetail`
- `session-list-reducer.ts` -- filters and sorts sessions; `isAutonomous` should be filterable (add to filter options)
- `console-types.ts` backend and `api/types.ts` frontend must stay in sync (existing convention, no automatic codegen)

---

## Candidates

### Candidate 1: Visibility Only (Simplest Possible)

**Summary:** The daemon writes `context_set` events (`is_autonomous: "true"`, `daemon_heartbeat: "<ISO timestamp>"`) at session start and every 30 seconds. `ConsoleService.projectSessionSummary()` reads these via the existing `projectRunContextV2()` call. `ConsoleSessionSummary` gains two new fields: `isAutonomous: boolean` and `lastHeartbeatMs: number | null`. `SessionCard` shows a pulsing amber `[ LIVE ]` dot when `isAutonomous && status === 'in_progress' && lastHeartbeatMs !== null && Date.now() - lastHeartbeatMs < 60_000`. No new routes. No new ports. No DaemonRegistry.

**Tensions resolved:** Event-log-as-source-of-truth (fully -- liveness from heartbeat events only). Crash-safe (yes -- no heartbeat in 60s = badge disappears). Minimum new surface (best in class -- 3 files changed, ~40 lines).

**Tensions accepted:** No pause/cancel control (safety net absent). No post-execution confidence indicator (post-execution verification <30s partially met via existing session detail view). No real-time step progress beyond the existing 5s poll.

**Boundary solved at:** `ConsoleService.projectSessionSummary()` -- the single function that builds the session summary DTO. This is already the right place for all projection-level decisions about session status.

**Why this boundary is best fit:** It follows the exact pattern used by `deriveSessionTitle()` (reads context events), `projectRunStatusSignalsV2()` (reads status events), and `extractGitBranch()` (reads observation events). No new plumbing required.

**Failure mode:** The 30-second heartbeat interval creates a 30-90 second window where the badge can be stale (last heartbeat up to 30s old + 60s detection window = 90s maximum). If the daemon crashes at the 29-second mark, users see `[ LIVE ]` for up to 60 more seconds. This is the advertised crash-safety window; document it explicitly.

**Repo-pattern relationship:** Follows exactly -- pure event-log projection, no new infrastructure.

**Gains:** Zero infrastructure risk. Zero new routes. Clean event-log derivation. Safe to ship as Phase 1 with no breaking changes.

**Losses:** No pause/cancel. No post-execution confidence indicator. No batch "autonomous sessions" filter.

**Scope judgment:** Too narrow as a standalone MVP (users need the safety net), but correct as Phase 1 of a phased delivery.

**Philosophy fit:** Honors immutability, errors-as-data (no new error paths), YAGNI, validate-at-boundaries. No conflicts.

---

### Candidate 2: Visibility + Control (Follow Existing Pattern)

**Summary:** Builds directly on Candidate 1. Adds a `DaemonRegistry` class with `Map<SessionId, DaemonEntry>` where `DaemonEntry = { readonly sessionId: SessionId; readonly workflowId: string | null; readonly goal: string | null; readonly startedAtMs: number; readonly abortController: AbortController; readonly pauseFlag: { paused: boolean }; readonly status: 'running' | 'pausing' | 'paused' | 'cancelling' }`. Adds three POST routes to `mountConsoleRoutes()`: `POST /api/v2/sessions/:id/pause`, `POST /api/v2/sessions/:id/resume`, `POST /api/v2/sessions/:id/cancel`. Adds `AutonomousControlStrip` React component to `SessionDetail.tsx`. Adds `useDaemonControl(sessionId)` hook in `console/src/hooks/`. Extends the SSE event union with `{type: "daemon-status-changed", sessionId: string, status: DaemonEntryStatus}` broadcast when registry status changes.

**DaemonEntry status transitions:**
- `running` → `pausing` (on POST /pause)
- `pausing` → `paused` (when daemon cooperative check fires)
- `paused` → `running` (on POST /resume)
- `running | pausing | paused` → `cancelling` (on POST /cancel)
- any → deregistered (when daemon calls `daemonRegistry.deregister(sessionId)`)

**Tensions resolved:** All 5 criteria met. Liveness from heartbeat (event-log-as-source-of-truth). Crash-safe for liveness. Control actions for safety net. Post-execution verification via existing DAG + session detail.

**Tensions accepted:** DaemonRegistry is lost on server restart -- control actions for sessions started before the restart are unavailable. This is explicitly acceptable: a restarted server has no in-flight calls to cancel; those sessions' daemons are also dead or disconnected.

**Boundary solved at:** Two boundaries: (1) `ConsoleService.projectSessionSummary()` for liveness detection, (2) `mountConsoleRoutes()` for control endpoint mounting. Both are existing extension points.

**Why these boundaries are best fit:** Same reason as Candidate 1 for liveness. For control: `mountConsoleRoutes()` already accepts `consoleService`, `workflowService`, and optional `timingRingBuffer` -- adding `daemonRegistry?: DaemonRegistry` follows the same optional-dependency pattern.

**Failure mode:** A user presses `[ PAUSE ]`. The POST succeeds (HTTP 200). The daemon has a 10-minute LLM call in flight. The UI must show `Pausing after current step...` for up to 10 minutes before transitioning to `Paused`. If the UI shows `Paused` immediately after the POST (optimistic update without waiting for `daemon-status-changed` event), users may try to interact with a session that is not actually paused. Resolution: optimistic update to `pausing` state immediately, then `paused` on `daemon-status-changed` SSE event.

**Repo-pattern relationship:** Adapts -- follows `mountConsoleRoutes()` pattern for route mounting, `ConsoleServicePorts` pattern for optional dependencies, `usePerfToolCalls()` pattern for mutation hooks.

**Gains:** Full MVP feature set. Clean architecture. In-process DaemonRegistry avoids IPC complexity. Phased delivery (C1 first, C2 as increment).

**Losses:** More files changed (10 vs. 3). `DaemonEntry` mutability requires careful ownership (only `DaemonRegistry` mutates it). Registry is ephemeral -- acknowledged limitation.

**Scope judgment:** Best-fit for MVP. Grounded in existing patterns. Not over-engineered.

**Philosophy fit:** Honors errors-as-data (`ResultAsync` on all registry methods), make-illegal-states-unrepresentable (discriminated union for status), immutability (entries are `Readonly<DaemonEntry>`), validate-at-boundaries (POST routes validate before calling registry). Minor tension with YAGNI (DaemonRegistry is new infrastructure), but justified by user need for the safety net.

---

### Candidate 3: Reframe -- Autonomous History Tab

**Summary:** Reframes the MVP as post-execution verification, not live monitoring. Does NOT add a live badge, control buttons, or DaemonRegistry in Phase 1. Instead, adds an `Autonomous` filter option to the existing `StatusFilterOptions` in the session list. Sessions with `isAutonomous: true` (derived from context events) are filterable from the existing filter chips. Each autonomous session card shows an additional "confidence indicator" chip: `green` (complete), `yellow` (complete_with_gaps or blocked), `red` (dormant). Users can filter to all their autonomous sessions in one click and assess batch outcomes at a glance.

**New type additions:** `confidenceSignal: 'green' | 'yellow' | 'red' | null` on `ConsoleSessionSummary` (derived from `status + isAutonomous`). Zero backend changes beyond the heartbeat projection from Candidate 1.

**Tensions resolved:** Event-log-as-source-of-truth (fully). Post-execution verification <30s (best in class -- filter + confidence chip). Minimum new surface. Crash-safe.

**Tensions accepted:** No live badge (users cannot tell if a session is currently running). No pause/cancel control. Live monitoring is entirely absent.

**Boundary solved at:** `session-list-reducer.ts` for filtering + `ConsoleSessionSummary` for `confidenceSignal` derivation. Both are already the canonical places for session list processing.

**Why this boundary is best fit:** It directly serves the primary user job (batch post-execution verification) at the lowest possible surface area.

**Failure mode:** Users who want to intervene mid-session have no mechanism. If an autonomous session goes wrong (infinite loop, unauthorized action), users must wait for it to complete or manually kill the daemon process. This is the explicitly accepted limitation: "safety net absent."

**Repo-pattern relationship:** Follows -- the status filter chip pattern already exists in `SessionList.tsx`; adding a new filter option follows the existing `statusFilterOptions` array pattern exactly.

**Gains:** Serves primary user job directly. Zero new infrastructure. Clean.

**Losses:** No live monitoring. No control actions. Users who want a safety net must build it themselves (kill the process).

**Scope judgment:** Too narrow as a standalone MVP -- misses the users' expressed need for a safety net. Strong as a Phase 1 before Candidate 2, or as an alternative framing if user research shows the safety net is not a real need.

**Philosophy fit:** Perfect philosophy fit. YAGNI honored. No new infrastructure. Honors event-log source of truth.

---

### Candidate 4: Log-Based Control Signals (Architectural Departure)

**Summary:** Eliminates the in-process `DaemonRegistry` for control actions. Instead, the console POST endpoints write new control signal events directly to the session event log: `{kind: 'control_signal_appended', data: {signal: 'pause' | 'resume' | 'cancel', requestedAtMs: number}}`. The daemon reads the event log tail at each step boundary to detect control signals. No DaemonRegistry. No in-process state. Control signals are durable, survive server restarts, appear in the execution trace, and cannot be lost.

**New event type:** `CONTROL_SIGNAL_APPENDED` added to the domain event schema. New projection: `projectControlSignalsV2(events): Result<{pendingSignal: 'pause' | 'resume' | 'cancel' | null}>`.

**Tensions resolved:** Event-log-as-source-of-truth (strongest -- control signals ARE in the event log). Crash-safe (complete -- signals survive server restart). No ephemeral state.

**Tensions accepted:** Console writes to the event log -- this is a fundamental violation of the console's read-only invariant. The console's read-only constraint exists for a reason: no accidental session corruption, no race conditions between readers. Writing control signals from the console API breaks this invariant.

**Boundary solved at:** The domain event schema (`durable-core/schemas/session/`). Control signals become first-class domain events.

**Why this boundary is problematic:** The console-routes.ts has this comment: "GET-only (invariant: Console is read-only)". Candidate 4 violates this invariant. The risk is not just one technical concern -- it changes the security model, the test assumptions, and the ownership model of who can write to sessions.

**Failure mode:** A race condition between the console writing a control signal and the daemon reading it could cause the daemon to act on a stale signal (e.g., re-pausing after a resume was already processed). The daemon would need robust idempotent signal processing to handle this.

**Repo-pattern relationship:** Significant departure -- introduces console-to-event-log writes, which the entire console architecture explicitly prohibits.

**Gains:** Perfect source-of-truth alignment. Durable signals. No ephemeral state. Control signals visible in audit trail and DAG.

**Losses:** Breaks read-only console invariant. Requires new domain event type in durable-core schema. Requires new projection. Higher blast radius if the signal processing has bugs.

**Scope judgment:** Too broad for MVP -- introduces architectural changes to durable-core. Potentially correct for a future version where control signals should be auditable.

**Philosophy fit:** Honors event-log-as-source-of-truth but violates make-illegal-states-unrepresentable (now the console CAN write to sessions -- that's a new legal state) and validate-at-boundaries (the console API is now a write boundary to a previously read-only system).

---

## Comparison and Recommendation

| Criterion | C1 (Visibility) | C2 (Visibility + Control) | C3 (History Reframe) | C4 (Log Control) |
|-----------|:--------------:|:------------------------:|:--------------------:|:----------------:|
| Event-log source of truth | YES | YES | YES | YES (strongest) |
| Crash-safe | YES | YES (partial*) | YES | YES |
| Minimum new surface | BEST | GOOD | GOOD | WORST |
| Post-execution verification <30s | PARTIAL | PARTIAL | BEST | PARTIAL |
| Pause/cancel safety net | NO | YES | NO | YES (durable) |
| Philosophy fit | PERFECT | GOOD | PERFECT | FAIR |

\* C2 crash-safe qualification: liveness is crash-safe via heartbeat; registry is ephemeral for control actions (acceptable -- registry is not source of truth for liveness, only for AbortController handles)

**Recommendation: Candidate 2, delivered as C1 then C2.**

**Rationale:**
1. C2 satisfies all 5 decision criteria. C1 and C3 miss the safety net.
2. C2 follows existing repo patterns: `mountConsoleRoutes()` optional-dependency pattern, `ConsoleServicePorts` pattern, `usePerfToolCalls()` pattern for mutation hooks.
3. C4 is architecturally superior in theory but practically wrong -- it breaks the console's read-only invariant, which is the load-bearing architectural constraint that prevents console bugs from corrupting sessions.
4. C3's insight (autonomous filter + confidence chip) should be adopted INTO C2, not as a separate candidate. Add `confidenceSignal` to `ConsoleSessionSummary` and an autonomous filter option alongside the live badge and control strip.

**C3 insight absorbed:** Add `confidenceSignal: 'green' | 'yellow' | 'red' | null` to `ConsoleSessionSummary`. Derive from `isAutonomous && status`. Add `statusFilter: 'autonomous'` option to the session list filter chips. This serves the primary job (post-execution verification) at minimal cost.

---

## Self-Critique

### Strongest counter-argument against C2

The DaemonRegistry is a violation of WorkRail's "event log as source of truth" principle for the control action state. If the registry says a session is `pausing` but the session's event log has no `paused` signal, the system state is inconsistent. The counter-argument: this inconsistency only exists transiently (between when the user presses pause and when the daemon checks the pause flag). The event log does not need to represent transient control states -- it needs to represent permanent execution states. The daemon's cooperative pause check is designed to consume-and-clear the pause flag without logging it; the absence of a `pause_requested` event in the log is intentional.

### Narrower option that could still work

Candidate 1 (visibility only) + Candidate 3 (autonomous filter). This gives users post-execution verification without any write operations on the console. If user research shows that the safety net (pause/cancel) is not a real need in practice, this combination is sufficient and has the smallest possible surface area.

### Broader option that could be justified

Candidate 4 (log-based control signals) would be justified if: (a) multi-process deployment is a real requirement (daemon and console server in separate containers), and (b) auditability of control actions is required (e.g., compliance use case where "who paused this session and when" must be in the session record). Neither condition is present in the MVP.

### Assumption that would invalidate this design

The daemon and console server MUST be in the same Node.js process for C2's in-process DaemonRegistry to work. This was verified: `HttpServer` source confirms console + MCP run in the same process. But if a future deployment scenario separates them (e.g., console UI served from a CDN, console API as a microservice, daemon as a separate container), C2's DaemonRegistry would need to be replaced with a socket-backed or log-based implementation.

---

## Open Questions for the Main Agent

1. **Heartbeat frequency:** Should the daemon emit a heartbeat event at step START only, or also on a 30-second timer within a step? The timer approach requires the daemon to have a separate non-blocking timer running alongside the LLM API call. Is that complexity justified for the 60-second detection window?

2. **Confidence signal derivation:** C3's `confidenceSignal` (green/yellow/red) is derived from `status`. But the primary users (team lead reviewing PRs overnight) may want per-session evidence quality signals, not just completion status. Is `status → confidence` sufficient, or should there be a richer derivation?

3. **The `pausing` UX state:** When a user presses pause and the daemon is mid-step, the console should show `Pausing after current step...`. Should this be a badge variant, a tooltip, or a visible status row in `AutonomousControlStrip`? The answer is a UX decision, not an architecture decision.

4. **`POST` endpoint authentication:** The MVP explicitly accepts "any localhost process can cancel any session." Should there be a CSRF token or a session-ID-in-request-body check to prevent accidental misfire from browser extensions or other localhost services?

5. **The console read-only invariant:** Should `console-routes.ts` have an explicit comment documenting that the POST control endpoints are the ONLY exception to the read-only invariant, and that they write ONLY to in-process state, never to the event log? This would prevent future developers from adding additional console write routes without understanding the constraint.
