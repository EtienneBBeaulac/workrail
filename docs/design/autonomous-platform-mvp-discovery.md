# WorkRail Autonomous Platform: MVP Discovery

> Design discovery for the autonomous WorkRail platform: minimum console changes, 12-month product vision, and competitive positioning. Generated: 2026-04-14.
>
> **Artifact strategy:** This document is a human-readable reference. Execution truth (decisions, rationale, open questions) is recorded in WorkRail session notes and context variables -- not in this file. This file may be out of date if the session was rewound; the session notes are always authoritative.

---

## Context / Ask

The goal is threefold:
1. Define the **minimum console changes** to make autonomous sessions visible and controllable (live view, pause/resume/cancel, real-time step progress)
2. Articulate the **full product vision** when daemon + triggers + evidence + live console all assemble
3. Establish **how WorkRail surpasses** nexus-core, OpenClaw, ruflo, and Devin in that 12-month vision

---

## Path Recommendation: `full_spectrum`

The dominant need is both landscape grounding (what exists in the codebase today) and reframing (what the product becomes). Neither a pure landscape audit nor a pure concept reframe is sufficient. The existing codebase is already sophisticated; the design question is where the minimum seam lies for the autonomous platform.

**Why not `landscape_first`:** We already have extensive context (ideas backlog, nexus comparison docs). The bottleneck is not understanding -- it's framing the coherent product arc.

**Why not `design_first`:** The MVP console changes are concrete code changes. Landing on the right design requires grounding in the actual component structure (SessionList, hooks, API layer, SSE, ConsoleService).

---

## Constraints / Anti-goals

**Hard constraints:**
- Console is currently read-only -- the MVP must introduce write operations carefully
- SSE infrastructure already exists (`/api/v2/workspace/events`) -- extend, do not replace
- React Query deduplication must be preserved -- no second SSE connection from new hooks
- The `ConsoleService` is stateless and read-only by design -- autonomous control endpoints need their own service class
- All new API routes must follow the `{ success: true, data: T }` envelope pattern

**Anti-goals:**
- Do not build the full daemon in the MVP -- the console changes must be useful even with manual autonomous sessions
- Do not change the existing token protocol -- autonomous sessions are regular sessions that happen to run without a human at the keyboard
- Do not require OpenClaw or pi-mono as dependencies -- WorkRail's autonomous mode must be freestanding
- Do not add a database -- the existing append-only event log is the source of truth

---

## Landscape Packet

### Ruflo competitive update (verified April 2026)

ruflo v3.5 (ruvnet/claude-flow, MIT, GitHub) -- "Enterprise AI Orchestration Platform":
- 16 specialized agent roles, 100+ pre-built agents, multi-LLM support (Claude/GPT/Gemini/Llama)
- SONA self-learning: pattern storage via HNSW-indexed vector memory, "sub-millisecond retrieval"
- Byzantine fault-tolerant consensus, hierarchical/mesh/ring/star topologies
- Claims "7-phase pipeline with 4 gates the model cannot bypass" (via `@claude-flow/guidance`) -- but this is prompt-based, not cryptographic
- Claims session persistence ("saves context across conversations") -- but no durable append-only event log
- Key claim to evaluate: "4 gates the model cannot bypass" is marketing; bypassing requires the agent to not call the gate tool, which is exactly what context pressure enables. WorkRail's HMAC token protocol makes the bypass mathematically infeasible, not merely instructionally discouraged.

### Existing WorkRail daemon infrastructure (from codebase depth audit)

**What already exists (ready to reuse):**
- `ExecutionSessionGateV2` -- central choke point: lock acquisition + health validation + witness minting. The daemon reuses this exactly via `gate.withHealthySessionLock(sessionId, fn)`.
- `SessionLockPortV2` -- OS-level exclusive file lock, cross-process safe, fail-fast. The daemon respects this lock natively since it calls `continue_workflow` through the gate.
- `ResumeSessions` usecase -- discovers resumable sessions; daemon can reuse for "find sessions needing continuation"
- `HttpServer` -- console + MCP run in the SAME Node.js process (confirmed). `DaemonRegistry` is in-process Map with no IPC needed. The server startup mounts routes via `mountRoutes()`; daemon mounts the same way.
- `mountConsoleRoutes()` pattern -- the daemon's control routes follow this exact pattern; a `mountDaemonRoutes(app, daemonRegistry)` function mounts alongside the console routes in `composeServer()`
- `ShutdownEvents` port -- daemon hooks into this for graceful teardown (not direct signal handlers)
- `ProcessLifecyclePolicy` -- daemon respects this; no signal handlers in test mode

**What does NOT exist (daemon must implement):**
- Daemon service class (the LLM API client + agent loop + session driver) -- net-new
- `DaemonRegistry` -- net-new (design exists in this doc)
- Control endpoints (pause/resume/cancel) -- net-new
- Trigger system (webhook/cron/CLI) -- net-new
- LLM tool call interception (before/after hooks) -- net-new
- `AbortController` usage in daemon -- only existing use is in remote-workflow-storage fetch timeout; daemon owns this pattern for its API calls

### Current console architecture (from source)

**Backend:**
- `ConsoleService` -- stateless read-only projections: `getSessionList()`, `getSessionDetail()`, `getNodeDetail()`
- `ConsoleServicePorts` -- 5 ports: `directoryListing`, `dataDir`, `sessionStore`, `snapshotStore`, `pinnedWorkflowStore`
- `mountConsoleRoutes()` -- mounts GET routes + SSE endpoint; returns `stopWatcher` disposer
- SSE: `/api/v2/workspace/events` broadcasts `{type: "change"}` on `.jsonl` writes; `{type: "worktrees-updated"}` on background enrichment completion
- File watcher: `watchSessionsDir()` watches sessions dir recursively, filters to `.jsonl` changes

**Frontend hooks / API:**
- `useSessionList()` -- React Query, key `['sessions']`, 30s poll, 25s stale
- `useSessionDetail()` -- React Query, key `['session', id]`, 5s poll, 3s stale
- `useWorkspaceEvents()` -- SSE client; on `{type: "change"}` invalidates `['sessions']`; on `{type: "worktrees-updated"}` invalidates `['worktrees']`
- `useSessionListRepository()` -- wraps `useSessionList()`, uses `isLoading` not `isFetching` to avoid background-refetch flicker

**Session list view:** `SessionList.tsx` -- search, sort, group, filter by status; `SessionCard` shows title, workflow, git branch, node count, status badge, health badge, last modified time

**Session detail view:** `SessionDetail.tsx` -- `SessionMetaCard` + per-run `RunCard`; `RunCard` has DAG tab + TRACE tab (when trace data exists); floating `NodeDetailSection` slide-in panel on node click

**DAG visualization:** `RunDag.tsx` (full) + `RunLineageDag.tsx` (lineage variant); ReactFlow-based; node kinds: step (gold), checkpoint (green), blocked_attempt (red); preferred tip gets gold glow

**Console types (`api/types.ts`):**
- `ConsoleSessionStatus`: `in_progress | complete | complete_with_gaps | blocked | dormant`
- `ConsoleRunStatus`: `in_progress | complete | complete_with_gaps | blocked`
- No `paused` or `cancelled` status exists yet -- needed for autonomous mode

**Key observation:** The console has no write path today. All mutation (advance, pause, cancel) would be net-new endpoints.

### Reference architecture synthesis

| Source | Stars | Key pattern for WorkRail |
|--------|-------|-------------------------|
| OpenClaw | 357k | `SessionActorQueue` per-session serialization; `RuntimeCache` idle eviction; `SpawnAcpParams` spawn interface; `AbortController` for cancellation; policy system (`isXxxEnabledByPolicy`) |
| pi-mono | 35k | `agentLoop`/`agentLoopContinue` pattern; `BeforeToolCallResult`/`AfterToolCallResult` hooks; `EventStream<AgentEvent>` for streaming; Slack bot as simplest channel integration |
| nexus-core | 11 (internal) | Phase transition enforcement; skills-as-slash-commands; per-repo context injection; multi-model routing |
| Claude Code | N/A | Pre-compact hooks; session memory as durable store; `PreToolUse`/`PostToolUse` hooks for evidence collection; subagent coordinator model |

**Critical insight from OpenClaw `RuntimeCache`:** The in-memory `Map<actorKey, {state, lastTouchedAt}>` with idle TTL is the right shape for tracking live daemon sessions. WorkRail's daemon equivalent: `Map<sessionId, {pid, startedAt, lastHeartbeatMs, status: 'running' | 'paused' | 'cancelled'}>`. This is the in-process state that the console live view reads.

**Critical insight from pi-mono `BeforeToolCallResult`:** WorkRail's evidence gating hook is exactly this. A `BeforeToolCallResult` that returns `{block: true, reason: "continue_workflow token required"}` is how you enforce that the agent cannot call `continue_workflow` without the required evidence. The daemon intercepts tool calls in this hook.

---

## Problem Frame Packet

### Primary users (by value, not by volume)

1. **Solo developer running scheduled maintenance** -- nightly dependency updates, security patches, test suite maintenance. Wants to wake up to completed changes with an audit trail. Success: verify 10 sessions in 5 minutes via summary, with drill-down available.
2. **Team lead batch-processing code reviews** -- 10-15 PRs overnight, consistent feedback without bottleneck. Success: check batch summary over coffee, spot-check 2 flagged decisions, release all feedback.
3. **SRE running diagnostic playbooks** -- health checks, incident runbooks at 3am or on alert. Success: faster MTTR, confidence nothing was missed, clear escalation triggers.

### The critical reframe (from user lens)

**Autonomous mode is NOT a real-time monitoring problem. It is an asynchronous verification problem.**

Users are not at the console when the daemon runs. They need "what happened while I was away" -- not "watch it happen live." The primary job is efficient post-execution verification and progressive trust-building over the first 10 sessions.

Implications for MVP:
- The `[ LIVE ]` badge matters less than the post-completion summary
- A "session health at a glance" view matters more than a real-time tool call stream
- Pause/cancel are edge case operations (distress signals), not primary UX

### The key tension

**"I need to trust it ran correctly" vs. "I don't want to read 10,000 lines of logs."**  
Design must enable: verify correctness in 30 seconds, drill down when suspicious. The existing DAG + node detail already provides the drill-down; the gap is the 30-second summary.

### Core question

What is the minimum seam in the existing console that (a) makes autonomous sessions visible for post-execution verification, and (b) provides pause/cancel as a safety net for the exceptional case when something looks wrong mid-run?

### The three facts that constrain the answer

**Fact 1: Autonomous sessions are already regular sessions.**  
A daemon-driven session produces the same event log as a human-guided session. `ConsoleService` already reads it. The list view already shows it with `status: 'in_progress'`. The only gap is: the console cannot tell the difference between "human is at the keyboard" and "daemon is running unsupervised." Both look like `in_progress`. The MVP's job is to make that distinction visible.

**Fact 2: The control actions (pause/resume/cancel) need a live daemon handle.**  
Pausing a session means sending a signal to the running process that has the active Claude API call. This is not a file operation -- it requires an in-process handle or an inter-process signal. The daemon must maintain a control socket, PID file, or in-memory registry that the console server can reach.

**Fact 3: Real-time tool-call progress requires a new event type or a new SSE channel.**  
The current SSE event `{type: "change"}` fires on `.jsonl` writes -- one event per step advance. Tool calls within a step do not produce `.jsonl` writes. To show "currently executing: Bash tool call #3" the daemon must push a separate real-time stream. The simplest implementation: a separate SSE endpoint (`/api/v2/sessions/:id/live`) that the daemon writes to via an in-process pub/sub.

### Reframe: what "live view" actually means at MVP

The MVP does not need millisecond-resolution tool call streaming. It needs:
1. A way to know which sessions have a live daemon process (the `is_autonomous` flag)
2. The current step label and step number of that running session (already derivable from `getSessionDetail`)
3. A control surface (pause / resume / cancel button) that sends a signal to the daemon

The 5-second `refetchInterval` on `useSessionDetail` already provides near-real-time step progress for the current step. What's missing is (1) the flag and (2) the control buttons.

### Critical risk: in-memory DaemonRegistry as source-of-truth violation

The in-memory `Map<sessionId, DaemonEntry>` approach creates the highest-risk single point of failure in the design. If the registry is wrong (crash, restart, stale entry), the `[ LIVE ]` badge is wrong, control buttons send signals to ghost sessions, and users cannot trust the console. This violates WorkRail's core principle: the append-only event log is the source of truth.

**Design response to this risk:** Make the registry a WRITE-ONLY cache of daemon state. The read path (is this session live?) should derive from the event log, not the registry. Specifically: the daemon appends `daemon_heartbeat` context updates to the session at each step start. `ConsoleService` reads the latest heartbeat timestamp; if it is within N seconds, the session is "live." The registry exists only to hold the `AbortController` for cancellation -- it is not the source of truth for liveness.

**Amended MVP design:** Two-track approach:
- **Liveness detection:** `context_set(daemon_heartbeat: "<ISO timestamp>")` at each step advance; if last heartbeat < 60 seconds ago AND session is `in_progress`, display `[ LIVE ]` badge. Crash-safe: if daemon crashes, no new heartbeat events are appended, badge disappears within 60 seconds.
- **Control actions:** `DaemonRegistry` holds `AbortController` only. The registry is ephemeral; it loses data on restart. That is acceptable because a restarted server cannot control sessions started before the restart -- those sessions are genuinely orphaned.

---

## Candidate Directions

### Direction A: Minimal flag + control actions (recommended for MVP)

**Summary:** Add an `isAutonomous` boolean to `ConsoleSessionSummary` and `ConsoleSessionDetail`. The daemon registers each running session in a new `DaemonRegistryService` that the console routes can query. Add three control endpoints (`POST /api/v2/sessions/:id/pause`, `POST /api/v2/sessions/:id/resume`, `POST /api/v2/sessions/:id/cancel`). Add a pause/resume/cancel button strip to the console session detail view. Real-time step progress uses existing `useSessionDetail` 5s poll (no new SSE channel needed for MVP).

**What "daemon registration" means:** When the daemon starts a session, it calls a new in-process method `daemonRegistry.register(sessionId, abortController, status)`. The console routes call `daemonRegistry.get(sessionId)` to determine if a session is live and to send control signals.

**Console changes (backend):**
1. Add `DaemonRegistry` service class -- in-process `Map<sessionId, DaemonEntry>` with `register/deregister/pause/resume/cancel/list` methods
2. Add `DaemonEntry` type: `{ sessionId, workflowId, goal, startedAtMs, lastHeartbeatMs, abortController: AbortController, status: 'running' | 'paused' | 'cancelling' }`
3. Extend `ConsoleServicePorts` with optional `daemonRegistry?: DaemonRegistry`
4. In `getSessionList()` / `getSessionSummary()`: if `daemonRegistry` is set, augment summary with `isAutonomous: boolean` and `daemonStatus: 'running' | 'paused' | 'cancelling' | null`
5. Mount three new POST routes in `mountConsoleRoutes()`:
   - `POST /api/v2/sessions/:id/pause`
   - `POST /api/v2/sessions/:id/resume`
   - `POST /api/v2/sessions/:id/cancel`
6. Add new SSE event type: `{type: "daemon-status-changed", sessionId, status}` -- broadcast when daemon status changes

**Console changes (frontend):**
1. Extend `ConsoleSessionSummary` and `ConsoleSessionDetail` types with `isAutonomous: boolean` and `daemonStatus: 'running' | 'paused' | 'cancelling' | null`
2. Add `useDaemonControl(sessionId)` hook -- wraps `POST` mutations, optimistic UI updates
3. In `SessionCard`: show `[ LIVE ]` badge (pulsing amber dot) when `isAutonomous && daemonStatus === 'running'`; show `[ PAUSED ]` badge when `daemonStatus === 'paused'`
4. In `SessionDetail`: add `AutonomousControlStrip` component -- three buttons `[ PAUSE ]`, `[ RESUME ]`, `[ CANCEL ]` visible only when `isAutonomous`. Show current step label + elapsed time.
5. In `useSessionListRepository`: subscribe to `daemon-status-changed` SSE event to trigger immediate re-render (no poll wait)

**Scope:** ~8 backend files changed, ~5 frontend files changed, ~2 new files. No schema changes, no new ports, no database.

**Limitations accepted:** Tool-call granularity requires a separate SSE channel (deferred to Next). The `DaemonRegistry` is in-process only -- if the server restarts mid-session, the daemon status is lost (acceptable for MVP; solve with heartbeat file later).

---

### Direction B: Typed SSE event stream per session (comprehensive but larger)

**Summary:** Add a per-session SSE endpoint (`/api/v2/sessions/:id/live`) that streams `AgentEvent` messages as the daemon executes: tool calls started/completed, step advanced, paused, cancelled, error. Frontend subscribes when viewing a session detail. Provides millisecond resolution but requires more infrastructure.

**Additional required pieces:**
- In-process pub/sub bus (EventEmitter or similar) keyed by sessionId
- Daemon writes to bus on each tool call; console routes read from bus and pipe to SSE client
- New `ConsoleAgentEvent` union type: `{kind: 'tool_call_started', toolName, args?} | {kind: 'tool_call_completed', toolName, durationMs} | {kind: 'step_advanced', stepLabel} | {kind: 'session_paused'} | {kind: 'session_cancelled'}`

**Verdict:** High value for observability, but wrong for MVP. The complexity is in the daemon side (emitting events for every tool call), not the console side. Direction A gives 80% of the user value with 20% of the work. Promote to "Next" after MVP ships.

---

### Direction C: File-based daemon heartbeat (simplest possible, but weaker)

**Summary:** The daemon writes a `daemon.json` heartbeat file into the session directory every N seconds. Console service reads `daemon.json` on each session load; if `Date.now() - heartbeatMs < 30_000`, the session is considered live.

**Verdict:** Elegant for detecting "is running" but insufficient for control actions (can't send pause/resume via a file). Also the file watcher emits a `.jsonl` change-only filter so `daemon.json` would not trigger SSE updates. Too limited for the control surface. Keep as a heartbeat persistence mechanism alongside Direction A.

---

## Challenge Notes

### Challenge 1: Daemon registration vs. console server lifecycle

The `DaemonRegistry` is in-process. If the console server and daemon are separate OS processes (not co-located in the same Node.js process), the registry must communicate via a socket, pipe, or shared file. The MVP assumption is that the daemon and console server share the same Node.js process -- valid if WorkRail's HTTP server hosts both the console API and the daemon. This assumption must be validated before implementation.

**Resolution:** In the MVP, start with the shared-process model. Design the `DaemonRegistry` interface such that it can be backed by an IPC socket later without changing callers. The interface is: `register(sessionId, entry) / deregister(sessionId) / get(sessionId) / list() / pause(sessionId) / resume(sessionId) / cancel(sessionId)`. The in-process `Map` is the first implementation; a Unix socket-backed implementation is the second.

### Challenge 2: The `isAutonomous` signal -- where does it come from?

A session created by the daemon vs. a session created by a human MCP call looks identical in the event log. The daemon must annotate the session at creation time to distinguish it. Options:
- (a) A new domain event `{kind: "autonomous_session_started"}` in the event log -- durable, visible in history, queryable without the daemon registry
- (b) A context variable `{key: "is_autonomous", value: "true"}` set at session start -- already in the event log as a `context_set` event; `ConsoleService` can project it from `projectRunContextV2`
- (c) Daemon registry only -- query the registry; fall back to `false` if session is not registered (not durable across restarts)

**Recommendation:** (b) is the right approach -- it uses an existing mechanism, requires no new event types, is durable across server restarts, and is queryable by `ConsoleService` without coupling to the daemon registry. The daemon calls `context_set` with `is_autonomous: "true"` and `daemon_goal: "<goal text>"` at session start.

### Challenge 3: Pause semantics

"Pause" in an autonomous session means "stop executing after the current tool call completes." It does not mean "abort the current LLM response mid-stream." The cleanest implementation: a cooperative pause flag that the daemon checks before each `continue_workflow` call. The daemon loop checks `daemonRegistry.isPaused(sessionId)` before advancing; if paused, it blocks the loop and emits a `{type: "daemon-status-changed", sessionId, status: "paused"}` SSE event. The session remains `in_progress` in the event log -- it has not advanced -- but the console shows it as paused.

**Outcome:** Pause = cooperative gate. Resume = release gate. Cancel = `AbortController.abort()` + deregister. The `blocked` status in the event log is already used for workflow-level blocking (not daemon-level pausing), so a new `paused` concept belongs in the `DaemonEntry`, not in `ConsoleSessionStatus`.

---

## Resolution Notes

### Chosen direction

**Direction A is the MVP.** The daemon registry is the minimal additional surface. The three control endpoints are the minimal write path. The `context_set` approach solves `isAutonomous` durably without new event types. The existing 5s session detail poll handles step progress visibility adequately for MVP.

### What "real-time step progress" means in practice

When a user is watching a live autonomous session in the detail view:
- `useSessionDetail` polls every 5 seconds -- each step advance (which writes `.jsonl` and triggers SSE) will surface within 5 seconds
- The current step label is visible as the preferred tip node's `stepLabel` in the DAG
- The step start time can be approximated from the node's `createdAtEventIndex` cross-referenced with `lastModifiedMs`
- "What tool calls have been observed" at MVP = the recap snippet of the current tip node (already available)

The gap vs. the stated goal: "real-time tool call observation" needs the Direction B event stream. At MVP, users see "which step is running" but not "which tool call within that step is running." This is explicitly deferred and explicitly acceptable.

### Console live view implementation plan (ordered)

**Phase 1 -- Visibility (no control, no new routes):**
1. Daemon calls `context_set(is_autonomous: "true", daemon_goal: "<goal>")` at session start
2. `ConsoleService.projectSessionSummary()` reads `is_autonomous` from `projectRunContextV2()` output
3. `ConsoleSessionSummary` gains `isAutonomous: boolean`
4. `SessionCard` shows `[ LIVE ]` pulsing badge for `isAutonomous && status === 'in_progress'`
5. Done. Zero new routes. Zero new ports.

**Phase 2 -- Control surface:**
1. `DaemonRegistry` class with Map-backed implementation
2. Three POST endpoints mounted in `mountConsoleRoutes()`
3. `useDaemonControl()` frontend hook
4. `AutonomousControlStrip` in `SessionDetail`
5. `daemon-status-changed` SSE event type

**Phase 3 -- Tool-call granularity (Next):**
1. Per-session SSE endpoint + in-process pub/sub bus
2. Daemon emits `tool_call_started / completed` events to bus
3. Frontend `useLiveSession()` hook subscribes to per-session stream
4. Live tool call log panel in `SessionDetail`

---

## 12-Month Product Vision

### What WorkRail becomes in 12 months

```
WorkRail Autonomous Platform (v3)

┌────────────────────────────────────────────────────────────────┐
│  Control plane (console)                                        │
│  ─ Session list with LIVE badges for autonomous sessions        │
│  ─ Per-session control: pause / resume / cancel                 │
│  ─ Real-time tool call stream (step granularity)                │
│  ─ Evidence viewer: required artifacts per step, observed tools │
│  ─ Workflow authoring: visual step editor, markdown input       │
│  ─ Trigger configuration: webhook setup, cron, CLI              │
└────────────────────────────────────────────────────────────────┘
         │                           │
         ▼                           ▼
┌──────────────────┐    ┌──────────────────────────────────────┐
│  Workflow engine  │    │  Autonomous daemon                    │
│  (existing)       │    │  ─ LLM call layer (Anthropic API)    │
│  ─ Durable state  │    │  ─ AgentLoop wrapper                  │
│  ─ HMAC tokens    │    │  ─ Evidence collection hooks          │
│  ─ DAG / trace    │    │  ─ Pre/PostToolCall gating            │
│  ─ Projections    │    │  ─ Session actor queue                │
└──────────────────┘    │  ─ Task flow chaining                  │
                         └──────────────────────────────────────┘
                                    │
              ┌─────────────────────┼──────────────────────┐
              ▼                     ▼                        ▼
   ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
   │  GitLab / GitHub  │  │  Jira / Linear   │  │  CLI / cron      │
   │  webhook triggers │  │  ticket triggers  │  │  manual triggers │
   └──────────────────┘  └──────────────────┘  └──────────────────┘
```

**The platform in prose:**

WorkRail in 12 months is the **open-source enforcement layer for autonomous AI agents**. It is the only platform that combines:

1. **Autonomous execution** -- a daemon that drives Claude (or any Anthropic model) through a structured workflow without a human at the keyboard
2. **Cryptographic step enforcement** -- every step advance requires a valid HMAC-signed token; the agent cannot skip steps even when running autonomously and even when context degrades
3. **Full session observability** -- every tool call, every step, every branch decision is visible in the console DAG and execution trace; nothing is a black box
4. **Durable cross-session state** -- sessions survive restarts, context compaction, and model upgrades; the event log is the ground truth regardless of what happens to Claude's context window
5. **Human-in-the-loop control** -- any autonomous session can be paused, inspected, and resumed from the console; pause/resume is first-class, not an afterthought
6. **Trigger-driven automation** -- GitLab MR opened, Jira ticket moved, cron schedule, CLI call -- any event can start a workflow; autonomous sessions are a natural extension of the existing session model
7. **Workflow chaining** -- a completed workflow A can automatically start workflow B with A's outputs as B's context; multi-step autonomous pipelines with no human intervention between stages
8. **Evidence-gated gates** -- steps that require human approval or required artifacts block until the evidence is present; the daemon cannot bulldoze through a verification gate

### The 12 milestones

**Q2 2026 (now-next, 0-3 months):**
1. **Autonomous daemon alpha** -- daemon drives Claude through a workflow via Anthropic API; single trigger type (CLI); produces regular session in existing event log
2. **Console live view Phase 1** -- `[ LIVE ]` badge; `isAutonomous` from context; no new routes
3. **Console live view Phase 2** -- pause/resume/cancel endpoints; `AutonomousControlStrip`

**Q3 2026 (3-6 months):**
4. **Webhook trigger system** -- GitLab MR webhook → workflow start; authenticated delivery; trigger registry in daemon config
5. **Evidence collection hooks** -- `BeforeToolCall` intercept; step evidence requirements declared in workflow JSON; daemon blocks `continue_workflow` until evidence is present
6. **Real-time tool call stream** -- per-session SSE; live tool call log in console

**Q4 2026 (6-9 months):**
7. **Task flow chaining** -- workflow A completion produces a chain artifact; daemon picks it up and starts workflow B; visible in console as linked sessions
8. **Compaction survival** -- WorkRail step notes injected into Claude session memory pre-compaction; daemon sessions survive context resets without losing workflow state
9. **Jira / Linear triggers** -- ticket status change → workflow start; bi-directional: workflow step can update ticket status

**Q1 2027 (9-12 months):**
10. **Multi-model routing** -- daemon can route steps to Sonnet (fast) vs. Opus (deep) based on step metadata in the workflow JSON; cost-aware routing
11. **Visual workflow authoring** -- step editor in console; drag-and-drop, prompt editing, loop configuration; outputs JSON
12. **Workflow marketplace** -- bundled + team + public workflows discoverable from the console; install/update from URL; WorkRail becomes the npm for AI workflows

---

## How WorkRail Surpasses Competitors

### Surpassing nexus-core

**nexus-core's ceiling:** Advisory prompts that an agent under context pressure can and will ignore. No durability -- session dies with the conversation. Human-initiated only -- no autonomous mode.

**WorkRail's advantage:**
- Where nexus-core has skill text, WorkRail has HMAC tokens -- mathematically unskippable
- Where nexus-core has one conversation, WorkRail has a durable append-only event log that survives compaction, model upgrades, and restarts
- Where nexus-core requires a human to start `/flow`, WorkRail starts autonomously on a webhook
- Where nexus-core's "learning capture" is a markdown file in a conversation, WorkRail's session notes are queryable structured artifacts in a session store

**The combinatorial play:** WorkRail can *run nexus-core phases as steps*. The nexus-vs-workrail comparison document already frames this as "C3: WorkRail meta-workflow wraps nexus-core phases." WorkRail doesn't compete with nexus-core's org integrations -- it enforces the phase gates around them. This is additive, not competitive.

### Surpassing OpenClaw

**OpenClaw's ceiling:** In-memory session store (24h TTL, lost on restart). No step enforcement -- tasks can be abandoned. No audit trail -- you can't reconstruct what the agent did. Task system is SQLite-backed but not cryptographically enforced.

**WorkRail's advantage:**
- **Durability:** OpenClaw's `RuntimeCache` is in-memory with a 24h TTL. WorkRail's session store is an append-only event log on disk -- sessions survive restarts, process crashes, and machine reboots.
- **Enforcement:** OpenClaw has no equivalent of WorkRail's HMAC token protocol. An OpenClaw task can be abandoned at any step. WorkRail steps cannot be skipped.
- **Auditability:** WorkRail's DAG + execution trace + node detail gives complete session forensics. OpenClaw has no session replay or audit trail.
- **Workflow composition:** OpenClaw has task strings. WorkRail has structured JSON workflows with loops, conditionals, assessment gates, and typed context.

**What WorkRail takes from OpenClaw (patterns, not code):**
- The `SessionActorQueue` per-session serialization pattern (prevent concurrent modification)
- The `SpawnAcpParams` interface shape (minimal spawn interface)
- The policy system (`isXxxEnabledByPolicy`) for daemon feature flags

### Surpassing ruflo

**ruflo's ceiling:** ruflo v3.5 now claims "4 gates the model cannot bypass" via `@claude-flow/guidance`. This is a prompt-based gate -- the agent is instructed to call the gate tool. Context pressure, model substitution, or adversarial prompts can cause the agent to skip it. There is no cryptographic binding between steps. The SONA self-learning system stores "what works" in a vector database, which means successful bypasses can be learned and repeated.

**WorkRail's advantage:**
- Every step in a WorkRail autonomous session is cryptographically enforced -- the daemon cannot say "I advanced" without a valid token
- WorkRail's DAG shows exactly what happened vs. what was supposed to happen
- WorkRail can pause any session and inspect every decision, tool call, and output
- ruflo is a coordination framework; WorkRail is an enforcement framework

**The framing:** ruflo is "get agents to do more things faster." WorkRail is "get agents to do the right things in the right order with proof." These are different products for different risk tolerances.

### Surpassing Devin / GitHub Copilot Workspace

**Devin's ceiling:** Closed-source, cloud-only, one model (opaque), black box execution. You cannot see what it did. You cannot enforce a process. You cannot self-host.

**GitHub Copilot Workspace's ceiling:** GitHub-only, no process enforcement, no session durability, no audit trail, no self-hosting.

**WorkRail's advantage:**
- **Open source, self-hosted:** Your data stays in your infrastructure. No vendor lock-in. Audit everything.
- **Any model:** Anthropic today, extensible to any provider via the pi-mono unified API pattern.
- **Process enforcement:** Copilot Workspace can implement however it wants -- WorkRail cannot skip steps by design.
- **Session forensics:** Every decision, branch, tool call, and output is queryable and visualizable in the console. Devin shows you a PR; WorkRail shows you why every decision was made.
- **Human control plane:** Any session can be paused and inspected. There is no equivalent in Devin or Copilot Workspace.

**The positioning:** WorkRail is for organizations that cannot put their IP into a closed-source cloud AI system and accept "trust the black box." It is the enforcement-first, audit-first, self-hosted autonomous agent platform.

---

## Challenge Review Findings

### BLOCKING Challenge 1: Heartbeat timer cannot hold session lock (RESOLVED)

**Finding:** The session lock (`ExecutionSessionGateV2`) is held for the entire duration of a step execution. A background timer trying to write heartbeat `context_set` events cannot acquire the same lock while the daemon holds it. This invalidates the "emit heartbeat every 30 seconds from a background timer" design.

**Resolution:** Heartbeats must be written within the daemon's existing write path, not from a separate timer thread. Specifically:
- Heartbeat is written at step START (daemon calls `context_set(daemon_heartbeat: "<ISO>")` before beginning the LLM call, while it holds the session lock for step setup)
- For steps that take longer than 60 seconds: the daemon writes heartbeats at each tool call result boundary (the daemon already processes tool calls one at a time; each tool result is a write boundary where the lock can be briefly acquired)
- The 60-second liveness window remains valid: any step that is actively executing tool calls will produce heartbeats at tool-call-result boundaries

**Alternative (simpler for MVP):** Store liveness in DaemonRegistry as `lastHeartbeatMs: number`, updated by the daemon at each tool call without lock contention. The ConsoleService reads from the registry for liveness (not the event log). The event log still records `is_autonomous: "true"` at session start for durability. The LIVE detection uses the registry `lastHeartbeatMs` for freshness. This is a pragmatic hybrid: `is_autonomous` is durable (event log), `lastHeartbeatMs` is ephemeral (registry).

**Impact on design:** The "liveness from heartbeat events" design must be amended. For MVP, the hybrid approach (durable `is_autonomous` in event log + ephemeral `lastHeartbeatMs` in registry) is the correct implementation. The registry stores one more field than previously designed.

### BLOCKING Challenge 2: STDIO transport assumption (NOT BLOCKING -- mis-scoped)

**Finding:** The challenge correctly identifies that STDIO mode (Claude Code using WorkRail as MCP server) does not have an HTTP server or DaemonRegistry. However, the challenge conflates two distinct WorkRail runtime modes:

- **MCP mode (STDIO/HTTP):** Claude Code is the agent; WorkRail is the MCP server providing tools. The daemon concept does not exist in this mode. WorkRail does not drive Claude -- Claude drives WorkRail via MCP tool calls.
- **Daemon mode:** WorkRail is the agent driver; it calls the Anthropic API directly and drives Claude through a workflow autonomously. This mode requires HTTP mode (it needs the console, the DaemonRegistry, and control endpoints).

These are mutually exclusive runtime modes. The autonomous daemon always runs in HTTP mode. STDIO mode continues to work exactly as today. No breaking change.

**Not a blocking issue.** The design is correct for daemon mode. STDIO mode users do not get autonomous mode.

### MEDIUM Challenge 3: Pause flag check location (RESOLVED -- mis-framed)

**Finding:** The challenge assumed the daemon runs inside Claude Code's harness and calls `continue_workflow` via MCP tool calls. This is incorrect for autonomous daemon mode. The daemon is a standalone WorkRail process that calls the Anthropic API and advances the session via the engine's in-process methods directly (not via MCP). The daemon has a direct reference to the DaemonRegistry (same process). The pause check is `if (daemonRegistry.isPaused(sessionId)) { await waitForResume(); }` called before the engine's `continueWorkflow()` method. No MCP hop required.

**Not a new issue.** Already resolved by the same-process design.

### MEDIUM Challenge 4: Cancelled session orphan (VALID, MITIGATED)

**Finding:** When the daemon is cancelled, the session remains `in_progress` in the event log. There is no mechanism to mark it as terminated.

**Resolution:** Leverage existing `dormant` status. WorkRail already has dormancy detection: a session that has been `in_progress` for more than 1 hour with no activity is displayed as `dormant`. When the daemon receives a cancel signal, it writes a `context_set(daemon_status: "cancelled")` event before deregistering. The dormancy threshold already handles the display. For users who want immediate "abandoned" status, the console can show `dormant` once the last heartbeat is > 60 seconds old (which happens immediately after cancel since no new heartbeats are emitted). No new terminal status required for MVP.

### LOW Challenge 5: LIVE badge spoofing (ACCEPTED)

**Finding:** Users can manually set `is_autonomous: "true"` via context_set MCP calls, causing the LIVE badge to show on non-autonomous sessions. Low severity because this requires deliberate user action and only affects their own sessions.

**Resolution accepted:** Document that `is_autonomous` is a daemon-reserved context key. The badge is best-effort, not a security boundary. No enforcement for MVP.

## Decision Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| How to mark autonomous sessions | `context_set(is_autonomous: "true")` at session start | Durable in event log, queryable by existing projections, no new event types |
| Liveness detection | HYBRID: `is_autonomous` from event log (durable) + `lastHeartbeatMs` from DaemonRegistry (ephemeral) | Pure event-log heartbeats blocked by session lock (Challenge 1); registry holds ephemeral freshness signal; event log holds durable autonomous flag |
| Pause semantics | Cooperative gate (check before in-process `continueWorkflow()` call) | Daemon runs in-process with DaemonRegistry; no MCP hop required; no LLM abort needed; reversible |
| Control endpoint method | POST (not DELETE/PATCH) | Simple, idempotent, consistent with REST conventions for actions |
| DaemonRegistry scope | In-process for MVP, socket-backed later | Avoids IPC complexity in MVP; interface design allows future migration |
| DaemonRegistry contents | `abortController` + `pauseFlag` + `status` + `lastHeartbeatMs` | Heartbeat timer cannot write to event log (session lock); registry is the freshness signal |
| Abandoned session handling | Use existing `dormant` status detection | When daemon cancels, no more heartbeats emitted; session becomes `dormant` within 60s naturally; no new terminal status for MVP |
| Tool-call granularity in MVP | Deferred (5s poll sufficient) | 80/20: step-level progress covers the primary use case; tool-level needs Direction B infrastructure |
| Autonomous runtime mode | HTTP mode only | Daemon mode requires console, control endpoints, persistent process; STDIO mode continues unchanged for human-driven sessions |
| `is_autonomous` field security | Best-effort, not enforced | Document as daemon-reserved; badge is informational, not a security boundary; MVP acceptable |

---

## Final Recommendation Summary

### Selected direction: Candidate 2 amended (hybrid liveness + C3 features absorbed)

**Confidence: HIGH**

The direction has been grounded in full codebase read, adversarially challenged, philosophy-reviewed, compared to alternatives, and had all tradeoffs explicitly accepted. No RED findings. Two ORANGE implementation improvements incorporated.

**Strongest alternative:** Candidate 3 (History Reframe) + Candidate 1 (Visibility Only). This combination serves the primary user job (post-execution verification) without any control infrastructure. It is the right Phase 1 but fails the safety net acceptance criterion. It is not the MVP.

**Residual risks (3, all LOW to MEDIUM, none blocking):**
1. Heartbeat interval is an implicit behavioral contract -- document in daemon implementation spec
2. Backend/frontend type sharing for `DaemonEntry` status -- add string literal union to `api/types.ts`
3. Control endpoint idempotency not specified for edge cases -- document 200/409 behavior before coding

**Pivot condition:** If daemon and console server run in separate processes (future containerization), the in-process DaemonRegistry requires a socket-backed implementation. The registry interface design accommodates this migration without changing callers.

---

## Final Summary

**Minimum console changes for MVP (ordered):**

1. Daemon writes `context_set(is_autonomous: "true")` at session start -- zero console changes, done in daemon
2. `ConsoleService.projectSessionSummary()` reads `is_autonomous` context key, adds `isAutonomous: boolean` to `ConsoleSessionSummary`
3. `SessionCard` adds `[ LIVE ]` pulsing amber badge when `isAutonomous && status === 'in_progress'`
4. `DaemonRegistry` class (in-process Map, ~50 lines)
5. Three POST control endpoints in `mountConsoleRoutes()`
6. `useDaemonControl()` frontend hook
7. `AutonomousControlStrip` component in `SessionDetail`
8. New `{type: "daemon-status-changed"}` SSE event type

**Total scope:** ~10 files, ~400 lines. No schema changes. No database. No new ports in `ConsoleServicePorts`. The existing session model, event log, and SSE infrastructure are reused throughout.

**12-month vision:** WorkRail becomes the open-source, enforcement-first autonomous agent platform -- the only system that combines autonomous execution, cryptographic step enforcement, full session observability, durable state, and human control. It surpasses OpenClaw (durability + enforcement), nexus-core (autonomous + durable), ruflo (enforcement vs. coordination), and Devin (open-source + self-hosted + auditable).

**The product moat:** WorkRail's moat is not the LLM integration (anyone can call the Anthropic API) or the workflow format (JSON is not a moat). The moat is **cryptographic enforcement + full session observability + durable state** combined in a single open-source platform. This combination is not a feature -- it is an architectural invariant that cannot be bolted on to existing systems.
