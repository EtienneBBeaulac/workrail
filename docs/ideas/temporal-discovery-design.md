# Temporal.io Deep Dive: Architectural Patterns for WorkRail Auto

**Workflow:** `wr.discovery` | **Path:** `landscape_first` | **Date:** 2026-04-14

---

## Context / Ask

WorkRail's positioning anchor: "Temporal for AI agent process governance via MCP."

Deep dive on [Temporal.io TypeScript SDK](https://github.com/temporalio/sdk-typescript) to extract concrete architectural patterns for WorkRail Auto (the autonomous daemon + cloud platform vision).

**Desired outcome:** Concrete findings -- what WorkRail should adopt, adapt, or avoid.

**Path recommendation:** `landscape_first` -- the dominant need is understanding what Temporal actually does and comparing patterns to WorkRail's architecture. The problem is well-framed, not misframed.

---

## Path Recommendation

`landscape_first` -- the task is fundamentally a comparison/extraction problem. Both sides of the comparison (Temporal's architecture and WorkRail's design) are well-understood. No reframing needed. Rigor: STANDARD.

---

## Landscape Packet

### 1. Event History Model -- How Temporal Reconstructs State

**How Temporal does it:**

Temporal uses a server-side append-only event log stored in a persistent database (Cassandra or PostgreSQL). When a Worker picks up a workflow task, `sdk-core` (the Rust bridge) replays the event history against the workflow code to reconstruct state. The TypeScript SDK uses Node.js `vm` module to run workflow code in an isolated VM context (`VMWorkflowCreator` in `packages/worker/src/workflow/vm.ts`).

The key insight: the workflow code is **deterministic and side-effect-free by design**. All non-deterministic operations (timers, activities, signals) are expressed as commands sent back to the server. When replaying, the SDK checks whether commands match the recorded history -- if they don't, it throws a `DeterminismViolationError`.

The `Activator` class (`packages/workflow/src/internals.ts`) is the event-driven state machine at the core. It holds:
- `completions.timer`, `completions.activity` -- pending promise completions
- `bufferedSignals`, `bufferedUpdates` -- signals/updates received before a handler was registered
- `signalHandlers`, `updateHandlers`, `queryHandlers` -- registered handler maps
- `pushCommand()` -- buffers outgoing commands to send to the server at end of activation

Each "activation" (batch of events from the server) is processed by calling activation handler methods (`fireTimer`, `resolveActivity`, `signalWorkflow`, etc.). The Activator dispatches buffered signals/updates immediately when a handler is registered.

**Comparison to WorkRail's event log:**

WorkRail has a similar append-only event log (`~/.workrail/sessions/`). The key difference: Temporal's log drives **code replay** (re-executing deterministic workflow code), while WorkRail's log drives **state projection** (computing current run context from events). WorkRail doesn't need to replay code because steps are sequential and each step's output is recorded in `notes` -- the log is a read-only audit trail, not a replay substrate.

**Evidence gap:** WorkRail has never needed deterministic code replay because workflows are JSON-declarative (not code). This is a design choice that eliminates a class of problems (determinism violations) but also limits expressiveness.

### 2. Interrupt/Signal Mechanism -- How Temporal Pauses and Resumes

**How Temporal does it:**

Three interrupt mechanisms:

1. **Signals** -- fire-and-forget interrupts delivered by the server as activation jobs. The workflow registers a handler with `setHandler(signal, handler)`. Handlers are buffered if no handler is registered yet. SDK-core sorts signal jobs before other activation jobs so signals processed before workflow code resumes. The handler runs asynchronously up to its first `await`, then workflow code continues. Key design: signals cannot block the workflow's main execution path; they run concurrently.

2. **Updates** -- bidirectional RPCs that can return a value and can be rejected. Unlike signals, an unhandled update at end of activation is rejected (not silently dropped). Validation function runs synchronously before the handler.

3. **Conditions** -- `condition(fn: () => boolean)` returns a Promise that resolves when the predicate is true. Internally this registers a `Condition` object checked at the end of each activation. Used to pause workflow code until state changes (e.g., "wait until approved === true"). This is the cleanest "pause and wait" primitive.

The workflow pauses naturally at any `await` -- the event loop hands back control, the activation completes, and the next activation arrives when new events (signals, timer fires, activity completions) occur. There's no explicit "pause" API; workflow code is just normal async/await TypeScript.

**Comparison to WorkRail:**

WorkRail's equivalent to signals is `continue_workflow` with a `requireConfirmation` gate -- the token is withheld until a human approves. The mechanism is different (token-gated vs event-driven) but the outcome is the same: the workflow pauses at a well-defined point and cannot advance until the interrupt is delivered.

WorkRail has no equivalent to Temporal's `condition()`. This is a gap: WorkRail cannot express "pause until some external state changes" without a dedicated step that just blocks.

WorkRail's human-in-the-loop approval for autonomous sessions maps cleanly to Temporal's `condition(fn)` -- the daemon could poll a condition (e.g., `console_approved === true`) before advancing. This is an architecture the daemon needs.

### 3. Activity/Workflow Separation -- Determinism vs Side Effects

**How Temporal does it:**

Strict separation enforced by architecture:

- **Workflow code** runs in an isolated VM context with non-deterministic globals overridden (Date, Math.random, etc. are replaced with deterministic versions driven by the event history). Network calls, file I/O, and non-deterministic operations are **banned** inside workflow code. Violations cause `DeterminismViolationError` during replay.

- **Activities** are just plain TypeScript functions that can do anything -- HTTP calls, database queries, file I/O, LLM API calls. They run in the main Node.js process context with no isolation. They report back to the server (heartbeat, completion, failure) via the core SDK bridge. Activities are retried automatically by the server.

The VM isolate for workflow code is created fresh for each workflow task, with globals injected by `injectGlobals()`. The `getTimeOfDay` function comes from `native.getTimeOfDay` (the Rust bridge) which returns the server-side time from the history, ensuring determinism.

**Should WorkRail adopt this?**

No, and for a clear reason: WorkRail's workflow steps are JSON-declared and interpreted by the engine, not executed as user-provided code. There's no user workflow code that could be non-deterministic. The engine is the deterministic interpreter; the agent's tool calls are the "activities."

The conceptual separation WorkRail already has:
- **Engine** (deterministic orchestration) -- step sequencing, token protocol, context tracking
- **Agent tool calls** (side-effectful work) -- Bash, Read, Write, LLM calls

This is structurally analogous to the workflow/activity split but doesn't require VM isolation because the engine doesn't run user code.

**What to take:** The activity retry contract (retry policy, heartbeat, timeout tiers) is worth adopting for WorkRail's daemon. When an autonomous tool call fails (e.g., GitLab API flake), the daemon should retry with backoff rather than failing the whole session. This maps to `ActivityOptions.retry`.

### 4. Worker Polling -- Long-Poll vs WorkRail's Webhook Push

**How Temporal does it:**

Workers long-poll the Temporal server via gRPC. The `pollLoop$()` in `worker.ts` is an infinite async generator loop that calls `native.workerPollWorkflowActivation()` (the Rust bridge). When the server has work, it returns immediately; when idle, the poll blocks until a timeout or work arrives. There are separate poll loops for workflow tasks and activity tasks.

Pros of long-polling:
- Workers are stateless and ephemeral -- they can be killed and restarted without losing work (it goes back to the server)
- Horizontal scaling is trivial -- add more workers pointing at the same task queue
- No inbound connectivity needed on workers -- they connect out to the server
- Server is the single source of truth for task ordering and deduplication

Cons:
- Requires a persistent server (Temporal service) -- not optional
- Adds ~1 round-trip latency per step (usually milliseconds but adds up in tight loops)
- Poll connections consume server resources

**WorkRail's current model:**

WorkRail uses push from the agent to the engine (MCP tool calls). No polling needed because the agent drives the session.

For the autonomous daemon: the daemon initiates LLM API calls, which are essentially push from the daemon to Anthropic. WorkRail is the server and the daemon is the worker -- they share a process.

**What to take:** The conceptual model of "task queue + long-poll" is the right answer for WorkRail Auto's cloud deployment (multi-tenant, horizontally scaled). When WorkRail runs as a cloud service, worker nodes should long-poll a central task queue. At the self-hosted daemon level, the in-process call is simpler and correct.

The trigger system (`src/trigger/`) is the WorkRail equivalent of the Temporal server's task queue -- it holds pending work (incoming webhooks) and dispatches to the daemon. For self-hosted MVP, this is an in-process queue. For WorkRail Auto cloud, this becomes a real queue (Redis, SQS, etc.).

### 5. Workflow Versioning -- How Running Workflows Survive Code Deploys

**How Temporal does it:**

Two mechanisms:

1. **`patched(patchId)` / `deprecatePatch(patchId)`** -- inline versioning guards. During replay, `patched()` returns `true` if the history was recorded with the patched code path, `false` if not. This lets workflow code have two branches: one for old histories, one for new.

```typescript
if (patched('payment-v2')) {
  // New code path
  await processPaymentV2(amount);
} else {
  // Old code path -- keep until all old runs complete
  await processPaymentV1(amount);
}
```

2. **Worker Deployments (new model, replaces Build IDs)** -- `VersioningBehavior.PINNED` pins a workflow to a specific deployment version (e.g., `shopify-worker.v2.1`). `VersioningBehavior.AUTO_UPGRADE` automatically moves the workflow to the latest version on next task dispatch. Workflows declare their versioning behavior as an annotation on the workflow function.

The transition path:
1. Deploy new workers with `patched()` guards
2. Run old and new workers simultaneously -- old runs replay with old code, new runs use new code
3. Once all old runs complete, deploy workers with `deprecatePatch()` for the old IDs
4. Eventually remove all patch guards

**Comparison to WorkRail:**

WorkRail already has `workrailVersion` declarations (planned, not yet implemented per backlog). The `v1-to-v2-shim.ts` precedent exists.

The key difference: Temporal handles versioning because **code is the workflow**. A running workflow is a live code execution and deploying new code can break it mid-run. WorkRail's workflows are JSON schemas -- the "code" is the engine, not the workflow definition. An in-progress WorkRail session is unaffected by engine upgrades (the session state is self-contained in the event log + context variables).

**What to take:** The `PINNED` vs `AUTO_UPGRADE` dichotomy is useful for WorkRail's pinned workflow store. Workflows can declare `versioningBehavior: "pinned"` (always use the workflow hash that started this run) or `versioningBehavior: "auto_upgrade"` (always use the latest version of this workflow ID). WorkRail already has a pinned workflow store; making the choice explicit in the workflow definition is the next step.

The `patched()` pattern is not needed for WorkRail because JSON workflows can be evolved without in-flight run breakage. Use schema versioning (`workrailVersion`) + version adapters instead.

### 6. Namespace Isolation for Multi-Tenancy

**How Temporal does it:**

Namespaces are a hard server-side isolation boundary. Each workflow run belongs to exactly one namespace. Workers connect to a specific namespace (set in `WorkerOptions.namespace`, defaults to `"default"`). Client connections can also be namespace-scoped.

Within a namespace: all workflow types, task queues, and workflow runs are isolated from other namespaces. Cross-namespace operations are not supported natively (signals between namespaces require an activity that calls the client).

Namespaces provide:
- Auth boundary -- namespace-level access control in Temporal Cloud
- Quota limits per namespace
- Data isolation -- history, search attributes, and workflow metadata are namespace-scoped
- Worker routing -- a worker binds to one namespace and one or more task queues within it

**Comparison to WorkRail:**

WorkRail has no namespace concept today. The `workspacePath` is the closest analog -- it scopes the session store and workflow discovery to a directory. For WorkRail Auto cloud, namespace isolation becomes critical:

- Each org (customer) needs an isolated session store, workflow registry, and credential vault
- A worker for Org A should not be able to see or process tasks for Org B
- Session IDs must be globally unique per org (not just per `workspacePath`)

**What to take for WorkRail Auto:** The namespace → org mapping is direct. WorkRail should add `orgId` (or `tenantId`) as a first-class concept in the session store and task queue. Session locks, event logs, and trigger dispatches are all scoped per `(orgId, workspacePath)`. The global `~/.workrail/sessions` store becomes `~/.workrail/orgs/<orgId>/sessions`.

For self-hosted single-org deployments, the `orgId` is `"default"` and this is invisible to the user.

### Prefect Trigger Patterns (Brief)

Prefect uses a layered trigger model:

1. **Schedule-based** (`CronSchedule`, `IntervalSchedule`, `RRuleSchedule`) -- all in `schedules.py`. Clean pydantic models with timezone support and DST handling. Directly serializable to YAML/JSON for deployment configs.

2. **Event-based automations** (`automations.py`) -- `EventTrigger` (react to specific events), `MetricTrigger` (react to metric threshold crossing), `CompoundTrigger`/`SequenceTrigger` (boolean composition of triggers). Each trigger maps to an `Action` (e.g., `RunDeployment`, `SuspendFlowRun`, `CallWebhook`).

3. **Deployment triggers** (`schemas/deployment_triggers.py`) -- a simpler parallel hierarchy for YAML-based deployment configs. Key insight: triggers are declared alongside the deployment (not as separate objects), reducing config ceremony.

**What WorkRail should take from Prefect:**

The `BaseDeploymentTrigger` pattern is the right model for WorkRail's trigger system. Each workflow definition can declare its own triggers inline:

```json
{
  "id": "mr-review-workflow",
  "triggers": [
    { "type": "webhook", "source": "gitlab", "event": "merge_request.opened" },
    { "type": "cron", "schedule": "0 9 * * 1-5", "tz": "America/New_York" }
  ]
}
```

The `Posture` enum (`Reactive` vs `Proactive`) in Prefect's event trigger maps to WorkRail's use case: `Reactive` (respond to an external event) vs `Proactive` (cron-triggered, no external event). This is a cleaner abstraction than a flat trigger type list.

Prefect's `schedule_after` delay field is worth adopting: triggers can be delayed by N seconds after the event fires. Useful for "wait 5 minutes after MR opens before reviewing" patterns.

---

## Problem Frame Packet

**Users / Stakeholders:**
- WorkRail daemon engineers (designing the autonomous execution layer)
- WorkRail workflow authors (who need to declare triggers + versioning in workflow JSON)
- Operators deploying WorkRail Auto cloud (who need multi-tenancy)

**Jobs / Goals:**
- Extract concrete, actionable architectural patterns that improve WorkRail Auto's design
- Avoid re-inventing solutions Temporal/Prefect have already proven
- Identify where WorkRail's model is already superior and should not be polluted

**Success Criteria:**
- Each Temporal pattern produces a clear "adopt / adapt / avoid" recommendation for WorkRail
- Recommendations are grounded in the actual source code, not documentation claims
- Findings directly unblock specific design decisions in the daemon implementation backlog

**Framing Risk:**
- Risk of over-adopting Temporal patterns that don't apply because WorkRail's workflow model is fundamentally different (JSON-declarative vs code-defined)
- Risk of under-adopting: dismissing Temporal patterns because the analogy isn't perfect

---

## Candidate Directions

### Direction A: Adopt Temporal's activation model for the daemon loop (WINNER)

Take the `Activator` event-driven dispatch pattern and map it to WorkRail's daemon step execution. Each workflow step completion triggers the next activation. The daemon's main loop becomes:

```
activation = poll_or_receive_trigger()
result = engine.execute_step(activation)
emit_commands(result.commands)  // tool calls, LLM requests
```

This maps cleanly to pi-mono's `agentLoop` + WorkRail's `continue_workflow`. No structural changes to the engine.

**Strongest evidence for:** The Activator's `bufferedSignals` + `dispatchBufferedSignals()` pattern is exactly what WorkRail needs for human-in-the-loop approvals -- buffer the "resume" signal until the step handler is ready.

### Direction B: Adapt Temporal's patching for WorkRail workflow versioning (RELEVANT)

Use the `patched(patchId)` concept but in JSON form: add a `compatibilityNotes` section to workflow definitions that documents which sessions need which step variants. The engine reads `workrailVersion` from the session's `run_started` event and routes to the appropriate step variant.

**Strongest evidence for:** WorkRail already has `v1-to-v2-shim.ts` (precedent). Adding `workrailVersion` as a required field (backlog item) is the direct analog of Temporal's `patchId`.

### Direction C: Adopt Prefect's inline trigger declarations (RUNNER-UP)

Add a `triggers` array to WorkRail workflow JSON. Each trigger declares its type (`webhook`, `cron`, `event`), source, and delay. The trigger system reads these declarations at daemon startup and registers listeners. This eliminates the need for a separate trigger config file.

**Challenge pressure:** This makes workflow JSON aware of deployment topology, which is a concern-mixing risk. Counter: Temporal and Prefect both put deployment config alongside the workflow. It's the right UX for workflow authors.

### Direction D: Adopt Temporal's namespace isolation for WorkRail Auto (ADOPT WHEN NEEDED)

Add `orgId` as a first-class scoping key for session store, trigger queues, and workflow registry. Session IDs become `(orgId, sessionId)` globally unique pairs. Start with `orgId = "default"` for self-hosted; expand for cloud.

---

## Challenge Notes

**Challenge against Direction A (daemon loop):**
Does WorkRail actually need the full Activator pattern, or is pi-mono's `agentLoop` already sufficient? The `agentLoop` handles tool call dispatch and multi-turn loops. The WorkRail engine handles step sequencing. The gap is: who handles interrupts (human approvals)?

**Answer:** The Activator's buffer/dispatch pattern is needed for the human-in-the-loop gate. WorkRail's daemon needs: `await condition(() => session.humanApproved)`. The implementation is a polling loop on the session store, not a true event-driven activation. This is simpler but sufficient for MVP. True event-driven activation (server pushes to daemon) can come later.

**Challenge against Direction B (patching):**
WorkRail doesn't need `patched()` because JSON workflows don't run code. The version adapter layer already handles schema evolution. Is this direction actually necessary?

**Answer:** Direction B is correct but less urgent. The `workrailVersion` field is the right long-term investment, not `patched()`. Recommendation: implement `workrailVersion` as a required field (blocking no existing workflows, defaulting to `"1.0.0"`). The patching mechanism itself is a Temporal-specific solution to a code-execution problem WorkRail doesn't have.

---

## Decision Log

**Why `landscape_first` path:** Problem and desired outcome were pre-defined by the user. No reframing needed. Pure comparison task.

**Why not `full_spectrum`:** There's no ambiguity about what problem we're solving -- the backlog is explicit about WorkRail Auto's design questions. Full spectrum would waste steps on reframing a well-framed problem.

**Key insight from code review:** Temporal's complexity (VM isolation, determinism guards, replay, patching lifecycle) exists entirely because workflows are expressed as code. WorkRail's JSON-declarative approach eliminates this entire complexity class. This is a genuine architectural advantage, not a missing feature.

**Key insight from Prefect:** Prefect's event trigger model (`EventTrigger`, `Posture`, `schedule_after`) is more directly applicable to WorkRail than Temporal's patterns because Prefect also runs scheduled/event-driven flows, not just code-execution workflows.

---

## Final Summary

### Selected Path
`landscape_first` -- comparing Temporal.io TypeScript SDK and Prefect against WorkRail Auto's design needs.

### Problem Framing
WorkRail Auto needs an autonomous daemon architecture. The question is: what should it borrow from proven systems vs build fresh?

### Landscape Takeaways

1. **Temporal's VM isolation and determinism machinery** is irrelevant to WorkRail because WorkRail's workflows are JSON-declared, not code-defined. WorkRail has already avoided the entire determinism/replay problem class.

2. **Temporal's Activator buffer/dispatch pattern** (buffered signals dispatched when handler becomes available) is the right model for WorkRail's human-in-the-loop approval gate. MVP implementation: poll session store for approval. Future: event-push.

3. **Temporal's Worker Deployment versioning** (`PINNED` vs `AUTO_UPGRADE`) maps to WorkRail's pinned workflow store. Making the choice explicit in workflow JSON is the right next step.

4. **Temporal's namespace isolation** maps to WorkRail's `orgId` concept. Design in from day one; make it transparent for single-org self-hosted deployments.

5. **Temporal's long-poll model** is the right architecture for WorkRail Auto cloud (multi-tenant, horizontally scaled). For self-hosted daemon MVP, in-process call is simpler and correct. Design the trigger system with poll/push pluggability from the start.

6. **Prefect's inline trigger declarations** are the cleanest UX model for WorkRail workflow authors. Add `triggers: []` to workflow JSON schema. `Reactive` vs `Proactive` posture is a useful abstraction for the trigger type enum.

7. **Prefect's `schedule_after` delay** is worth adding to WorkRail triggers. Useful for "wait N seconds after event before starting" patterns.

### Chosen Direction
**Adapt, not adopt.** WorkRail should take the conceptual patterns (activation buffering, PINNED/AUTO_UPGRADE versioning, namespace isolation, inline trigger declarations) and implement them in WorkRail's own model (JSON-declarative, token-gated, MCP-native). None of Temporal's TypeScript code is directly usable because the execution model is different. Prefect's trigger schema model is closer to usable.

### Strongest Alternative
**Full Temporal adoption** -- build WorkRail Auto on top of Temporal as the durable state backend. Temporal would manage all session state, retry logic, and workflow scheduling; WorkRail would provide the step enforcement layer on top. This was rejected because: (1) Temporal requires its own server process, adding operational complexity; (2) WorkRail's session model (HMAC tokens, append-only event log, step notes) is already more capable than Temporal's history for WorkRail's use case; (3) the positioning "Temporal for AI agent governance" would be undercut if WorkRail were literally built on Temporal.

### Confidence Band
**Medium-High (7/10).** Code evidence is strong for all six Temporal patterns. Prefect trigger analysis is lighter (schema-level, not implementation-level). The "adapt not adopt" recommendation has clear architectural reasoning. Main uncertainty: whether the buffer/dispatch pattern for human-in-the-loop is the right implementation approach vs a simpler polling loop at MVP.

### Residual Risks
1. The human-in-the-loop gate (Activator buffer pattern) needs a concrete implementation design before daemon work starts. The REST control plane endpoint (`POST /api/v2/sessions/:id/resume`) is the right mechanism; the daemon polls it.
2. Prefect's event-based automation model (`EventTrigger`, `MetricTrigger`) is richer than what's needed for WorkRail MVP. Start with `webhook` + `cron` triggers only; add reactive event triggers in v2.
3. Namespace isolation should be designed in from day one (even if `orgId = "default"` initially). Retrofitting multi-tenancy into the session store later is expensive.

### Next Actions
1. **Immediate:** Add `triggers: []` array to workflow JSON schema (alongside existing fields). Define `DeploymentTrigger` discriminated union: `{ type: "webhook" | "cron" | "event", ... }`.
2. **Before daemon:** Design the REST control plane endpoint for human approval gates. Validate against the daemon's pause/resume flow.
3. **Daemon design:** Implement `PINNED` vs `AUTO_UPGRADE` versioning behavior in the daemon's workflow loader. Pinned: use the hash from `run_started`; auto-upgrade: use current registry.
4. **WorkRail Auto design:** Add `orgId` to `SessionLock`, session store paths, and trigger queue. Make it transparent for `orgId = "default"`.
5. **Future:** Evaluate Temporal adoption as a backend storage layer for WorkRail Auto cloud (not self-hosted). The argument changes significantly at cloud scale.

---

*Design doc path: `docs/ideas/temporal-discovery-design.md`*
