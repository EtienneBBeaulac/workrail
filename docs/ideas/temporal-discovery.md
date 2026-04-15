# Temporal.io Discovery: Architectural Patterns for WorkRail Auto

**Status:** Research in progress (Apr 14, 2026)

**Artifact strategy:** This document is for human reading. It is NOT execution truth. All durable findings live in WorkRail session notes and context variables. This doc is updated as a readable summary of findings -- if a chat rewind occurs, the notes survive, this file may not.

---

## Context / Ask

WorkRail Auto is being designed as an autonomous agent platform. The positioning anchor is "Temporal for AI agent process governance via MCP." Before locking in architectural decisions for WorkRail Auto's daemon, trigger system, approval gates, and versioning story, this discovery deep-dives on Temporal.io as the reference architecture for durable workflow execution.

Temporal is NOT a competitor -- it's the dominant open-source durable workflow engine with ~10 years of production deployment experience. Every architectural decision Temporal made has been battle-tested. WorkRail can learn from that without reinventing.

Secondary targets: Prefect and Dagster, briefly, for scheduled trigger system patterns.

**Goal:** Extract concrete "adopt / adapt / avoid" findings for WorkRail Auto from Temporal, Prefect, and Dagster.

---

## Path Recommendation

**`landscape_first`** -- the dominant need here is understanding Temporal's architecture deeply enough to extract specific patterns for WorkRail Auto. This is not a problem-framing exercise; the problem is clear. The landscape is what needs illuminating.

**Why not `full_spectrum`:** The problem statement ("what should WorkRail Auto take from Temporal?") is already well-framed in the backlog. Reframing is not the risk. Missing architectural details is.

**Why not `design_first`:** WorkRail Auto's concept is not in danger of being shaped wrong. The risk is implementation gaps, not concept-level errors.

---

## Constraints / Anti-goals

- **Anti-goals:**
  - Do not propose adopting Temporal's Go or Java SDK directly -- WorkRail is TypeScript
  - Do not propose replacing WorkRail's existing session engine -- the goal is to *inform* WorkRail Auto additions, not rewrite the core
  - Do not conflate Temporal's use case (deterministic code workflows) with WorkRail's (AI agent process governance) -- they are different domains
  - Do not recommend patterns that require Temporal's full infrastructure stack (Cassandra, Elasticsearch) -- WorkRail must stay freestanding

- **Core constraints:**
  - WorkRail must remain `npx -y @exaudeus/workrail` portable -- no heavy infra dependencies
  - Findings must be concrete enough to feed directly into daemon architecture decisions documented in `backlog.md`

---

## Landscape Packet

*Sources: TypeScript SDK source (`temporalio/sdk-typescript`), Prefect source (`PrefectHQ/prefect`), Dagster source (`dagster-io/dagster`), all read via `gh api` raw content fetches.*

---

### Temporal.io

#### 1. Event-Sourcing / Replay Model

**How it works:**

Temporal workflows run inside an isolated V8 VM (the "workflow context"). Every time a workflow resumes (after an activity completes, a timer fires, a signal arrives, etc.), Temporal replays the entire event history from scratch to reconstruct current state. The workflow code runs again from the top -- but this time "fast-forwarding" through already-completed steps.

**The Activator pattern** (`packages/workflow/src/internals.ts`):

The `Activator` class is the central state machine. It holds:
- `completions` -- Maps of task sequence numbers to `{resolve, reject}` pairs for pending timers, activities, child workflows, signals
- `bufferedSignals` / `bufferedUpdates` -- signals/updates received before a handler was registered
- `knownPresentPatches` -- patch IDs present in history (for versioning)
- `blockedConditions` -- pending `condition()` calls awaiting a predicate

During replay: the Activator drives the workflow code forward. When the code hits a `sleep()` or `proxyActivities()` call, it calls `pushCommand()` to queue a command -- but during replay, it matches that command against the history and immediately resolves the completion. Workflow code never "really waits" during replay; promises resolve synchronously from history.

**The key invariant:** `info.unsafe.isReplaying` (and `info.unsafe.isReplayingHistoryEvents`) marks when replay is active. Code can read this flag, but **must not change behavior based on it** -- doing so causes a determinism violation. The `unsafe` namespace is a deliberate warning: only use it for observability (logging), never for logic.

**What must be deterministic:**
- All timers (`sleep()`)
- All activity calls
- All random values (Temporal provides a seeded RNG via `alea.ts` that replays identically)
- `Date.now()` -- Temporal intercepts this and returns the timestamp from the first WFT in that workflow task, held constant for the entire task
- Child workflow start order
- Signal delivery order (buffered until handler registered)

**What must NOT happen inside workflow code:**
- Direct network calls
- Filesystem access
- `Math.random()` (use Temporal's seeded RNG instead)
- Actual `process.hrtime()` or wall-clock reads

**WorkRail comparison:**
WorkRail's session store (`src/v2/infra/local/session-store/`) is an append-only event log -- structurally similar to Temporal's history. WorkRail does NOT replay workflow code from scratch on resume; instead it uses the stored `continueToken` to pick up from the last committed step. This is simpler and sufficient for WorkRail's use case (AI agent sessions don't need deterministic replay because tool call results are inherently non-deterministic).

---

#### 2. Interrupt / Human-in-the-Loop Mechanism

Temporal has three mechanisms for external input:

**Signals** (`defineSignal` + `setHandler`): fire-and-forget. The sender doesn't wait for a response. The workflow registers a handler via `setHandler(mySignal, handler)`. Signals received before the handler is registered are buffered in `activator.bufferedSignals`. Signals are delivered as history events and replayed identically.

**Updates** (`defineUpdate` + `setHandler`): request-response. The sender waits for the workflow to process the update and can receive a result or validation rejection. Updates have a two-phase protocol: (1) validator is called synchronously (can reject early), (2) handler runs asynchronously. Temporal guarantees at-least-once delivery. In-progress updates are tracked in `activator.inProgressUpdates`.

**`condition(fn, timeout?)`**: blocks the workflow until a predicate becomes true (or timeout expires). Implemented as a `blockedConditions` map in the Activator -- after every activation, Temporal checks all blocked conditions and resolves any where `fn()` is now true. The `timeout` variant races a timer against the condition.

**The human-approval pattern in Temporal:**

```typescript
export async function approvalWorkflow() {
  let approved = false;
  let rejected = false;

  setHandler(approveSignal, () => { approved = true; });
  setHandler(rejectSignal, () => { rejected = true; });

  // Block until approved, rejected, OR timeout
  const completed = await condition(
    () => approved || rejected,
    '7 days'
  );

  if (!completed) throw new Error('Approval timed out');
  if (rejected) throw new ApplicationFailure('Rejected');

  // Continue with approved work...
}
```

The workflow is "paused" in the sense that it has no active WFT -- it's just a history entry in the Temporal server. No compute is consumed while waiting. When a signal arrives, a new WFT is scheduled and the worker picks it up, replays to the condition, and continues.

**WorkRail implication:** This is directly applicable to WorkRail Auto's approval gate design. WorkRail's equivalent should be a workflow step marked `requiresApproval: true` that:
1. Persists a checkpoint token to disk (already done via daemon token persistence in `backlog.md`)
2. Sends a notification (Slack, email, console badge)
3. Waits on a REST endpoint (`POST /api/v2/sessions/:id/resume`) before advancing

WorkRail already has the durability primitive (checkpoint token). The missing piece is the wait mechanism and notification dispatch.

---

#### 3. Activity / Workflow Separation

**The core principle:** Workflow code must be deterministic and side-effect free. All non-deterministic or side-effectful work goes in Activities.

**Activities** are plain TypeScript functions. They:
- Can make network calls, write files, call APIs
- Run on an Activity Worker (separate from Workflow Worker)
- Have retry policies (`scheduleToCloseTimeout`, `startToCloseTimeout`, retry policy with backoff)
- Can heartbeat (`Context.current().heartbeat(progress)`) -- allows long-running activities to report progress and survive worker restarts (heartbeat details are recorded in history and available at `activityInfo().heartbeatDetails` on resume)
- Receive cancellation via `AbortSignal` or by awaiting `Context.current().cancelled`

**`proxyActivities`** is how workflows call activities: it returns a typed proxy where calling `activities.myActivity(args)` records a `scheduleActivity` command in the Activator's command buffer. During replay, this resolves immediately from history without executing the activity again.

**`executeChild`**: Same principle for sub-workflows. Child workflow start is a command recorded in history; replay resolves it without re-executing.

**What maps to WorkRail:**
- Temporal's **Workflow** function = WorkRail's **workflow step prompt** (orchestration logic, deterministic control flow)
- Temporal's **Activity** = WorkRail's **tool calls** (side-effectful, retryable, can fail)
- WorkRail doesn't need replay determinism (AI agent calls are non-deterministic by nature), but it needs **the same isolation guarantee**: tool call results are persisted in session state and don't need to be re-executed on resume.
- WorkRail's `requiredEvidence` field (planned in `backlog.md`) is analogous to Temporal's heartbeat -- evidence of what actually happened, persisted to durable store.

---

#### 4. Worker Polling Model

**How it works:**

Temporal workers use **long-polling** against a task queue. The worker calls `pollWorkflowActivation()` (native Rust binding) which makes a gRPC long-poll request to the Temporal server. The server holds the connection open until a task arrives (or a timeout, typically 60s). When a task arrives, the worker processes it and immediately issues another poll.

Worker state machine: `INITIALIZED → RUNNING → STOPPING → DRAINING → DRAINED → STOPPED`.

**Sticky execution:** Workflow workers maintain an in-memory cache of workflow VMs (`maxCachedWorkflows`). When a workflow task arrives, if the cached VM is available, the workflow resumes without replaying from scratch (much faster). The server knows which worker has the sticky execution and routes tasks there. If the sticky worker is unavailable, the task falls back to a regular (non-sticky) poll, which requires full history replay.

**Worker identity and versioning:** Workers register with a `buildId` and optional `workerDeploymentOptions`. The `VersioningBehavior` on each workflow controls whether it stays pinned to the current build (`PINNED`) or auto-upgrades to the newest build (`AUTO_UPGRADE`).

**Graceful shutdown:**
- `worker.shutdown()` sets state to `STOPPING`
- No new polls are issued
- In-progress workflow tasks finish or timeout (configurable via `shutdownGraceTime`)
- Force kill after `shutdownForceTime`

**vs. WorkRail's daemon model:**
- Temporal: workers poll a server-managed task queue. Multiple workers can compete for tasks (horizontal scaling).
- WorkRail: daemon directly drives sessions -- no external server, no task queue.
- WorkRail's advantage: no network overhead, simpler operation, no polling latency.
- WorkRail's gap: no horizontal scaling story for the daemon (single process, single machine). Post-MVP consideration.
- For WorkRail Auto cloud: a task-queue pattern similar to Temporal's would enable multiple daemon instances to compete for work. The WorkRail session store + lock mechanism already supports this (the `LocalSessionLockV2` + workerId pattern in `backlog.md` is exactly the right primitive).

---

#### 5. Versioning Story

Temporal has two versioning systems (the old one deprecated in favor of the new):

**Old system: `workflow.patching(changeId)`** (`patchInternal` in `internals.ts`)

Logic:
```typescript
if (patched('my-change-id')) {
  // new code path
} else {
  // old code path
}
```

How it works:
- On first execution (not replay): `patched()` returns `true` AND records a `setPatchMarker` command in history
- During replay on NEW code: `knownPresentPatches.has(patchId)` is true (marker was in history), returns `true`
- During replay on OLD code (no patch marker in history): returns `false`, takes old path -- no non-determinism

This allows old workers and new workers to run the same task queue simultaneously. Old workflows replay on old path; new workflows take new path. The lifecycle:
1. Ship new code with `if (patched('change')) { newCode } else { oldCode }`
2. Wait for all old workflow executions to drain
3. Remove old code path, call `deprecatePatch('change')` -- now `patched()` always returns `true` without emitting a marker command

**New system: Deployment Versioning** (`worker-deployments.ts`)

Two behaviors:
- `PINNED` -- workflow stays on the same worker build forever unless manually migrated
- `AUTO_UPGRADE` -- workflow automatically moves to the newest deployment version on next task

Workers register with a `deploymentName` + `buildId`. The v1 workflow uses `AUTO_UPGRADE`, v2 uses `PINNED` (from the test files seen).

**WorkRail implication:** WorkRail has no versioning story at all for in-flight sessions. The minimal needed:
1. The `workrailVersion` field in workflow JSON (already planned in `backlog.md` as the "forever backward compatibility" feature)
2. For the daemon: when a new WorkRail version is deployed, in-flight sessions must complete on the version they started with, OR the new version must be backward compatible with their session state.
3. WorkRail's session store records all step completions -- this IS the history. On resume after a redeploy, WorkRail knows exactly which step was last completed.
4. The missing piece: WorkRail doesn't guarantee workflow schema backward compatibility for in-flight sessions. A workflow that changes between step 3 and step 4 could break a session that crashed after step 3. The minimal fix: **pin the workflow content at session start** (WorkRail already does this with `workflowHash` -- it validates the hash hasn't changed). For the daemon: store the full workflow JSON at session start, use that for the rest of the session.

---

#### 6. Temporal Cloud Namespacing (Multi-tenancy)

**A Temporal namespace** is the fundamental isolation unit. Per namespace:
- Separate workflow history
- Separate task queues
- Separate visibility (search, list)
- Separate rate limits and quotas
- Separate retention policies

Namespace is specified at the client level:
```typescript
const client = new WorkflowClient({
  connection,
  namespace: 'my-org.acct123' // default: 'default'
});
```

Workers also specify namespace:
```typescript
Worker.create({
  taskQueue: 'my-queue',
  namespace: 'my-org.acct123',
  // ...
})
```

On Temporal Cloud: namespaces are subdomain-routed (`<namespace>.tmprl.cloud:7233`). Each org gets one or more namespaces. Billing, rate limits, and data retention are per-namespace.

**WorkRail Cloud implication:**
- Namespace maps to `orgId` in WorkRail
- Per-org isolation needed: session store, workflow registry, credential vault, rate limits
- WorkRail's existing session store is file-system based (per-`dataDir`). Multi-tenancy = per-org `dataDir` with separate keyring entries
- The minimal multi-tenancy seam: every WorkRail session has an `orgId` context variable. The session store, lock, and credential vault are keyed by `orgId`. Single process can serve multiple orgs.

---

### Prefect

#### Scheduled Trigger Patterns

**Schedule types** (`src/prefect/client/schemas/schedules.py`):

1. **`IntervalSchedule`** -- fires every N seconds/minutes/hours/days. Anchored to a reference datetime. Handles DST: intervals < 24h follow UTC (no DST shift), intervals ≥ 24h follow local time (DST-aware).

2. **`CronSchedule`** -- standard cron string with timezone. Has `day_or` flag (whether day-of-month and day-of-week combine with OR (default, matches cron standard) or AND (like fcron)).

3. **`RRuleSchedule`** -- full iCalendar RRULE/RDATE/EXRULE/EXDATE support (most powerful, covers every recurrence pattern).

**How schedules are attached:** Schedules are attached to *Deployments* (the deployed version of a flow). A deployment can have multiple schedules. The scheduler service (`src/prefect/server/services/scheduler.py`) runs as a perpetual background service that:
1. Queries deployments needing runs scheduled (cursor-based pagination)
2. Generates scheduled runs up to `max_scheduled_time` ahead (configurable lookahead window)
3. Bulk-inserts the scheduled flow runs into the DB
4. Repeats on a configurable sleep interval

**Missed runs handling:** Prefect uses a lookahead window approach. The scheduler pre-creates flow runs in the DB up to `max_scheduled_time` ahead. If the service is down and a run's scheduled time passes, the run is in the DB as a scheduled run -- it will still execute when the agent picks it up (possibly late). The `catchup` field (added in a 2024 migration) controls whether to execute missed runs immediately or skip them.

**WorkRail relevance:** WorkRail's trigger system should pre-schedule autonomous sessions similarly to Prefect's model -- create a "pending session" entry in a durable store when a trigger fires, then have the daemon process pick it up. This decouples trigger reception from execution and survives daemon restarts. The Prefect lookahead window model (pre-insert runs N minutes/hours ahead) is a good pattern for cron-triggered WorkRail sessions.

---

### Dagster

#### Schedule / Sensor Patterns

**ScheduleDefinition** (`python_modules/dagster/dagster/_core/definitions/schedule_definition.py`):
- Cron-based only (no interval/rrule)
- Returns `RunRequest | SkipReason | RunRequestIterator` from evaluation function
- Has `default_status: DefaultScheduleStatus.RUNNING | STOPPED`
- `ScheduleEvaluationContext` provides `scheduled_execution_time` -- the scheduled time (not current time), enabling idempotent run generation

**Sensor pattern** (`sensor_definition.py`) -- Dagster's event-driven trigger system:
- A sensor runs on a configurable interval (default: 30s polling)
- `SensorEvaluationContext` provides a `cursor` -- an arbitrary string the sensor can update to track state between evaluations
- Returns `RunRequest` (create a run) or `SkipReason` (log why no run was created, but don't fail)
- `SensorResult` can include both run requests AND a new cursor value

The cursor pattern enables stateful event detection:
```python
@sensor(job=my_job)
def new_file_sensor(context: SensorEvaluationContext):
    last_seen = context.cursor or "0"
    new_files = get_files_after(last_seen)
    if not new_files:
        return SkipReason("No new files")
    latest = max(f.created_at for f in new_files)
    return SensorResult(
        run_requests=[RunRequest(run_key=f.name) for f in new_files],
        cursor=str(latest)
    )
```

**WorkRail relevance:** Dagster's sensor cursor model is directly applicable to WorkRail's webhook trigger system. Each trigger source (GitLab, Jira, GitHub) can be treated as a "sensor" with a durable cursor stored in WorkRail's state. The `RunRequest` equivalent in WorkRail is a pending daemon session start. The `SkipReason` equivalent is a logged "no match, skipping" entry. The key insight: **WorkRail's trigger system should be cursor-based** -- each trigger source stores its last-seen state, enabling replay of missed events after restarts without double-firing.

---

## Problem Frame Packet

### Primary Users / Stakeholders

| Who | What they need | Pain today |
|-----|---------------|------------|
| **Etienne (WorkRail author)** | Concrete architectural decisions for WorkRail Auto daemon, approval gates, versioning, and multi-tenancy before implementation | No systematic landscape research on durable workflow patterns -- risk of reinventing well-solved problems |
| **Future WorkRail Auto engineers** | Principled architecture that doesn't require rewriting core | Ad-hoc daemon design would accumulate technical debt |
| **WorkRail Auto users (orgs)** | Autonomous sessions that survive crashes, deploys, and long human approval waits | Current WorkRail: MCP-only, no autonomous mode, no approval gates |
| **WorkRail Auto cloud customers** | Isolated per-org data, credentials, and rate limits | No multi-tenancy story exists today |

### Core Tension

**Temporal's replay model assumes determinism. WorkRail's domain (AI agent tool calls) is inherently non-deterministic.**

Temporal's entire event-sourcing architecture -- the reason it can guarantee "exactly-once" semantics and resume from any crash -- depends on workflow code being deterministic. Replay the same events, get the same state.

WorkRail cannot adopt Temporal's replay model because AI tool calls are non-deterministic (the same prompt does not produce the same output twice). WorkRail must instead rely on its **token + session store** approach: persisted checkpoint tokens mark committed state, and the session store is the ground truth that survives crashes.

This is not a weakness -- it's the correct architecture for the domain. But it means WorkRail should take Temporal's *patterns* (human-in-the-loop, activity isolation, versioning strategy) without taking its *mechanism* (full history replay).

### Five Hard Problems (updated with landscape findings)

1. **Crash recovery / durability**
   - Temporal's answer: full history replay, Cassandra-backed event store
   - WorkRail's answer (correct): append-only session store + checkpoint token persistence to `~/.workrail/daemon-state.json` before each step (already planned in backlog)
   - Gap: token persistence before each step needs explicit implementation in `runWorkflow()`

2. **Human approval gates**
   - Temporal's answer: `condition(fn, timeout)` + Signal -- zero compute while waiting, server holds state
   - WorkRail's answer (to design): step marked `requiresApproval: true` + checkpoint token persisted + notification sent + REST endpoint `POST /api/v2/sessions/:id/resume` waits for approval
   - Gap: notification dispatch and timeout/expiry handling not yet designed

3. **Side-effect isolation (tool call persistence)**
   - Temporal's answer: Activities run separately, heartbeat progress to history, results replayed from history
   - WorkRail's answer (correct): tool call results are not re-executed on resume -- session store has the history, daemon just picks up from the last committed step
   - Gap: WorkRail needs the `requiredEvidence` field (planned) to enforce that tool calls happened before advancing

4. **Code deploy survival (workflow versioning)**
   - Temporal's answer: `patched(changeId)` for graceful migration, deployment-level PINNED/AUTO_UPGRADE behavior
   - WorkRail's answer (to design): pin the full workflow JSON at session start (workflowHash partially does this -- needs content pinning, not just hash verification)
   - Gap: a crashed session after a workflow redeploy currently has no recovery path -- WorkRail needs to store workflow content at session start

5. **Multi-tenancy**
   - Temporal's answer: namespaces -- each is an isolated data and compute partition
   - WorkRail's answer (to design): orgId as the namespace, per-orgId `dataDir` + credential vault key prefix
   - Gap: no orgId concept in WorkRail yet -- needs design for cloud tier

### Success Criteria

1. Each Temporal pattern area has a concrete "adopt / adapt / avoid" decision with rationale
2. Each decision maps to a specific WorkRail Auto component (daemon loop, approval gate, versioning, trigger system, multi-tenancy seams)
3. The Prefect/Dagster findings produce at least one actionable trigger-system pattern for WorkRail
4. No finding recommends adopting Temporal's full infra stack (Cassandra, Elasticsearch, temporal server)
5. Findings are concrete enough to update `backlog.md` with specific implementation guidance

### Framing Risks

1. **"Temporal for AI agent governance" is a positioning anchor, not an architectural constraint.** The analogy is useful for explaining WorkRail externally, but should not drive us to adopt Temporal's internals. Risk: over-indexing on replay model because it "should" match the positioning.

2. **Temporal's human-in-the-loop mechanism may be over-engineered for WorkRail's MVP.** Temporal's signals/updates are designed for high-throughput, long-running workflows at scale. WorkRail's approval gates for v1 can be much simpler (just a REST endpoint + flag in session state). Risk: designing a full Temporal-equivalent signal system before it's needed.

3. **The Prefect/Dagster comparison may push toward a database-backed trigger system too early.** Both Prefect and Dagster use PostgreSQL/SQLite for run scheduling. WorkRail must stay portable (SQLite at most, filesystem preferred). Risk: copying their persistence model without adapting for WorkRail's constraints.

### HMW Questions

- **How might WorkRail achieve "zero compute while waiting for human approval" without a long-running process holding a connection open?** (Answer: persist checkpoint token to disk, process exits, resume endpoint triggers re-execution from token)
- **How might WorkRail version running workflows without requiring a Cassandra-backed event store?** (Answer: store full workflow JSON snapshot at session start; always execute against the pinned snapshot, never the current registry version)

---

## Candidate Directions

*Candidate generation requirements for this `landscape_first` / `THOROUGH` pass:*
- Candidates must clearly reflect landscape precedents (Temporal patterns, Prefect/Dagster patterns)
- Candidates must account for the core constraint: no heavy infra, non-deterministic AI tool calls
- For each of the 4 pattern areas (durability, human-in-the-loop, versioning, trigger system): present at least 2 options that differ meaningfully in approach, not just detail
- One candidate per area should represent "closest Temporal analog adapted for WorkRail" and one should represent "simplest correct approach for WorkRail's constraints"
- Must address the riskiest assumption: step-level vs. sub-step-level durability

*Candidates to be populated in next step.*

---

## Challenge Notes

*To be populated if challenges arise.*

---

## Resolution Notes

*To be populated.*

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-14 | Path: `landscape_first` | Problem is clear; landscape illumination is what's needed |
| 2026-04-14 | Candidate A (DaemonStateStore): ADOPT | Minimal code, follows repo atomic-write pattern, correctly out-of-band from session lock |
| 2026-04-14 | Candidate B (Approval Gate): ADOPT v2 | Requires workflow schema + engine changes; correct design but post-daemon-MVP |
| 2026-04-14 | Candidate C (Versioning): ALREADY SOLVED | `PinnedWorkflowStorePortV2` + `pinnedWorkflow` in execution context already handles this. `continue_workflow` uses pinned snapshot. Zero new code needed. |
| 2026-04-14 | Candidate D (Trigger Cursor): ADOPT | Cursor-based sensor model (Dagster-adapted) is the correct design for daemon restart safety |

---

## Final Summary

### Discovery outcome: Temporal patterns for WorkRail Auto

This discovery confirmed the positioning anchor ("Temporal for AI agent process governance via MCP") is architecturally sound, but clarified the exact translation. WorkRail should take Temporal's **invariants** without Temporal's **mechanisms**.

### The central insight

**Temporal's replay model is not applicable to WorkRail.** Temporal's entire event-sourcing architecture depends on workflow code being deterministic. AI agent tool calls are inherently non-deterministic. WorkRail's checkpoint token + append-only session store is the correct architecture for the domain -- not a compromise, but the right design for AI agent governance.

The correct Temporal-WorkRail translation table:

| Temporal concept | WorkRail equivalent | Status |
|-----------------|--------------------|----|
| Event history / event sourcing | Append-only session event log | Already implemented |
| Workflow WFT (task token) | Checkpoint token (`ct_` / `st_`) | Already implemented |
| `condition(fn, timeout)` | `approvalGate` step field + REST resume | To design (Candidate B) |
| Activity heartbeat | `requiredEvidence` field | To implement |
| Deployment versioning (PINNED) | `PinnedWorkflowStorePortV2` + `workflowHash` | **Already implemented (verified)** |
| Namespace (multi-tenancy) | `orgId` prefix in `dataDir` + credential vault | To design for cloud tier |
| Worker polling | Direct in-process engine calls | Already implemented (daemon model) |

### Four design decisions

**Decision 1: Daemon crash recovery (Candidate A)**
Build `DaemonStateStore` port + implementation. Persist `{ sessionId, continueToken, stepIndex, approvalGate? }` to `~/.workrail/daemon-state.json` using atomic temp\u2192rename write before every `continue_workflow` call. ~80 LOC. Build first.

**Decision 2: Workflow versioning (Candidate C)**
Already solved. `PinnedWorkflowStorePortV2` + `pinnedWorkflow` in execution context handles this completely. Verified in `src/mcp/handlers/v2-advance-core/outcome-success.ts` and `src/mcp/handlers/v2-workflow.ts`. Zero new code needed.

**Decision 3: Trigger system (Candidate D)**
Build cursor-based trigger system (Dagster sensor pattern adapted). `TriggerSourcePortV2<TEvent, TCursor>` port + `TriggerCursorStore` + `CronTrigger` + `GitLabMRTrigger`. ~200 LOC (simplified from 300 -- generic dispatcher deferred). Trigger event ID as workflowId for idempotency.

**Decision 4: Human approval gates (Candidate B)**
Post-daemon-MVP. `step_approval_pending/received/timeout` typed domain events + REST endpoint `POST /api/v2/sessions/:id/approve` with HMAC-signed token + console `[WAITING]` badge. Requires workflow schema change + engine changes. Build after autonomous daemon is proven.

### From Prefect / Dagster

- **Prefect:** Lookahead pre-insertion scheduler model is the right pattern for cron-based WorkRail sessions. `CronTrigger.poll()` should pre-compute missed ticks and fire them on catch-up.
- **Dagster:** Sensor cursor model is the direct design source for WorkRail's `TriggerSourcePortV2`. Dagster's `run_key` (idempotency key) = WorkRail's trigger event ID as workflowId. Dagster's `SkipReason` = WorkRail's empty `events[]` result from `poll()`.

### Confidence: HIGH

No RED findings. Two ORANGE findings (both known scope dependencies, not blockers). Four YELLOW improvements documented. Design is ready for implementation.

### Build order

1. `DaemonStateStore` port + implementation (~80 LOC) -- prerequisite for any daemon session
2. Document that `PinnedWorkflowStore` already handles versioning (zero code)
3. `TriggerSourcePortV2` + `TriggerCursorStore` + `CronTrigger` + `GitLabMRTrigger` (~200 LOC)
4. `requiredEvidence` implementation (production prerequisite for destructive-step steps)
5. Approval gate domain events + REST route + daemon polling loop (~200 LOC + schema change)

### Residual risks (2)

1. **Sub-step durability gap:** A long step (30+ tool calls, 45+ minutes) that crashes loses all tool call progress within the step. Acceptable for v1. Worth a design session when evidence of need materializes.
2. **Multi-tenancy seams:** `orgId` prefix in `TriggerCursorStore` and `DaemonStateStore` paths is the right seam, but the full multi-tenancy design is deferred. Must be designed before WorkRail Auto cloud deployment.
