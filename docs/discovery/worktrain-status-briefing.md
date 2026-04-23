# WorkTrain Status Briefing -- Discovery

## Artifact Strategy

This document is a human-readable record of the discovery. It is NOT execution truth.

- **Execution truth lives in:** WorkRail session notes and context variables (survive chat rewinds)
- **This doc is for:** reading, sharing, reviewing -- a narrative artifact
- **Do not rely on this doc** for workflow resumption -- use WorkRail session state instead

**Capabilities confirmed:**
- File system access: available (Read, Glob, Grep, Bash)
- Delegation (WorkRail Executor subagents): available via nested subagent tool
- Web browsing: not probed (not needed -- all sources are local files)

---

## Context / Ask

**Stated goal (original):** Discovery: what data exists today that a 'worktrain status' plain-English briefing command could use -- and what's the gap between available data and what a user needs to feel informed?

**User context:** The user wants WorkTrain to be able to answer 'what are you doing and why' in plain language, like they can ask Claude Code. This is about replacing the chat interface with something WorkTrain can answer autonomously.

**Reframed problem:** WorkTrain cannot explain its own current state and intent in plain language, forcing users to either tolerate opacity or switch to an interactive chat interface to understand what is happening and why.

---

## Path Recommendation

**Recommended path: `full_spectrum`**

**Rationale:** The stated goal is a solution statement (a CLI command), but the task is primarily empirical -- we need to read real data files to determine whether data poverty or rendering is the binding constraint. `design_first` alone would miss the empirical grounding. `landscape_first` alone would not resolve the solution-vs-problem ambiguity. `full_spectrum` combines landscape grounding (what data actually exists) with reframing (is a pull command even the right mechanism, how does this relate to `worktrain talk`).

---

## Constraints / Anti-goals

**Core constraints:**
- Must work with data sources that exist today (no schema changes as a prerequisite for MVP)
- Must be implementable by a single developer as a CLI subcommand
- Must not require a running LLM for the minimum viable version (plain-text rendering only)

**Anti-goals:**
- Do not design a full observability platform -- this is a user-facing briefing, not a debug tool
- Do not conflate `worktrain status` with `worktrain talk` until the relationship is explicitly resolved
- Do not build notification/push infrastructure as part of this feature

---

## Landscape Packet

### Existing CLI Commands (`src/cli-worktrain.ts`)

| Command | What it does | Data source |
|---------|-------------|-------------|
| `init` | Guided setup wizard | Creates files |
| `tell <msg>` | Queue a message for the daemon | Writes `~/.workrail/message-queue.jsonl` |
| `inbox` | Read daemon messages | Reads/marks `~/.workrail/outbox.jsonl` |
| `spawn` | Start a workflow session non-interactively | HTTP POST `/api/v2/auto/dispatch` |
| `await` | Block until sessions complete | HTTP GET `/api/v2/sessions/:id` (polling) |
| `console` | Start the console UI HTTP server | Serves `dist/console-ui/` |
| `daemon` | Start/manage the daemon | launchd plist + daemon process |
| `logs` | Display daemon event log (follow mode) | `~/.workrail/events/daemon/<date>.jsonl` |
| `status <sessionId>` | Health summary for a session | `~/.workrail/events/daemon/<today>.jsonl` |

**Key finding:** A `status` command already exists -- but it requires a session ID and only reports mechanical health metrics (LLM turn count, failure rate, stuck detection), not a human-readable "what are you doing and why" briefing. There is no command that lists all active sessions with plain-English descriptions.

### HTTP API (`src/v2/usecases/console-routes.ts`)

| Route | Returns |
|-------|---------|
| GET `/api/v2/sessions` | Session list (via ConsoleService) |
| GET `/api/v2/sessions/:id` | Full session detail with DAG |
| GET `/api/v2/sessions/:id/nodes/:nodeId` | Node detail |
| GET `/api/v2/workflows` | Workflow catalog |
| GET `/api/v2/worktrees` | Git worktrees with session counts |
| GET `/api/v2/triggers` | Registered triggers |
| POST `/api/v2/auto/dispatch` | Fire-and-forget session start |
| GET `/api/v2/workspace/events` | SSE change stream |

**Key finding:** The HTTP API exposes DAG position and workflow catalog, but does NOT expose goal text, trigger metadata, queue state, event history, or session health metrics. A briefing command reading only the API would lack the "what" (goal) and "why" (trigger reason).

### Daemon Event Log (`~/.workrail/events/daemon/`)

One JSONL file per day. Schema of key event types:

**`session_started`**: `{ kind, sessionId, workflowId, workspacePath, ts }` -- identifies which workflow is running.

**`trigger_fired`**: `{ kind, triggerId, workflowId, ts }` -- identifies what caused the session to start.

**`tool_called`**: `{ kind, sessionId, toolName, summary, ts }` -- last tool call (useful for "stuck" detection and last activity).

**`step_advanced`**: `{ kind, sessionId, ts }` -- step count increment, but NO step name.

**What's present:** workflow ID, trigger ID, tool names/summaries, timestamps.

**What's absent:** goal text, step names, plain-language descriptions, estimated time remaining, human-readable status.

### Session Manifests (`~/.workrail/data/sessions/<id>/`)

Each session directory contains:
- `manifest.jsonl` -- segment metadata and snapshot pointers only (no semantic data)
- `events/` -- JSONL files with the actual event log per segment

**Goal text found:** in the `context_set` event (`data.context.goal`), which appears early in each session's event log. Quality is high -- full sentences like:
> "Discovery (user experience angle): what should the first coordinator script template look like from the user's perspective -- how does someone invoke it, what do they see, what does it produce?"

**Step names found:** ONLY in snapshot files (`data.enginePayload.engineState.pending.step.stepId`), not in the event log. Example: `"phase-0-reframe"`.

**What's present:** goal text (in `context_set`), workflow ID (in `run_started`), observations (repo root, branch, etc.), step name (in snapshots).

**What's absent:** step index / total step count, trigger provenance (who/what started the session), estimated time remaining.

### Queue and Outbox Files

- `~/.workrail/message-queue.jsonl` -- **does not exist**
- `~/.workrail/outbox.jsonl` -- **does not exist**

The `tell` and `inbox` commands reference these files but they are not present in the current runtime. The push/notification path Assumption 1 worried about does not exist in practice.

### Backlog Design Specs (`docs/ideas/backlog.md`)

Three highly relevant sections found:

**"Live status briefings" (Apr 15, 2026):** Full spec for `worktrain status --workspace <name>`. Describes a `build-status-briefing` routine (not a full workflow -- a single fast step) that reads: active sessions from session store (step, duration), queue state from `queue.jsonl`, recent completions from merge audit log, blocked items, milestone dependencies. Sample output shows 3 active sessions with plain-English descriptions, queue top-5, recently completed items, blocked/waiting items, upcoming milestones. **Key insight:** the spec says sessions need a brief "plain English description" maintained separately -- either extracted from goal text or generated when enqueued.

**"WorkTrain analytics" (Apr 15, 2026):** Analytics dashboard spec -- volume stats, time saved estimates, quality metrics. A different feature from status; concerns aggregated historical data, not live state.

**"Interactive ideation" (Apr 15, 2026):** `worktrain talk` spec. A conversational loop workflow that starts with a synthesized context bundle (session outcomes, open PRs, backlog items, in-flight agent state). The spec explicitly says: "This is also what the `worktrain talk` session uses as its opening context -- before any conversation, WorkTrain gives itself a briefing on the current state so it can answer questions accurately." Status IS the context bundle for talk.

### Assumption Resolution

**Assumption 1 (pull vs push):** Resolved -- `message-queue.jsonl` and `outbox.jsonl` do not exist. There is no push infrastructure. A pull command is currently the only viable path.

**Assumption 2 (data exists vs data poverty):** Partially resolved. The goal text IS there (high quality, in `context_set` events). But step names require reading snapshots (not just events), step counts are not tracked anywhere, and trigger provenance is only in daemon event logs (not session events). This is a **medium effort rendering problem** with some targeted data gap filling needed.

**Assumption 3 (status vs talk):** Resolved. The backlog spec explicitly states that status IS the opening context bundle for `worktrain talk`. They are the same data, different surfaces: status is read-only plain text; talk is interactive with LLM. Building status first is the right path -- it produces the context bundle that talk will consume.

### Contradictions Found

1. The existing `worktrain status <sessionId>` command reads daemon event logs, but new session data lives in the per-session event store (`~/.workrail/data/sessions/`). These are two different storage systems. A unified briefing needs to read from both -- or just from the session store, which has more data.

2. The step name is only in snapshots, not event logs. The existing `status` command (which reads event logs) cannot currently report which step a session is on.

### Evidence Gaps

- The ConsoleService internals (`src/v2/domain/console-service.ts` or similar) were not audited -- the actual shape of session detail returned by the HTTP API is unknown.
- Queue infrastructure (queue.jsonl, the trigger queue) was not fully audited.
- Snapshot read performance (reading snapshot files for step names) is unknown.

---

## Problem Frame Packet

### Users / Stakeholders

**Primary user:** A developer running WorkTrain autonomously -- has 1-10 sessions active at any given time, may check in after an hour or two away. Needs to quickly answer: "what is happening, is it going well, what's next?"

**Secondary user:** The developer at the moment of starting a new session -- wants confirmation that WorkTrain understood the goal and is executing the right workflow.

**Tertiary (future):** The `worktrain talk` conversational interface -- needs a pre-built context bundle to start an informed conversation without re-reading every session.

### Jobs / Outcomes

1. **Ambient awareness:** Without actively monitoring, understand what WorkTrain is working on at a glance (< 10 seconds).
2. **Intervention triage:** Quickly identify whether any session is stuck, failing, or needs human input -- vs running fine and needing nothing.
3. **Session grounding:** Before asking a follow-up question or queuing next work, get oriented on what's already in flight.
4. **Context seeding:** Provide WorkTrain's own conversational sessions with a pre-built briefing so talk starts informed.

### Pains / Tensions

**Pain 1 -- Identity opacity:** Session IDs like `sess_bumu5ljx...` are meaningless. The user cannot tell which session is which without opening the console.

**Pain 2 -- State opacity:** The existing `worktrain status <sessionId>` reports health metrics (LLM turns, tool call counts) not semantic state ("I am on step 4 of 8, writing integration tests").

**Pain 3 -- No aggregate view:** There is no command that says "here are all your running sessions" with anything except IDs.

**Pain 4 -- Two storage systems:** Daemon event log vs per-session store. Bridging them requires either reading two systems or accepting one system's incomplete picture.

**Tension 1 -- Freshness vs complexity:** Getting step names requires reading snapshot files (content-addressed, not indexed). This is safe but adds read complexity. Without it, step names are absent.

**Tension 2 -- Pull vs completeness:** A pull command captures state at a moment in time. If a session finishes between the user looking away and running status, it disappears from the output. Recent completions need a separate read.

### Success Criteria

1. A user with 3 active sessions reads `worktrain status` and correctly names what each session is working on -- without opening the console.
2. A user can identify a stuck session from status output (no recent tool calls, long elapsed time).
3. Output is valid and informative with zero active sessions (graceful empty state).
4. Output correctly reflects the current step name for sessions that have advanced past step 1.
5. A developer implements the command reading only today's data sources without schema migration.

### HMW Questions

- **HMW:** How might we surface goal text from `context_set` events without requiring the user to know the session event schema?
- **HMW:** How might we provide step context ("step 4 of 8") when step count is not tracked -- by reading the workflow definition for total step count and the snapshot for current step?

### Primary Framing Risk

**The framing assumes the `context_set` goal text is always the right "what and why" for a session.** But the goal field is set once at session start and never updated. If a session's direction changed mid-run (e.g., it pivoted based on discoveries), the goal text may be stale or misleading. If a significant fraction of sessions have stale goals, the status briefing becomes unreliable exactly when the user most needs it (complex, multi-step sessions). **Evidence to watch:** sessions with many `context_set` updates vs sessions where goal is set once and never revised.

---

## Candidate Directions

### Generation Expectations (before candidates are produced)

This is a `full_spectrum` pass. Candidates must:
1. **Reflect landscape constraints** -- not invent new data sources; only use what exists today (session store, daemon event log, HTTP API, workflow catalog, snapshot files)
2. **Span implementation depth** -- at least one minimal/fast candidate (what can be done in a day), at least one fuller candidate (complete per the backlog spec)
3. **Address the storage system choice** -- each candidate must explicitly state which storage it reads from (session store vs daemon log vs HTTP API) and accept the tradeoffs
4. **Treat status-as-talk-bundle as a design constraint** -- at least one candidate must show how the status output feeds into `worktrain talk`
5. **Do NOT require new infrastructure** -- no new event emission, no queue files, no schema changes as a prerequisite

*(Candidates to be populated by injected routine)*

---

## Challenge Notes

### Assumption 1: A pull command is the right mechanism
- Might be wrong: push/notification may already serve the 'feel informed' goal
- Evidence needed: outbox/message-queue usage patterns, event log completions without user awareness

### Assumption 2: Data exists -- this is a rendering problem
- Highest-risk assumption: event logs record mechanical facts, not semantic intent
- Evidence needed: direct inspection of session manifest 'goal' field quality

### Assumption 3: Status and talk are architecturally distinct
- Might be wrong: `worktrain talk` may already cover 'what are you working on' as a use case
- Evidence needed: backlog.md spec for both features

---

## Resolution Notes

*(To be populated)*

---

## Decision Log

### Selected Direction: Candidate A (CLI formatter over SessionSummaryProviderPort)

**Why it won:**
1. The data assembly is already done in `HealthySessionSummary` -- `sessionTitle` (goal), `pendingStepId` (step name), `lastModifiedMs` (stuck detection). No new projections needed.
2. No daemon required -- works file-only, unlike Candidate B.
3. Best-fit scope -- shippable in 1 day, satisfies 4/5 success criteria immediately.
4. Correct architecture -- uses v2 projection layer, neverthrow, DI. Resolves the philosophy conflict (existing `status` command uses daemon log; new command uses v2 layer).
5. The typed `StatusBriefingV1` intermediate type costs < 30 minutes but enables future `worktrain talk` integration without duplication.

**Why Candidate B lost:**
- Requires running daemon (usability regression for core 'check what's happening' use case)
- The 'reuse by talk' benefit is speculative -- talk doesn't exist yet
- 2-3 days implementation vs 1 day, same MVP output

**Why Candidate C was rejected:**
- Perpetuates daemon-log-reading pattern (wrong architecture)
- No goal text in output without changing the existing command's data source
- 'Architectural fixes over patches' principle directly violated

### Challenge outcome
The one genuine technical risk (port accessibility from CLI context) was investigated. `LocalSessionSummaryProviderV2` requires 4 ports (directoryListing, dataDir, sessionStore, snapshotStore). All are local file I/O adapters, instantiatable without the DI container. A small factory function `createStandaloneSessionSummaryProvider(dataDir: string)` resolves this cleanly. Challenge failed to kill Candidate A.

### Switch triggers
- If `worktrain talk` is prioritized in the next sprint: add the HTTP route as a parallel PR (Candidate B shape), reuse `buildStatusBriefing()` from both sides
- If step count ('of N') is a hard requirement: add workflow catalog read to `buildStatusBriefing()` (still Candidate A, small scope addition)
- If the port factory wiring turns out to require > 2 hours: consider calling the HTTP API instead (Candidate B shape for CLI, removing daemon dependency by starting the server if not running)

---

## Final Summary

### Recommendation: Candidate A -- CLI formatter over SessionSummaryProviderPort

**Confidence: HIGH**

#### What to build (Sprint 1 -- ~1 day)

1. **New file:** `src/v2/projections/status-briefing.ts`
   - Types: `StatusBriefingV1`, `ActiveSessionBriefing` (with discriminated union for goal: `{ kind: 'set'; value: string } | { kind: 'not_set' }`)
   - Pure function: `buildStatusBriefing(summaries: HealthySessionSummary[]): StatusBriefingV1` -- no I/O, fully testable
   - Stuck detection: `isStuck = (now - lastModifiedMs) > STUCK_THRESHOLD_MS` (suggest 15 min)

2. **New CLI subcommand:** `worktrain status` (no positional arg required)
   - Wires `LocalSessionSummaryProviderV2` via a small `createStandaloneSessionSummaryProvider(dataDir)` factory
   - Calls `buildStatusBriefing()` with loaded summaries
   - Formats to terminal output: one block per active session (goal, step, elapsed time, stuck warning)

3. **Rename existing command:** `worktrain status <sessionId>` → `worktrain health <sessionId>`
   - Prevents naming confusion
   - Part of the same PR

#### What the output looks like (sketch)

```
WorkTrain  [18 Apr 2026, 14:32]

ACTIVE (2 sessions)

  ● wr.discovery
    Discovery: what data exists today that a 'worktrain status' plain-English briefing command could use
    Step: phase-3-synthesize   Running 22 min
  
  ● wr.coding-task
    Implement GitHub polling adapter for Issues/PRs without requiring webhooks
    Step: phase-2-implement   Running 8 min   ⚠ no activity for 18 min

No items in queue.  Use `worktrain logs` to see recent completions.
```

#### What's deferred (Sprint 2)

- **Step count ('of N'):** Read workflow catalog to add 'step 3 of 8' -- 1-2 hours
- **Recently completed:** Scan daemon event log for `session_completed` events from last 24h -- 2-3 hours
- **HTTP API route:** Add `GET /api/v2/status/briefing` returning `StatusBriefingV1` -- needed when `worktrain talk` is prioritized

#### Status vs Talk relationship (resolved)

`worktrain status` is the read-only text rendering of `StatusBriefingV1`. `worktrain talk` will use `StatusBriefingV1` as its opening context bundle. Status is built first; talk consumes the same type. They are not separate features -- they are two surfaces of the same data structure.

#### Residual risks

1. **Port factory complexity:** `createStandaloneSessionSummaryProvider(dataDir)` must instantiate 4 local adapters. Low risk but unverified. Verify transitive deps at sprint start.
2. **`worktrain talk` timeline:** If talk is imminent (< 2 sprints), add the HTTP API route in Sprint 1 alongside the CLI command. User decision.
3. **Recently completed gap:** Most visible difference between MVP and the backlog vision. Users checking status after sessions complete will see an empty active list with no context about what just finished.
