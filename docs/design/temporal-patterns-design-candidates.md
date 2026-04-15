# Temporal Patterns Design Candidates for WorkRail Auto

**Status:** Candidates generated from Temporal.io / Prefect / Dagster discovery (Apr 14, 2026)
**Discovery doc:** `docs/ideas/temporal-discovery.md`
**For:** WorkRail Auto daemon -- four pattern areas: durability, approval gates, versioning, trigger system

---

## Problem Understanding

### Core tensions

**T1: Temporal's determinism assumption vs AI non-determinism**
Temporal's entire event-sourcing replay model assumes workflow code is deterministic. WorkRail's domain (AI agent tool calls) is inherently non-deterministic. WorkRail cannot adopt Temporal's replay model. WorkRail's step-level checkpoint token is the correct architecture for the domain -- but it means a crashed step restarts from the beginning of the step, not from the last completed tool call.

**T2: Portability (`npx -y`) vs durability infrastructure**
Temporal, Prefect, and Dagster all require a server (PostgreSQL/Cassandra + UI). WorkRail must run with zero infrastructure beyond a filesystem. All durability must be file-based. Atomic writes (temp \u2192 fsync \u2192 rename) are the correct primitive.

**T3: Zero compute while waiting for human approval**
Temporal's `condition(fn, timeout)` is elegant: workflow has no active WFT while waiting, server holds state. WorkRail's daemon cannot hold a connection open indefinitely. Approach: persist checkpoint token to disk, daemon exits or loops, REST endpoint triggers resume from persisted token.

**T4: Multi-tenancy seams without current single-user complexity**
Adding `orgId` everywhere now = premature complexity. Not adding it now = future breaking refactor. Correct: design as a DI-injected port (`OrgContext`), default to single-user, make multi-tenancy an adapter.

### What makes this hard

WorkRail is a novel category (AI agent process governance). Every Temporal pattern must be adapted at the right abstraction level -- not too literally (adopt replay model), not too abstractly (just 'be durable'). The correct level: take each *invariant* Temporal enforces and find the WorkRail-appropriate mechanism that enforces the same invariant without Temporal's infrastructure.

### Likely seam

The daemon loop (`src/daemon/runWorkflow()` -- not yet built). It sits between trigger dispatch and engine calls. All four pattern areas land here:
- Durability: token persistence before each `continue_workflow` call
- Approval gate: polling loop entered after `approvalGate` step is detected
- Versioning: pinned snapshot loaded at session start, passed through each step
- Trigger system: cursor committed after session start

### Key discovery

`PinnedWorkflowStorePortV2` already exists (`src/v2/ports/pinned-workflow-store.port.ts`). It stores compiled workflow snapshots by content-addressed `workflowHash`. The `run_started` event already records `workflowHash`. The versioning "gap" may already be solved -- requires verification before building new code.

---

## Philosophy Constraints

From `CLAUDE.md` and confirmed by codebase:

- **Errors as data** -- `neverthrow` `Result`/`ResultAsync` throughout. No exceptions in business logic.
- **Make illegal states unrepresentable** -- `WithHealthySessionLock` as capability token. `WAITING_FOR_APPROVAL` must be a typed domain state in the event log, not a context variable flag.
- **Explicit domain types** -- `SessionId`, `WorkflowHash`, `TriggerId` as branded types, not raw strings.
- **Validate at boundaries** -- Webhook payloads and approval REST calls validated at HTTP boundary; core logic trusts the validated result.
- **Immutability** -- Session event log is append-only. Pinned workflow snapshots are never mutated in place.
- **DI for all I/O** -- All new ports injected via `V2Dependencies`. No global state.

**Philosophy conflicts in candidates:**
- Approval gate REST endpoint that accepts unsigned approvals violates 'validate at boundaries' -- requires HMAC-signed approval token.
- `TriggerId` as raw string would violate 'explicit domain types' -- must be a branded type.

---

## Impact Surface

- `src/mcp/handlers/v2-workflow.ts` -- `executeContinueWorkflow` path. Versioning candidate must verify this path uses pinned snapshots before building new code.
- `src/v2/durable-core/schemas/session/events.ts` -- Adding `step_approval_pending` and `step_approval_received` domain events requires extending the `DomainEventV1` discriminated union.
- `src/v2/ports/` -- Four new ports: `DaemonStateStore`, `ApprovalGatePort`, `TriggerSourcePortV2`, `TriggerCursorStore`.
- Console service (`src/v2/usecases/console-service.ts`) -- Must surface `WAITING_FOR_APPROVAL` sessions as a distinct state in the DAG.
- Daemon token persistence (`~/.workrail/daemon-state.json`) -- New file, new path. Does not interact with existing `~/.workrail/config.json` or session store.

---

## Candidates

### Candidate A: Daemon Durability (crash recovery)

**Summary:** Atomic token persistence to `~/.workrail/daemon-state.json` before each `continue_workflow` call. On daemon restart, read file and call `continue_workflow(token)` to rehydrate. No new session-store machinery.

**Approach in concrete terms:**
```typescript
// DaemonStateStore port
interface DaemonStateStore {
  persistContinueToken(sessionId: SessionId, token: string, stepIndex: number): ResultAsync<void, DaemonStateError>;
  loadContinueToken(sessionId: SessionId): ResultAsync<{ token: string; stepIndex: number } | null, DaemonStateError>;
}
// Implementation: atomic write to ~/.workrail/daemon-state.json
// Pattern: temp file + fsync + rename (same as session-store/index.ts)
```

**Tensions resolved:** T2 (no infra, just a file).
**Tensions accepted:** T1 -- tool-call-level durability not addressed. A 30-tool-call step that crashes at call 25 restarts from call 1.

**Boundary:** `DaemonStateStore` port in `src/v2/ports/`. Implementation in `src/v2/infra/local/daemon-state-store/`. Called by `runWorkflow()` before every `continue_workflow`.

**Why this boundary is best-fit:** The checkpoint token is outside the session lock scope by design. The session store cannot hold the recovery token because acquiring the lock is part of the recovery process. These are two separate concerns.

**Failure mode:** Disk write fails between token receipt and state file write -- session orphaned with no recovery token. Mitigation: atomic temp\u2192rename write (same pattern as session store). If write fails, daemon logs error and exits cleanly; operator retries from last persisted token.

**Repo-pattern relationship:** Directly follows `session-store/index.ts` atomic write pattern. Follows `token-alias-store.port.ts` interface shape.

**Gains:** Zero new infra. Crash recovery for all daemon sessions. Easy to test (mock the file write).
**Loses:** Sub-step (tool-call-level) crash recovery -- accepted tradeoff for v1.

**Scope judgment:** Best-fit. Does exactly what's needed for daemon crash recovery. Not too narrow (covers all daemon session types), not too broad (doesn't touch session engine internals).

**Philosophy fit:** Immutability (token file is write-once-per-step). Errors as data (ResultAsync). Explicit domain types (SessionId branded type, not raw string key).

---

### Candidate B: Human Approval Gate

**Summary:** New workflow step field `approvalGate: { notifyChannels: string[], timeoutMs: number }` causes daemon to emit a typed `step_approval_pending` domain event, persist checkpoint token, dispatch notifications, and enter a polling loop. REST endpoint `POST /api/v2/sessions/:id/approve` with HMAC-signed approval token appends `step_approval_received` event and releases the gate.

**Approach in concrete terms:**

New domain events (extend `DomainEventV1` discriminated union):
```typescript
{ kind: 'step_approval_pending';  sessionId: SessionId; stepId: string; timeoutAt: ISOString; notifyChannels: string[] }
{ kind: 'step_approval_received'; sessionId: SessionId; stepId: string; approvedBy: string; approvedAt: ISOString }
{ kind: 'step_approval_timeout';  sessionId: SessionId; stepId: string; timedOutAt: ISOString }
```

Daemon flow:
1. `continue_workflow` returns `{ awaitingApproval: true, stepId, timeoutMs }`
2. Daemon appends `step_approval_pending` event
3. Persists checkpoint token to `DaemonStateStore`
4. Dispatches notifications (best-effort -- gate is not blocked by notify failure)
5. Enters 1s polling loop: checks session event log for `step_approval_received` or `step_approval_timeout`
6. On approval: calls `continue_workflow` with stored checkpoint token to resume
7. On timeout: appends `step_approval_timeout`, marks session FAILED

REST endpoint: `POST /api/v2/sessions/:id/approve` -- body includes HMAC-signed approval token (keyed to session + stepId). Appends `step_approval_received` event. Signed token prevents unauthorized advances.

**Tensions resolved:** T3 (process may exit while waiting -- checkpoint token persisted before approval wait, daemon can restart and re-enter polling loop from session store state).
**Tensions accepted:** T4 -- multi-tenancy (per-org notification routing) deferred to cloud tier.

**Boundary:** Daemon loop (`runWorkflow()`) + new REST route in existing Express server + new domain events in session event log.

**Why this boundary is best-fit:** The approval gate is a daemon concern, not an engine concern. The engine just needs to tell the daemon 'this step requires approval before advancing.' The engine already has a step-blocking mechanism (assessment gates) -- approval gate reuses the same blocking pattern.

**Failure mode:** Approval REST endpoint unreachable (daemon not running, firewall). Mitigation: console UI always works (same REST server). If daemon is not running, the approval write still succeeds -- daemon picks it up on next start via DaemonStateStore recovery.

**Repo-pattern relationship:** New domain events follow `events.ts` discriminated union pattern. REST route follows existing Express server pattern (`src/infrastructure/session/HttpServer.ts`).

**Gains:** Human approval is a first-class typed state in the session history. Survives daemon restarts. Extensible notification channels. Console can show `[WAITING]` badge.
**Loses:** REST polling (1s interval) is less elegant than Temporal's condition(). For human-scale waits (minutes to hours), polling at 1s is completely acceptable.

**Scope judgment:** Best-fit. Scoped to the approval gate use case. The notification channel list is extensible without design changes.

**Philosophy fit:** Make illegal states unrepresentable -- `step_approval_pending` is a typed event, not a context variable flag. Errors as data -- notification failure returns `Result<void, NotifyError>`, gate not failed. Validate at boundaries -- HMAC-signed approval token validated at REST boundary.

---

### Candidate C: Workflow Versioning for Daemon

**Summary:** Verify first whether `executeContinueWorkflow` already uses the pinned workflow snapshot from `PinnedWorkflowStorePortV2`. If yes: document and move on (no new code). If no: add a 5-line path to load pinned snapshot instead of re-resolving from registry.

**Critical context:** `PinnedWorkflowStorePortV2` already exists and is designed exactly for this purpose (from port docstring: "Enable deterministic execution even when source workflow changes"). The `run_started` event already records `workflowHash`. Export bundles already embed pinned workflows.

**Verification path:**
```bash
grep -n "pinnedWorkflow\|PinnedWorkflow\|workflowHash.*get\|pinnedStore" \
  /Users/etienneb/git/personal/workrail/src/mcp/handlers/v2-workflow.ts
```

**If already solved (most likely):** The daemon just passes the token from `continue_workflow` response to the next call. The engine resolves the pinned snapshot internally via `workflowHash` in the token. No daemon-level versioning code needed.

**If NOT solved:** Add to `executeContinueWorkflow`:
```typescript
const pinned = await pinnedWorkflowStore.get(session.workflowHash);
if (!pinned) return err({ code: 'PINNED_WORKFLOW_NOT_FOUND', workflowHash: session.workflowHash });
// Use `pinned` for step interpretation instead of registry lookup
```

**Tensions resolved:** T2 (no new infra -- existing store). Content-addressed pinning means workflow redeploys cannot affect in-flight sessions.
**Tensions accepted:** None new -- this is the designed behavior.

**Boundary:** Verification of existing engine path. Possible 5-line addition to `src/mcp/handlers/v2-workflow.ts`.

**Failure mode (if pinned snapshot missing):** `get(workflowHash)` returns null for a session started before pinned store was implemented. Mitigation: existing engine likely falls back to registry -- this is the pre-pinning behavior and is safe for same-version redeploys.

**Repo-pattern relationship:** 100% follows existing pattern. PinnedWorkflowStore is already a registered port in `V2Dependencies`.

**Gains:** Deploy-safe in-flight sessions with zero new code (if verification passes).
**Loses:** Nothing. This is a verification task masquerading as a design decision.

**Scope judgment:** Too narrow if verification fails. Best-fit if verification passes.

**Philosophy fit:** Determinism over cleverness -- same workflowHash = same compiled workflow content. Immutability -- pinned snapshots never mutated.

---

### Candidate D: Trigger System Cursor Model

**Summary:** Each trigger source (GitLab webhook, Jira webhook, cron) implements a `TriggerSourcePortV2<TEvent, TCursor>` port with a typed cursor. `TriggerCursorStore` persists cursor to `~/.workrail/triggers/<sourceId>.cursor`. On each poll, the dispatcher compares cursor, starts sessions for new events, commits cursor after session start. Adapted from Dagster's sensor pattern.

**Approach in concrete terms:**

```typescript
// Core port
interface TriggerSourcePortV2<TEvent, TCursor> {
  readonly sourceId: TriggerId; // branded type
  poll(cursor: TCursor | null): ResultAsync<TriggerPollResult<TEvent, TCursor>, TriggerError>;
}

interface TriggerPollResult<TEvent, TCursor> {
  readonly events: readonly TEvent[];
  readonly nextCursor: TCursor; // always present, even if events is empty
}

// Cursor store
interface TriggerCursorStore {
  getCursor(sourceId: TriggerId): ResultAsync<string | null, TriggerCursorError>;
  setCursor(sourceId: TriggerId, cursor: string): ResultAsync<void, TriggerCursorError>;
}

// Implementations
class GitLabMRTrigger implements TriggerSourcePortV2<GitLabMREvent, GitLabCursor> {
  poll(cursor) { /* GET /api/v4/merge_requests?updated_after=cursor */ }
}
class CronTrigger implements TriggerSourcePortV2<CronTickEvent, ISOTimestamp> {
  poll(cursor) { /* compute missed ticks since cursor */ }
}

// Dispatcher
class TriggerDispatcher {
  async pollOnce(source): Promise<void> {
    const cursor = await cursorStore.getCursor(source.sourceId);
    const { events, nextCursor } = await source.poll(cursor);
    for (const event of events) {
      // Use event.id as workflowId for idempotency (Dagster's run_key pattern)
      await engine.startWorkflow({ workflowId: event.id, ... });
    }
    await cursorStore.setCursor(source.sourceId, String(nextCursor));
  }
}
```

**Idempotency key:** Event ID used as workflowId. If cursor commit fails and the same event is dispatched twice, `start_workflow` with the same workflowId returns `WORKFLOW_ALREADY_EXISTS` (or equivalent) -- no duplicate session. This is Dagster's `run_key` pattern exactly.

**Cron missed runs:** `CronTrigger.poll(cursor)` computes all missed ticks from `cursor` (last fired time) to `now`. Fires one session per missed tick. Max catchup configurable (`maxMissedRuns` per source).

**Tensions resolved:** T2 (cursor files, no infra). Daemon restart safety (cursor persisted atomically after each batch of sessions started).
**Tensions accepted:** T4 -- per-org trigger sources deferred to cloud tier (add `orgId` to `TriggerCursorStore` key path).

**Boundary:** New `src/trigger/` module. Isolated from session engine. `TriggerDispatcher` calls `executeStartWorkflow` directly (in-process model).

**Failure mode:** Cursor commit failure after session start -- same event dispatched twice. Mitigated by workflowId idempotency key.

**Repo-pattern relationship:** New ports follow `src/v2/ports/` pattern. Cursor files follow same atomic-write pattern as session store. `TriggerId` follows branded type pattern (`SessionId`, `WorkflowHash`).

**Gains:** Restart-safe trigger dispatch. No missed events. No double-fires (with idempotency key). Extensible: any new trigger source implements the port. Dagster's sensor cursor model is proven at scale.
**Loses:** Webhook triggers still need an HTTP receiver (separate concern from the cursor model). The cursor model handles durability; the HTTP receiver handles ingestion.

**Scope judgment:** Best-fit. The `TriggerSourcePortV2` interface is the right abstraction boundary. Not too narrow (covers cron, webhook, and future event-based triggers). Not too broad (does not redesign session start flow).

**Philosophy fit:** Explicit domain types (`TriggerId`, `TriggerPollResult`). Errors as data (`TriggerError` as discriminated union). Validate at boundaries (webhook payloads validated before entering trigger system). Functional/declarative (trigger sources are stateless functions; cursor is explicit state).

---

## Comparison and Recommendation

### Matrix

| Criterion | A (Durability) | B (Approval Gate) | C (Versioning) | D (Trigger Cursor) |
|-----------|---------------|-------------------|----------------|-------------------|
| Resolves portability (T2) | Yes | Yes | Yes | Yes |
| Resolves approval-without-open-connection (T3) | N/A | Yes | N/A | N/A |
| Step-level vs tool-call-level (T1) | Accepts step-level | N/A | N/A | N/A |
| Multi-tenancy seam (T4) | Partial | Partial | Resolved | Deferred |
| Repo pattern fit | Excellent | Good | Excellent | Good |
| Philosophy compliance | Full | Full (with HMAC) | Full | Full |
| New code volume | ~80 LOC | ~200 LOC | 0-5 LOC | ~300 LOC |

### Recommendations

**Candidate A: ADOPT immediately.** Highest priority -- without crash recovery, the daemon cannot be trusted for any production use. Minimal code, follows existing patterns exactly. No design risk.

**Candidate B: ADOPT for v2 (after daemon MVP).** Approval gates are essential for WorkRail Auto's differentiation ('human in the loop'). Not MVP-blocking -- v1 daemon can run fully autonomous sessions first. The HMAC-signed approval token is required before this ships; unsigned approvals violate the security model.

**Candidate C: VERIFY first (this week).** Run the grep to confirm whether `executeContinueWorkflow` uses pinned snapshots. This is a 5-minute task. If yes, document it and move on. If no, the 5-line fix is the highest-ROI code change in the entire codebase.

**Candidate D: ADOPT for trigger system v1.** The cursor model is the correct foundation. Build `CronTrigger` + `GitLabMRTrigger` as the first two implementations. The HTTP webhook receiver is a separate concern (build it, but don't conflate it with the cursor model).

### Build order

1. Candidate A (DaemonStateStore) -- prerequisite for any daemon session
2. Candidate C verification -- possibly zero code, immediately valuable
3. Candidate D (TriggerCursorStore + CronTrigger) -- enables autonomous dispatch
4. Candidate B (ApprovalGate) -- enables human-in-the-loop after autonomous mode works

---

## Self-Critique

### Candidate A: strongest counter-argument
"Why not store the checkpoint token in the session event log itself, so there's only one durable store?" The session lock is the obstacle: to append to the session store, you need to acquire the lock. But you need the token to recover from a crashed lock. The out-of-band `daemon-state.json` correctly breaks this circular dependency. The counter-argument loses.

### Candidate B: what would tip the decision
If approval notifications are unreliable (Slack down, email spam-filtered), the approval gate becomes unusable even though it's technically correct. The console badge must always work even when external notifications fail. This is a UX dependency, not a design flaw.

### Candidate C: what assumption invalidates the design
If the engine does NOT use pinned snapshots (verification finds that `executeContinueWorkflow` re-resolves from registry), then the entire versioning story relies on workflow definitions never changing between steps. For the current MCP use case (human drives the session in one sitting), this is fine. For daemon sessions (which can run for hours), a redeploy mid-session would break the session. The 5-line fix then becomes a required safety property, not a nice-to-have.

### Candidate D: narrower option considered and rejected
"Just listen for webhooks and immediately start sessions -- no cursor." D1 loses because daemon restarts drop events. For Jira and GitLab webhooks (transient, not stored), a missed event during a 30-second daemon restart cannot be recovered. The cursor model only adds ~80 LOC to D1 and completely solves restart safety. D2 dominates D1.

---

## Open Questions

1. Does `executeContinueWorkflow` currently use `PinnedWorkflowStore` or re-resolve from registry? (Verify before building C.)
2. What is the maximum approval wait time WorkRail should support? (Affects whether 1s polling is acceptable or a file-watch is needed.)
3. Should `TriggerDispatcher` be a separate long-running process or part of the daemon's main event loop? (Related to `src/trigger/` vs `src/daemon/` module boundary.)
4. How should `step_approval_pending` sessions appear in the existing console DAG? (Requires console-service DTO extension.)
