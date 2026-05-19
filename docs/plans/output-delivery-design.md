# Output Delivery Design

**Status:** Discovery in progress (2026-05-19)

## Context / Ask

**Stated goal (original):** Design pluggable output delivery for WorkTrain -- workflows produce structured artifacts, delivery channel (GitHub draft review, Slack, GitLab MR note, CLI inbox, webhook) is configured externally on the trigger rather than hardcoded in the workflow definition.

**Goal classification:** `solution_statement` -- the stated goal already names a specific architecture. The underlying problem (see Problem Frame Packet) is more fundamental.

**Path recommendation:** `design_first` -- the original goal was a solution statement and the problem has several open assumptions that could materially change the architecture if resolved differently. Jumping to candidates without first grounding the problem risks building the wrong abstraction.

**Rigor mode:** `THOROUGH` -- this is an architectural decision that touches workflow schema, daemon runtime, trigger config, and potentially the gate system. Getting it wrong means rearchitecting later.

**Solution ambitiousness:** `ideal_solution` -- this is infrastructure that every workflow will depend on. The right answer now avoids a painful migration later.

**Problem domain:** `software` -- technical architecture and system design.

## Problem Frame Packet

**Reframed problem:** Workflow outputs have no configurable, platform-agnostic path to reach the humans and systems that need to act on them. Outputs either never leave the local machine (sit in a worktree file) or require a hardcoded `requireConfirmation` gate that parks the session until a human manually approves it via CLI.

**Desired outcome:** Any workflow can deliver its output to any configured destination (GitHub, GitLab, Slack, webhook, CLI inbox) without the workflow definition encoding the delivery mechanism. Operators can change the delivery channel with a config change, not a workflow edit.

**Anti-goals:**
- Do not require every workflow to be rewritten to support new delivery channels
- Do not add delivery config to the workflow JSON schema (workflows declare what they produce, not where it goes)
- Do not silently discard output if no adapter is configured
- Do not break the `requireConfirmation` gate as a control-flow pause mechanism
- Do not add N delivery adapters × M artifact types mapping complexity if unnecessary

## Constraints

- Must work with GitHub and GitLab (different review/note APIs)
- Must work when no delivery channel is configured (CLI inbox as default)
- Workflow JSON schema should not need to change for operators to switch delivery channels
- The `requireConfirmation` gate must continue to function as an execution pause point
- Adding a new adapter should not require touching existing workflow definitions

## Challenged Assumptions

1. **Delivery belongs on the trigger** -- Triggers control when a workflow runs, not what it produces. Attaching delivery config to triggers forces duplication and may be the wrong ownership boundary. Delivery may belong on the workflow output contract or a global user/org preference.

2. **Delivery and gating are fully separable** -- A gate that pauses for approval needs to both deliver output for review AND receive a response through some channel. Complete separation may not be achievable; gate and delivery share a dependency on the same adapter.

3. **Typed artifact kinds are the right routing abstraction** -- If a Slack adapter just posts text regardless of artifact type, routing by `kind: "draft_review"` vs `kind: "summary"` adds complexity without value.

## Success Criteria

1. Operator can switch `wr.mr-review` output from CLI inbox to GitHub draft review to Slack by changing one config value, without editing the workflow JSON
2. A workflow running against a GitLab repo produces a MR note without workflow-level changes
3. Adding a new delivery adapter requires no changes to existing workflow definitions
4. The `requireConfirmation` gate still functions as a control-flow pause, and automatically uses the configured delivery channel for its awaiting-approval notification
5. If no delivery adapter is configured, output lands in CLI inbox by default (no silent loss)

## Ideal End State

Workflows declare a minimal output contract (what they produce, not where it goes). A separate delivery layer -- configured per-trigger, per-workflow-type, or globally as a user preference, with a clear precedence order -- routes outputs to one or more destinations: GitHub draft review, GitLab MR note, Slack channel, outbound webhook, CLI inbox. The `requireConfirmation` gate is orthogonal to delivery: when a gate fires, it uses the already-configured delivery channel to send the awaiting-approval message and blocks until a response arrives through that same channel. No gate-specific delivery wiring is needed. New adapters are additive. CLI inbox as zero-config default.

## Landscape Packet

### Current State Summary

Delivery is already partially pluggable -- four distinct mechanisms exist today, all wired in `TriggerRouter` after `runWorkflow()` returns:

| Mechanism | Config location | What it sends | Status |
|---|---|---|---|
| `callbackUrl` | Per-trigger in `triggers.yml` | Full `WorkflowRunResult` JSON via HTTP POST | Working, no retry/auth |
| `autoCommit` + `autoOpenPR` | Per-trigger in `triggers.yml` | Git commit + `gh pr create` | Working; requires `HandoffArtifact` in notes |
| Draft review posting | `reviewerIdentity` per-trigger | GitHub PENDING review via REST API | Working; reads `wr.review_verdict` artifact |
| `NotificationService` | Global `~/.workrail/config.json` | macOS notification OR generic webhook | Working; fires on all outcomes |
| `onComplete` hook | Per-trigger in `triggers.yml` | Chained workflow trigger | **Parsed but never executed** |

The execution point for all mechanisms is the async queue callback in `TriggerRouter.route()`, which runs sequentially after `runWorkflow()` returns. `maybeRunPostWorkflowActions()` dispatches on typed artifact kind (`wr.review_verdict`) to decide whether to post a draft review.

### Key Structural Observations

**1. `WorkflowTrigger` is already delivery-free by design.**
The `WorkflowTrigger` DTO (passed into `runWorkflow()`) contains zero delivery config. `callbackUrl`, `autoCommit`, `autoOpenPR`, `reviewerIdentity` all stay on `TriggerDefinition` and are read by the router after the run. This separation is intentional.

**2. `dispatch()` has a known delivery gap.**
The `dispatch()` path (used by `worktrain dispatch`) has no `triggerId` to look up delivery config from `TriggerDefinition`. There is an explicit TODO at `trigger-router.ts:1361` noting this gap. Sessions started via `dispatch` currently have no delivery mechanism.

**3. The `human_approval` gate is doing double duty.**
It is both a control-flow pause AND the trigger for draft review delivery. When `gate_parked` with `gateKind: 'human_approval'` fires, `TriggerRouter` reads artifacts from the session store and calls `maybeRunPostWorkflowActions()` -- the same function used for non-gated delivery. The gate and delivery are coupled specifically because `human_approval` was designed as a "deliver then wait" pattern.

**4. The delivery signal is already clean.**
`WorkflowRunSuccess.lastStepArtifacts` (typed) and `lastStepNotes` (prose) are the two output channels. The `wr.review_verdict` typed artifact is the canonical routing signal for reviews. Inline comment data (`file`, `startLine`, `endLine`, `causalLink`, `remediation`) exists as passthrough fields on each finding but is not yet consumed by `createDraftReview()`.

**5. Global delivery config already exists.**
`~/.workrail/config.json` has `WORKTRAIN_NOTIFY_MACOS` and `WORKTRAIN_NOTIFY_WEBHOOK` as global delivery hooks. This is a precedent for user-level delivery preference outside `triggers.yml`.

**6. The artifact contract system is clean and extensible.**
`outputContract.contractRef` on a step enforces that the agent submits a specific typed artifact. New delivery-relevant contracts can be added without schema changes to existing steps.

### Hard Constraints from the Codebase

- `GateKind` is exhaustively pattern-matched with `assertNever` in two places -- adding a new gate kind is a compile-enforced change, which is good (safe) but also means a new `'delivery_and_gate'` kind needs code changes in `trigger-router.ts:route()` and `dispatch()`
- Notes are max 4096 bytes; artifacts can be larger via inline `content` field
- `dispatch()` callers have no delivery config today and need a separate solution

### Existing Precedents / Prior Art

- **Adapter pattern**: `GitHubReviewApprovalAdapter` is already an adapter class; the interface is implicit but extractable
- **Config layering**: trigger-level > global (`~/.workrail/config.json`); `triggers.yml` already has per-trigger overrides for many things
- **Artifact-kind routing**: `maybeRunPostWorkflowActions()` already dispatches on `wr.review_verdict` -- the pattern for routing by artifact type exists

### Evidence Gaps

1. What happens to output from `dispatch()`-triggered sessions today? (No delivery at all -- confirmed by TODO at line 1361)
2. Does GitLab have an equivalent to GitHub's PENDING/draft review? (Not confirmed -- would need research; MR notes are the closest analog)
3. Are there any workflows other than `wr.mr-review` that currently produce typed artifacts intended for external delivery? (Appears to be only `wr.review_verdict` today)

## Decision Criteria

**Principles at play (abstract, pre-candidate):**
- Typed contracts at phase boundaries -- the delivery boundary should be as typed as every other phase boundary
- Zero LLM turns for routing -- delivery routing must be deterministic code, not reasoning
- Observable by default -- every delivery attempt and outcome should be visible in the session store
- Overnight-safe -- delivery must not require human intervention to complete (unless that is the explicit intent)
- Structured outputs, not free-text scraping -- no adapter should need to parse prose to decide what to do

**Decision criteria (priority order):**

1. **[Compatibility] Operator can change delivery channel without editing workflow JSON.** An operator swapping from CLI inbox to GitHub draft review must only touch config, not the workflow definition. Non-negotiable -- this is the core problem being solved.

2. **[Compatibility] No silent output loss.** If no delivery adapter is configured, output must land somewhere (CLI inbox default). An unconfigured delivery channel must fail explicitly, not silently discard the result.

3. **[Compatibility] Gate control flow is preserved.** `requireConfirmation` gates must continue to pause execution and wait for a human decision. Delivery refactoring must not collapse gates into delivery-only actions.

4. **[Quality-aspirational] Adding a new adapter in 18 months requires zero changes to existing workflow JSON, triggers.yml entries, or engine code.** A senior engineer 18 months from now adding a "Jira comment" adapter should only write the adapter and register it -- no schema migrations, no workflow updates, no engine changes. This tests whether the abstraction is genuinely open/closed.

5. **[Vision-aligned] Delivery config and adapter selection are deterministic TypeScript code, not LLM routing turns.** The coordinator decides which adapter to invoke based on typed config and typed artifact kind -- not by reasoning about what the output "looks like". This directly serves the vision principle "zero LLM turns for routing."

6. **[Quality-aspirational] The `dispatch()` path gets the same delivery guarantees as `route()`.** Sessions started without a triggerId (programmatic dispatch, future Jira/webhook dispatch) must be deliverable. A design that requires trigger lookup to find delivery config is a dead end as WorkTrain expands to more entry points.

**Riskiest assumption:** The adapter interface can be uniform enough to handle both synchronous (Slack POST) and asynchronous (GitHub draft + poll) delivery without leaking platform-specific concerns. If this assumption is wrong, the right abstraction is a simpler "delivery action" (imperative step) rather than an adapter interface.

**Vision alignment:** This feature directly serves "overnight-safe" and "observable by default". A review parked in a local worktree file is not overnight-safe -- the operator must remember to check it. Delivery to GitHub/Slack means the result reaches the operator without any memory requirement on their part. The self-improvement loop depends on WorkTrain being able to submit its own reviews to GitHub autonomously -- pluggable delivery is a prerequisite for that.

## Candidate Directions

Five distinct candidates synthesized from 15 approaches across three generation angles. Duplicates collapsed by primary mechanism.

---

### Candidate 1: Named Adapter Registry with explicit DeliveryReceipt union

**Primary mechanism:** A `DeliveryAdapter` interface with `deliver()` returning `DeliveryReceipt = { kind: 'completed' } | { kind: 'pending'; pollHandle }`. Config resolution at three levels (trigger > workflow-type > global) via a pure `resolveDeliveryConfig()` function. Gates inherit the resolved adapter -- no gate-owned delivery config. `WorkflowTrigger` gains an optional `deliveryConfig` field that closes the `dispatch()` gap. Four existing mechanisms become builtin adapter implementations behind a migration shim. CLI inbox is the zero-config fallback.

**Convergence:** This mechanism appeared independently in Angle A Approach 1, Angle B Approach 1, Angle C Approach 1, and Angle B Approach 4 (render/ship split as internal refinement). It is the consensus pick across all three generation personas.

**Tensions resolved:**
- Config ownership: trigger > workflow-type > global precedence, pure resolver function
- Gate coupling: gates call `adapter.deliverGateNotification()` + `pollForApproval()` -- inherit config, don't own it
- Artifact routing: adapter's `render()` method absorbs it; no N×M mapping table
- `dispatch()` gap: `WorkflowTrigger.deliveryConfig` field, forwarded at call time
- Sync/async: `DeliveryReceipt` union -- sync adapters return `'completed'`, async return `'pending'` with serializable `pollHandle`
- Backward compat: migration shim in `trigger-store.ts` converts legacy fields; no triggers.yml edits required

**Key tradeoff:** `pollHandle.state` is `Record<string, unknown>` (opaque blob) to keep adapter independence. Loses some type safety on poll state; acceptable because it is already the pattern used by `PendingDraftReviewPoller`.

**Satisfies all 6 criteria.**

---

### Candidate 2: Extend existing DeliveryStage pipeline + `delivery_planned` event

**Primary mechanism:** The existing `DeliveryStage` interface in `delivery-pipeline.ts` is extended with a `'suspend'` outcome variant. A `DeliveryPipelineResolver` builds a `readonly DeliveryStage[]` from three-level config. New adapters are new stages. Additive `delivery_planned` event appended to session log at session start for observability. The `human_approval` path is refactored from its monolithic block into a `GateDeliveryStage` with a `SuspendHandle`.

**Adversarial challenge found 3 structural weaknesses -- see Challenge Notes below.** After adjudication, this candidate is demoted from leading to runner-up.

**Tensions resolved (partial):**
- Gate coupling: `GateDeliveryStage` with `SuspendHandle` -- conceptually clean
- Backward compat: existing stages preserved as-is
- Observability: `delivery_planned` event is genuinely additive
- `dispatch()` gap: NOT CLOSED -- resolver requires trigger context that `dispatch()` doesn't have (structural weakness 3)

**Does NOT fully satisfy criterion 6.**

---

### Candidate 3: Event-sourced delivery bus with per-session DeliveryPlan

**Primary mechanism:** At session start, a `delivery_planned` event (containing a fully resolved `DeliveryInstruction[]`) is appended to the session event log. A `DeliveryExecutor` reads pending instructions after session completion and appends `delivery_recorded` / `delivery_pending` events per instruction. The gate subscribes to the `approval_request` instruction in the plan and uses it for awaiting-approval notification. Every delivery decision is auditable from the event log alone.

**Tensions resolved:**
- Config ownership: plan is resolved once at session start, immutable for that session
- Gate coupling: gate inherits `approval_request` instruction from plan -- no direct delivery code in gate handler
- `dispatch()` gap: plan resolver called at session start regardless of entry point
- Observability: fullest of all candidates -- delivery intent is durable and queryable

**Key tradeoff:** Highest implementation cost. Adds 4+ new event kinds to the session schema, requires a `DeliveryExecutor` component, and breaks the clean separation between workflow execution and delivery (plan must be appended before agent loop starts). Correct 3-year architecture but over-engineered for current needs.

**Satisfies all 6 criteria.** Best observability of any candidate.

---

### Candidate 4: Gate-Owned Delivery Protocol (GateDeliveryProtocol union)

**Primary mechanism:** Accept that gate/delivery coupling is correct for gate-typed operations. Formalize it as a `GateDeliveryProtocol` discriminated union where each `GateKind` member declares exactly what delivery it performs. `human_approval` delivers to configured reviewer channel. `coordinator_eval` delivers to the autonomous evaluator. Adding a gate kind forces a protocol member via `assertNever` enforcement.

**Tensions resolved:**
- Gate coupling: named as correct and formalized -- no illusion of separation
- Backward compat: `reviewerIdentity` maps directly to `human_approval` protocol entry; zero migration
- Deterministic routing: exhaustive switch, fully type-safe

**Does NOT satisfy criterion 4** (adding a new adapter = new `GateKind` = compile-enforced code change). Intentionally. This approach treats "add a new adapter" as a structural change, not a config change.

**Only addresses gate-coupled delivery.** Non-gate delivery (coding workflow results, callbackUrl) is left unaddressed.

---

### Candidate 5: Delivery config as a separate `delivery.yml` file

**Primary mechanism:** A dedicated `~/.workrail/delivery.yml` file maps workflow IDs (and `'*'` wildcard) to `DeliveryConfig` entries. `dispatch()` resolves by workflow ID alone -- no trigger lookup required. This is the cleanest resolution of the `dispatch()` gap of all candidates. Per-trigger overrides are an additive `delivery:` key in `triggers.yml`. CLI inbox as default when file is absent.

**Tensions resolved:**
- Config ownership: explicit ownership boundary -- `triggers.yml` owns "when to run", `delivery.yml` owns "where results go"
- `dispatch()` gap: workflow-ID-only lookup closes it without touching `WorkflowTrigger` structure
- Backward compat: `delivery.yml` is optional; legacy paths remain until operators opt in

**Key tradeoff:** Third config surface. Operators must learn where to look. Wildcard resolution rules must be documented. Per-trigger override requires editing both files.

**Satisfies all 6 criteria.** Cleanest `dispatch()` resolution of any candidate.

---

## Challenge Notes

**Challenge executor:** adversarial challenger prompted to construct the strongest case against "extend DeliveryStage pipeline" (Candidate 2). Challenge rung: single-family executor with steelmanning instructions.

**Challenge quality observed:** STRUCTURAL -- all three findings question fundamental assumptions, not implementation details.

**Finding 1 (structural): `'suspend'` outcome cannot cleanly integrate into a sequential pipeline runner without signature changes or fire-and-forget lies.**
The `DeliveryStage` interface encodes a linear sequential model. Gate suspension is a long-running async process that outlives the queue callback and survives restarts. Adding `'suspend'` to `DeliveryStageOutcome` either forces `runDeliveryPipeline` to return a `SuspendHandle[]` (cascading signature change) or makes the stage fire-and-forget under the hood while returning a misleading discriminant. **Accepted. Tactical fix: the concern is real. However, it is solvable -- the pipeline runner can return `SuspendHandle | undefined` and the gate startup recovery path can be unified. Demoted from blocking to implementation risk.**

**Finding 2 (structural): `canHandle()` per-stage filter creates hidden routing that cannot be statically validated.**
Multiple stages (git delivery, gate delivery) with runtime guards makes it impossible to answer "which delivery will run for this trigger" without tracing all stage internals. Silent double-execution risk when `autoCommit: true` + `reviewerIdentity` are both configured. **Accepted as structural. The `DeliveryPipelineResolver` must produce a stage array that is already resolved for the specific `result._tag` -- this requires knowing the result at resolution time, which means it is not purely a config-resolution layer. This contradicts the candidate's core claim.**

**Finding 3 (structural): `dispatch()` gap remains open -- the pipeline resolver requires trigger context.**
The resolver builds a pipeline from `TriggerDefinition`, which `dispatch()` doesn't have. Without adding a delivery config field to `WorkflowTrigger` (the alternative's mechanism), criterion 6 fails. **Accepted. This is unambiguous -- no countervailing evidence. The candidate's description says the resolver handles `dispatch()` by reading workflow-type config, but the resolver itself requires being called with trigger context to work. This requires the same structural change as Candidate 1 to fix.**

**Position change:** Candidate 2 is demoted from leading to runner-up. Candidate 1 (Named Adapter Registry) is confirmed as the leading direction based on adversarial findings, not reconsideration.

**Pre-mortem failure conditions (Candidate 1):**
1. If `PollHandle.state: Record<string, unknown>` becomes a maintenance burden -- different adapters have different poll state shapes, and daemon startup recovery must instantiate the right poller without type safety on the stored blob. Every new async adapter adds an implicit type contract that is invisible to the type checker.
2. If the three-level config merge order produces surprising results for operators who set conflicting config at multiple levels -- e.g., `global: cli_inbox` + `trigger: github_draft_review` + no workflow-type config. The merge is deterministic but operators debugging unexpected delivery will need to understand the precedence order.
3. If `WorkflowTrigger.deliveryConfig` becomes a dumping ground -- the same field escalation that turned `WorkflowTrigger` into a large struct previously. The field is optional and typed, but as more adapters are added, the discriminated union grows and every call site that constructs a `WorkflowTrigger` must decide whether to populate it.

## Challenge Notes

*(to be populated in adversarial challenge step)*

## Resolution Notes

**Selected direction: Candidate 1 -- Named Adapter Registry with explicit DeliveryReceipt union**

**Runner-up: Candidate 3 -- Event-sourced delivery bus**

**Selection tier:** `strong_recommendation` -- fresh-context executor reached same ranking independently, structural challenge quality confirmed, all six criteria satisfied, clear criterion failure in runner-up (C2 fails criterion 6).

**Recommendation confidence:** medium-high. The adversarial challenge was structural and changed the ranking (C2 demoted), which is the correct behavior. C1 was confirmed, not chosen by default.

**Quality ceiling check vs ideal end state:**

The ideal end state requires: workflows declare output contract (what they produce, not where it goes) ✓; separate delivery layer configured at trigger/workflow-type/global with precedence order ✓; gates inherit configured delivery channel ✓; new adapters are additive ✓; CLI inbox as zero-config default ✓; gate uses configured channel for awaiting-approval notification ✓.

C1 reaches the ideal end state. The one gap relative to C3: delivery decisions are not appended as session events at session start, so the console cannot show "this session was planned to deliver to GitHub" before the delivery executes. This is an observability shortfall, not a correctness shortfall. It is justified: C3's event-sourced plan requires 4+ new event schema additions, a `DeliveryExecutor` component, and breaks the clean separation between workflow execution and delivery. Mitigation: the `delivery_planned` event concept from C2 can be added additively to C1 without adopting C3's full execution model.

**What would trigger a switch to the runner-up (C3):** If the session event log already has a delivery execution layer (e.g., as part of a broader event-sourced coordinator), or if delivery idempotency and crash-safe recovery become blocking concerns in production. Neither is true today.

**What would trigger a switch to C5:** If the dispatch() gap turns out to require a completely clean separation from trigger infrastructure (e.g., the MCP server needs to dispatch with delivery guarantees and cannot touch WorkflowTrigger). The workflow-ID-only lookup in C5 is the cleaner architectural boundary.

## Decision Log

**2026-05-19: Selected Candidate 1 (Named Adapter Registry)**

*Why C1 won:* Passes all 6 criteria. Pure `resolveDeliveryConfig()` function is testable and statically analyzable. `WorkflowTrigger.deliveryConfig` closes dispatch() gap cleanly. Migration shim means zero flag-day for existing triggers.yml files. `DeliveryReceipt` union makes sync/async explicit without forcing uniform interface (directly addresses riskiest assumption).

*Why C2 lost:* Three structural weaknesses found by adversarial challenge; one is a hard criterion failure (dispatch() gap). The `'suspend'` outcome conflates sequential pipeline control-flow with long-running async suspension. `canHandle()` per-stage filtering is implicit routing that cannot be statically validated.

*Why C3 is the right 3-year architecture:* Event-sourced delivery plan provides the strongest correctness and observability guarantees. It is the correct foundation if WorkTrain moves to event-sourced coordination broadly. Should be flagged as the intended long-term direction in the backlog.

*Why C4 was eliminated:* Fails criterion 1 (gate kind declared in workflow JSON). Only addresses gate-coupled delivery; non-gate delivery unaddressed.

*Why C5 is not selected now:* Third config surface adds operator cognitive load. The dispatch() resolution via workflow ID is cleaner, but it requires operators to populate a third file. C1's `WorkflowTrigger.deliveryConfig` achieves the same dispatch() result with no new file. If the file-based separation becomes important for operator UX, C5's delivery.yml approach can be layered onto C1's adapter registry.

## Final Summary

**Recommendation:** Candidate 1 -- Named Adapter Registry with explicit DeliveryReceipt union
**Confidence:** medium-high
**Selection tier:** strong_recommendation

### What to build

A `DeliveryAdapter` interface with:
- `deliver(payload, config): Promise<DeliveryReceipt>` where `DeliveryReceipt = { kind: 'completed' } | { kind: 'pending'; pollHandle }`
- `deliverGateNotification(payload, config): Promise<ChannelHandle>` for gate awaiting-approval
- `pollForApproval(handle): Promise<ApprovalPollResult>` for gate resume polling

Config resolution: pure `resolveDeliveryConfig(trigger?, workflowId, globalConfig) => DeliveryConfig` function, three-level precedence (trigger > workflow-type > global). CLI inbox as zero-config fallback.

`WorkflowTrigger` gains an optional `deliveryConfig?: DeliveryConfig` field. `dispatch()` callers populate it from the resolver without needing a `triggerId`.

Four existing mechanisms (`callbackUrl`, `autoCommit+autoOpenPR`, `reviewerIdentity`, `NotificationService`) become builtin adapter implementations. Migration shim in `trigger-store.ts` converts legacy fields to `AdapterConfig` entries -- no existing `triggers.yml` files require changes.

### Additive recommendation from runner-up (C3)

Append a `delivery_planned` event to the session log at session start (when `deliveryConfig` is resolved). One new event kind. Enables the console to show planned delivery channel before execution. Does not require the full C3 executor.

### Required prerequisites for implementation

1. **Design generalized sidecar format** (`pending-delivery-*.json` with `adapterId: string; state: Record<string,unknown>`) and update `WorkflowRunner` startup recovery to dispatch on `adapterId`. This is a prerequisite for any async adapter beyond the first.
2. **Deprecate `reviewerIdentity`** in the same PR that ships `deliveryConfig`. Emit startup warning if both fields are set.

### Phased implementation path

- **Phase 1:** `DeliveryAdapter` interface + `DeliveryReceipt` union + `resolveDeliveryConfig()` + migration shim + CLI inbox adapter. Zero behavior change -- existing mechanisms continue via migration shim.
- **Phase 2:** GitHub draft review adapter + `WorkflowTrigger.deliveryConfig` field + sidecar format. Removes `human_approval` gate's hardcoded delivery path.
- **Phase 3:** `delivery_planned` event + `worktrain trigger validate` shows resolved delivery. Deprecate `reviewerIdentity`.
- **Phase 4:** GitLab MR note adapter + Slack webhook adapter.

### Residual risks

1. **[ORANGE] Gate `ChannelHandle` not persisted on restart.** The sidecar must be written BEFORE `deliverGateNotification()` is called -- not after. If the daemon restarts between gate parking and sidecar write, `resumeFromGate` loses the channel handle. Write-order invariant must be specified in the sidecar format prerequisite.

2. **[ORANGE] Coordinator path (`runAdaptivePipeline`) is a third delivery entry point not addressed.** Adaptive coordinator calls `runCoordinatorDelivery()` with hardcoded delivery, bypassing `TriggerDefinition` and `WorkflowTrigger`. If coding sessions run primarily through this path, the migration shim is insufficient. Investigate before implementation.

3. **[YELLOW] `pollHandle.state` opaque blob.** Startup recovery dispatches on `adapterId` without type safety on state. Widen to typed union when second async adapter is added.

4. **[YELLOW] Three-level config precedence confusion.** Mitigated by `worktrain trigger validate` output (Phase 3).

5. **[YELLOW] `reviewerIdentity` deprecation.** Deprecate in Phase 2; emit startup warning if both fields set.

6. **[INFO] MCP-driven sessions out of scope.** Human-interactive sessions don't need delivery adapters. Future work if needed.

7. **[INFO] C3 (event-sourced bus) is the correct 3-year architecture.** `DeliveryAdapter.deliver()` interface is the same in both -- migration is in the executor layer.

### What was ruled out and why

- **C2 (extend DeliveryStage):** Three structural failures found by adversarial challenge; `dispatch()` gap unresolved; `'suspend'` outcome incompatible with sequential pipeline model.
- **C4 (gate-owned protocol):** Fails criterion 1 (gate kind in workflow JSON); only addresses gate-coupled delivery.
- **C3 as primary:** Correct long-term architecture but over-engineered for current problem; implement C1 first.
- **C5 (delivery.yml):** Third config surface adds operator cognitive load; C1's `WorkflowTrigger.deliveryConfig` closes `dispatch()` gap without a new file.
