# Output Delivery Design Candidates -- Angle A

**Focus angle:** Ideal end state -- best achievable design with unlimited time and scope. Zero
regrets in 3 years.

**Persona:** Principal engineer who has designed plugin systems at scale and has strong opinions
about what makes them survive long-term.

**Generated:** 2026-05-19

---

## Framing

Four delivery mechanisms exist today, all wired ad-hoc in `TriggerRouter` after `runWorkflow()`
returns. The problem is not that they work badly -- they mostly work. The problem is that the
abstraction boundaries are wrong in ways that will metastasize:

- Delivery config lives on `TriggerDefinition` (good for webhook triggers, broken for `dispatch()`)
- Artifact-kind routing is scattered (`maybeRunPostWorkflowActions` dispatches on `wr.review_verdict`
  using imperative conditionals, not a typed dispatch table)
- The `human_approval` gate secretly IS a delivery action -- it posts a draft review then waits --
  but this coupling is invisible in the workflow schema
- `dispatch()` callers have no delivery at all today (acknowledged TODO at trigger-router.ts:1361)

A correct design must address the ownership boundary, the adapter interface, the dispatch path gap,
and the gate/delivery coupling -- all at once. Partial fixes make the situation worse by adding
another ad-hoc layer.

---

## Approach 1 (p=0.70): Delivery Config Registry with Adapter Injection

**Primary mechanism:** A `DeliveryConfig` registry (resolved from `~/.workrail/config.json`
global defaults, overridden by per-workflow-type rules, further overridden by per-trigger rules)
feeds a `DeliveryAdapterRegistry` that maps `AdapterKind` -> `DeliveryAdapter` implementation.
`TriggerRouter` resolves the effective adapter at session start and threads it into the post-run
delivery call. The gate fires through the already-resolved adapter.

### How it resolves each tension

**Delivery config ownership:**
Three-level precedence: `global < workflow-type < trigger`. The registry merges in priority order
at trigger-load time (for `route()` path) and at dispatch time (for `dispatch()` path, which reads
global + workflow-type config without a trigger ID). Per-trigger overrides in `triggers.yml` are
additive; global config in `~/.workrail/config.json` provides the zero-config default.

**Gate and delivery coupling:**
The resolved `DeliveryAdapter` is threaded into the `WorkflowRunGateParked` result as an opaque
handle (adapter kind + config snapshot). When the gate fires, `TriggerRouter` calls
`adapter.notifyPendingApproval(sessionId, artifacts)` and stores the return channel handle in the
sidecar. On gate resume, the same adapter's `pollForApproval(channelHandle)` is called. Adapter
owns both directions.

**Artifact type routing vs generic payload:**
A single `render(artifacts: readonly Artifact[]) => RenderedPayload` method on the adapter
transforms typed artifacts to adapter-specific payloads. The registry-level routing table maps
`ArtifactContractRef[]` -> `AdapterKind` as a default hint, but operators can override to `generic`
which renders all artifact content as structured JSON. No N x M explosion -- the adapter is
responsible for rendering, not the registry.

**dispatch() path:**
`dispatch()` resolves a `DeliveryConfig` from global + workflow-type config only (no trigger ID
needed). The resolver is a pure function: `resolveDeliveryConfig(workflowId, globalConfig) =>
DeliveryConfig`. This is possible because global config carries a workflow-type rule table.

**Synchronous vs async delivery:**
`DeliveryAdapter` has a single method: `deliver(payload: DeliveryPayload): Promise<DeliveryOutcome>`.
The outcome discriminant is `'delivered' | 'pending' | 'error'`. Synchronous adapters (Slack) return
`'delivered'`. Async adapters (GitHub draft review + poll) return `'pending'` with a `channelHandle`
that the gate resume path polls. The adapter hides the async difference from `TriggerRouter`.

**Backward compatibility:**
The four existing mechanisms become `BuiltinAdapter` implementations: `CallbackUrlAdapter`,
`GitCommitAdapter`, `GitHubDraftReviewAdapter`, `NotificationServiceAdapter`. The existing
`triggers.yml` fields (`callbackUrl`, `autoCommit`, `autoOpenPR`, `reviewerIdentity`) map to the
corresponding adapter configs via a migration shim in `trigger-store.ts` that converts legacy fields
to the new `delivery:` block. Old `triggers.yml` files continue working without edits.

### Key tradeoffs

- Adding an adapter requires only implementing `DeliveryAdapter` and registering it in the registry.
  Zero changes to workflow JSON, `triggers.yml`, or engine code (criterion 4 satisfied).
- The three-level config merge adds parsing complexity. Config precedence must be documented
  explicitly and tested with regression fixtures.
- `RenderedPayload` must be rich enough to serve all current adapters. If GitHub requires a specific
  structure that is not representable as `RenderedPayload`, the adapter must do imperative adaptation
  internally -- which is acceptable but must be designed explicitly.
- The `channelHandle` stored in the sidecar creates a coupling between the gate resume path and the
  adapter that returned the handle. If the daemon restarts between gate park and gate resume, the
  handle must be serializable (not an in-memory closure).

### TypeScript shape

```typescript
// src/trigger/delivery/types.ts

/** Resolved from artifacts[] by an adapter's render() method */
export interface RenderedPayload {
  readonly kind: 'rendered';
  readonly summary: string;           // one-line summary for notifications
  readonly artifacts: readonly Artifact[]; // original typed artifacts, passed through
  readonly renderHint: string;        // e.g. 'markdown', 'github_review', 'json'
  readonly renderedText: string;      // adapter-specific serialized form (Markdown, JSON, etc.)
}

/** Opaque handle returned by async adapters for gate-resume polling */
export interface ChannelHandle {
  readonly adapterKind: AdapterKind;
  readonly data: Readonly<Record<string, unknown>>; // serializable, stored in sidecar
}

export type DeliveryOutcome =
  | { readonly kind: 'delivered'; readonly destination: string }
  | { readonly kind: 'pending'; readonly channelHandle: ChannelHandle }
  | { readonly kind: 'error'; readonly message: string; readonly retryable: boolean };

export interface DeliveryAdapter {
  readonly adapterKind: AdapterKind;
  /** Render typed artifacts to a payload this adapter can deliver */
  render(artifacts: readonly Artifact[]): RenderedPayload;
  /** Deliver the payload. Returns 'pending' for async (draft review + poll) */
  deliver(payload: RenderedPayload, config: AdapterConfig): Promise<DeliveryOutcome>;
  /**
   * Send an awaiting-approval notification (gate: human_approval).
   * Returns a ChannelHandle the gate resume path will poll.
   */
  notifyPendingApproval(sessionId: string, payload: RenderedPayload, config: AdapterConfig): Promise<ChannelHandle>;
  /**
   * Poll for approval response (gate resume path only).
   * Returns approved/rejected/pending. Never throws.
   */
  pollForApproval(handle: ChannelHandle): Promise<ApprovalPollResult>;
}

export type AdapterKind =
  | 'cli_inbox'           // zero-config default: write to ~/.workrail/inbox/
  | 'github_draft_review' // GitHub PENDING review via REST API
  | 'gitlab_mr_note'      // GitLab MR note
  | 'slack_webhook'       // Slack incoming webhook
  | 'callback_url'        // generic HTTP POST (replaces existing callbackUrl)
  | 'git_commit';         // git commit + optional gh pr create (replaces autoCommit)

// Config shape (stored in ~/.workrail/config.json and triggers.yml)
export interface DeliveryConfig {
  /**
   * Ordered list of adapters to deliver to.
   * Multiple adapters = fan-out (e.g. GitHub review + Slack notification).
   * Empty = use the global default (cli_inbox).
   */
  readonly adapters: readonly AdapterConfig[];
}

export type AdapterConfig =
  | { readonly kind: 'cli_inbox' }
  | { readonly kind: 'github_draft_review'; readonly token: string; readonly login: string }
  | { readonly kind: 'gitlab_mr_note'; readonly token: string; readonly baseUrl: string; readonly projectId: string }
  | { readonly kind: 'slack_webhook'; readonly webhookUrl: string }
  | { readonly kind: 'callback_url'; readonly url: string }
  | { readonly kind: 'git_commit'; readonly autoOpenPR: boolean; readonly secretScan: boolean };

// Three-level resolution (in config-file.ts / trigger-store.ts)
export interface DeliveryConfigResolutionOrder {
  /** From ~/.workrail/config.json: applies to all workflows */
  global?: Partial<DeliveryConfig>;
  /** From ~/.workrail/config.json delivery.workflowTypes[workflowId]: applies to this workflow type */
  workflowType?: Partial<DeliveryConfig>;
  /** From triggers.yml delivery: block: applies to this trigger only */
  trigger?: Partial<DeliveryConfig>;
}
// resolveDeliveryConfig(order) applies: trigger > workflowType > global > { adapters: [{ kind: 'cli_inbox' }] }
```

### Does it reach the ideal end state?

**Yes, with one caveat.** All six criteria are satisfied:
1. Operator changes config, not workflow JSON.
2. `cli_inbox` is the default when no adapter is configured.
3. `notifyPendingApproval` + `pollForApproval` preserve gate control flow.
4. New adapters require only implementing `DeliveryAdapter` and registering it.
5. Routing is pure TypeScript resolution, not LLM reasoning.
6. `dispatch()` resolves from global + workflow-type config.

The caveat: the `ChannelHandle` serialization requirement (must survive daemon restart) is a
non-trivial implementation constraint. A daemon restart between gate park and resume will lose an
in-memory `ChannelHandle` unless it is durably written to the sidecar file. This is solvable but
requires careful design of the sidecar format. The existing `PendingDraftReviewPoller` already does
exactly this via `writePendingDraftSidecar()`, so the pattern is established -- it just needs to be
generalized to all async adapters.

---

## Approach 2 (p=0.25): Workflow Output Contract + Platform-Typed Delivery Targets

**Primary mechanism:** Workflows declare an `outputContract` on their final step (already partially
supported via `ArtifactContractRef`). The `outputContract` now also names one or more
`DeliveryTarget` types (e.g. `'code_review_comment'`, `'summary_notification'`,
`'approval_request'`). A `DeliveryTargetResolver` in `TriggerRouter` maps
`(DeliveryTarget, platform)` -> `DeliveryAdapter`. Operators set the `platform` per-trigger or
globally; the mapping from target type to adapter is declarative code.

### How it resolves each tension

**Delivery config ownership:**
Dual-key: `platform` is set per-trigger (or globally), `DeliveryTarget` is declared in the workflow
step. Resolution is `adapterRegistry.resolve(target, platform)`. No duplication -- platform is set
once per operator environment; target type is set once per workflow step. Per-trigger platform
override handles the edge case where a single operator uses both GitHub and GitLab.

**Gate and delivery coupling:**
`'approval_request'` is itself a `DeliveryTarget` type. When a step's `outputContract` includes
`DeliveryTarget: 'approval_request'`, the engine knows this step produces output that requires a
response. The gate checkpoint is automatically wired to the adapter that implements
`'approval_request'` for the configured platform. No separate gate delivery wiring needed.

**Artifact type routing vs generic payload:**
The `DeliveryTarget` type is the routing unit, not the artifact kind. A `'code_review_comment'`
target maps to `GitHubDraftReviewAdapter` on `platform: 'github'` and `GitLabMRNoteAdapter` on
`platform: 'gitlab'`. The adapter receives the full `wr.review_verdict` artifact and renders it.
The N-types x M-adapters problem collapses to N-targets x 1-platform (because target type already
implies the platform capability needed).

**dispatch() path:**
`dispatch()` resolves platform from global config. The workflow-declared `DeliveryTarget` is read
from the compiled workflow definition (already in memory). Resolution is:
`resolveAdapter(compiledWorkflow.finalStep.outputContract.deliveryTargets, globalConfig.platform)`.
No trigger ID needed.

**Synchronous vs async delivery:**
The `DeliveryAdapter` interface is identical to Approach 1. Platform-specific async behavior
(polling) is hidden inside the adapter. The `DeliveryTarget` type is orthogonal to sync/async.

**Backward compatibility:**
Existing fields (`autoCommit`, `reviewerIdentity`, `callbackUrl`) are treated as implicit platform
declarations: `reviewerIdentity` implies `platform: 'github'` (or `'gitlab'` based on the
`platform` discriminant). `autoCommit` implies `platform: 'git'`. The migration shim in
`trigger-store.ts` synthesizes a `platform` value from legacy fields. Existing `triggers.yml` files
continue working.

### Key tradeoffs

- `DeliveryTarget` types in the workflow step are closer to "what the output IS" than "where it
  goes" -- which is philosophically correct. A `'code_review_comment'` is semantically different
  from a `'summary_notification'`. This keeps the workflow schema expressive without encoding the
  destination.
- The `DeliveryTarget` is still in the workflow schema (even if not the adapter). Operators adding
  a new step that produces a novel target type must edit the workflow. This partially violates
  criterion 1 for novel target types (though it satisfies it for existing targets with a different
  adapter).
- `'approval_request'` as a `DeliveryTarget` makes gate behavior implicit -- a step with this
  target automatically implies a gate. This reduces explicit `requireConfirmation` config but makes
  it harder to reason about which steps are blocking without reading the step's `outputContract`.
  This is a significant ergonomic tradeoff: explicit gates are more visible.
- Platform as a single per-trigger value breaks down for mixed-platform workflows (e.g. a workflow
  that posts to both GitHub for review and Slack for notification). Fan-out requires a `platforms`
  array, which complicates the resolution logic.

### TypeScript shape

```typescript
// Additions to workflow-definition.ts

export type DeliveryTarget =
  | 'code_review_comment'    // -> GitHubDraftReview | GitLabMRNote depending on platform
  | 'summary_notification'   // -> Slack | Webhook | CLI inbox depending on platform
  | 'approval_request'       // -> gate + delivery (awaiting-approval + polling)
  | 'git_commit';            // -> autoCommit/autoOpenPR path

export interface OutputContract {
  readonly contractRef: ArtifactContractRef;
  readonly required?: boolean;
  /** Zero or more delivery targets for this artifact */
  readonly deliveryTargets?: readonly DeliveryTarget[];
}

// In triggers.yml / config.json
export type Platform = 'github' | 'gitlab' | 'slack' | 'generic';

export interface PlatformConfig {
  readonly platform: Platform;
  readonly token?: string;
  readonly baseUrl?: string;
}

// Adapter resolution
export interface DeliveryAdapterRegistry {
  resolve(target: DeliveryTarget, platform: Platform): DeliveryAdapter;
}
```

### Does it reach the ideal end state?

**Partially.** The gate coupling is handled cleanly (better than Approach 1 -- `'approval_request'`
makes gate behavior part of the delivery contract, not a separate construct). The `dispatch()` path
gap is solved. New adapters for existing target types require no workflow changes.

However: adding a new `DeliveryTarget` type (e.g. for Jira comments) requires a workflow schema
change -- operators must add `deliveryTargets: ['jira_comment']` to their step's `outputContract`.
This partially violates criterion 1 ("no workflow JSON change to switch channels") for novel
targets. It fully satisfies criterion 4 for existing target types (new adapter for `github_...`
requires no schema change).

The deeper problem: `DeliveryTarget` types in the workflow schema are a commitment. Once
`'code_review_comment'` is in the compiled workflow definition, changing its rendering requires an
engine release, not just a config change. Approach 1's pure-config routing avoids this lock-in.

---

## Approach 3 (p=0.05): Event-Sourced Delivery Bus with Per-Session Delivery Plan

**Primary mechanism:** At session start, `runWorkflow()` builds a `DeliveryPlan` -- a list of
`DeliveryInstruction` values derived from resolved config -- and appends it as a `delivery_planned`
event to the session event log. When the session completes, a `DeliveryExecutor` reads the plan from
the log, executes each instruction, and appends `delivery_recorded` events for each outcome. The
gate subscribes to the delivery bus for `approval_request` instructions and blocks until a
`delivery_approved` event arrives.

### How it resolves each tension

**Delivery config ownership:**
The `DeliveryPlan` is resolved once at session start from the three-level config (global +
workflow-type + trigger), serialized into the event log as a `delivery_planned` event. Ownership is
at the session boundary: once the plan is recorded, it is immutable for that session. Operators
changing config only affects future sessions. The plan is readable from the session store, so the
console can display "this session will deliver to GitHub".

**Gate and delivery coupling:**
The `DeliveryPlan` includes an `ApprovalInstruction` for `human_approval` gates. The gate
checkpoint builder reads the plan (or the `delivery_planned` event in the session log) to find the
`ApprovalInstruction` and uses it to route the pending-approval notification. The gate has no
delivery-specific code -- it delegates to the instruction in the plan. The instruction carries all
state needed to resume after approval.

**Artifact type routing vs generic payload:**
The `DeliveryInstruction` union is typed by kind:
`CommitInstruction | DraftReviewInstruction | SlackInstruction | CallbackInstruction |
InboxInstruction`. Each instruction has a `render(artifacts[]) => payload` method. Routing is
`instructionKind x artifactKind -> rendered` -- but the mapping is in the instruction factory, not
in a registry. New instructions are additive.

**dispatch() path:**
`dispatch()` calls the same plan resolver used by `route()`. Since `dispatch()` has a
`WorkflowTrigger` with `workflowId`, the resolver can use global + workflow-type config.
`DeliveryPlan` is always built and recorded, even for dispatch sessions.

**Synchronous vs async delivery:**
Async instructions (draft review + poll) return a `DeliveryFuture` -- a serializable reference
to the in-flight delivery. The `DeliveryExecutor` writes a `delivery_pending` event when an
instruction returns a future, then polls from the sidecar recovery path on restart.

**Backward compatibility:**
Legacy fields (`callbackUrl`, `autoCommit`, etc.) are translated to equivalent `DeliveryInstruction`
values by the plan resolver. The plan resolver is the single migration point.

### Key tradeoffs

- Event-sourcing delivery is the most durable design: the delivery plan is permanent, auditable, and
  recoverable. Every delivery attempt is a session event. This is ideal from an observability and
  correctness standpoint.
- The `delivery_planned` event must be appended before the agent loop starts, but the config it
  encodes might conflict with what the workflow step actually produces (e.g. plan says "draft review"
  but the step fails to emit `wr.review_verdict`). The executor must handle mismatch gracefully.
- Appending `delivery_planned` at session start requires `runWorkflow()` to know the delivery config
  -- today it is delivery-free by design. This breaks the clean boundary between workflow execution
  and delivery. An alternative is to resolve and append the plan in `TriggerRouter` before calling
  `runWorkflow()`, but then `WorkflowRunResult` still carries nothing about the plan.
- Most importantly: this is the highest implementation cost of the five approaches. The
  event-sourced delivery bus requires changes to the session event schema (`delivery_planned`,
  `delivery_pending`, `delivery_recorded`, `delivery_approved`), the executor, the gate checkpoint
  builder, and the console. For a 3-year horizon this is worth it; for a 6-month horizon it is
  over-engineered.
- This approach is the only one where an external auditor can answer "what delivery was planned for
  this session?" by reading the session log without running any code. That is a genuine competitive
  advantage for compliance-sensitive operators.

### TypeScript shape

```typescript
// New session event kinds (adds to EVENT_KIND in constants.ts)
// 'delivery_planned'    -- delivery plan recorded at session start
// 'delivery_pending'    -- async delivery instruction dispatched (awaiting poll)
// 'delivery_recorded'   -- delivery completed (extends existing event)
// 'delivery_approved'   -- human approved via delivery channel (gate resume signal)

export type DeliveryInstruction =
  | { readonly kind: 'inbox'; readonly path: string }
  | { readonly kind: 'github_draft_review'; readonly token: string; readonly login: string; readonly prRepo: string; readonly prNumber: number }
  | { readonly kind: 'gitlab_mr_note'; readonly token: string; readonly baseUrl: string; readonly projectId: string; readonly mrIid: number }
  | { readonly kind: 'slack_webhook'; readonly webhookUrl: string }
  | { readonly kind: 'callback_url'; readonly url: string }
  | { readonly kind: 'git_commit'; readonly autoOpenPR: boolean; readonly workspacePath: string }
  | { readonly kind: 'approval_request'; readonly channelInstruction: DeliveryInstruction; readonly gateStepId: string };

export interface DeliveryPlan {
  readonly sessionId: string;
  readonly resolvedAt: string;         // ISO timestamp
  readonly instructions: readonly DeliveryInstruction[];
  readonly precedenceTrace: readonly string[]; // 'global' | 'workflow-type:wr.mr-review' | 'trigger:my-trigger'
}

export interface DeliveryPlanEvent {
  readonly kind: 'delivery_planned';
  readonly data: DeliveryPlan;
}

export interface DeliveryExecutor {
  /**
   * Execute all instructions in the plan after session completion.
   * Appends delivery_recorded or delivery_pending events per instruction.
   */
  execute(plan: DeliveryPlan, result: WorkflowRunSuccess, deps: DeliveryExecutorDeps): Promise<void>;
  /**
   * Resume polling for a pending instruction (called on daemon restart from sidecar).
   */
  resumePending(instruction: DeliveryInstruction, channelHandle: ChannelHandle): Promise<DeliveryOutcome>;
}
```

### Does it reach the ideal end state?

**Yes -- and beyond it.** All six criteria are satisfied. The event-sourced plan gives more than the
ideal end state: every delivery decision is auditable, every instruction is serializable, the gate
channel is derived from the plan rather than wired separately, and the `dispatch()` path gap is
closed at the session-start boundary.

The reason the probability is low (p=0.05): most AI assistants and most engineering teams gravitate
toward direct function calls (Approach 1) because event-sourcing feels heavy for a delivery
subsystem. It is not heavy -- it is the correct abstraction -- but it requires enough architectural
conviction to push through the higher initial implementation cost.

---

## Approach 4 (p=0.08): Delivery as a Functional Pipeline Stage with Open/Closed Extension

**Primary mechanism:** Replace the ad-hoc post-run logic in `TriggerRouter` with a single
`DeliveryPipelineResolver` that produces an ordered `readonly DeliveryStage[]` from delivery config
-- extending the existing `DeliveryStage` interface already used in `delivery-pipeline.ts`. Each
stage is a pure function from `(WorkflowRunSuccess, DeliveryStageConfig) -> DeliveryStageOutcome`.
The gate-and-notify behavior is a first-class `GateDeliveryStage` that blocks the pipeline.
New adapters are new stages; they are inserted into the resolved pipeline by the resolver.

### How it resolves each tension

**Delivery config ownership:**
The `DeliveryPipelineResolver` reads three-level config (same as Approach 1) and returns a
`readonly DeliveryStage[]`. The resolver is pure -- same inputs, same pipeline. Per-trigger
overrides are config, not code. The existing `DEFAULT_DELIVERY_PIPELINE` in `delivery-pipeline.ts`
becomes the fallback when the resolver finds no adapter config.

**Gate and delivery coupling:**
`GateDeliveryStage` is a new stage kind that combines delivery (post the output) with suspension
(return `'suspend'` outcome and store the gate token). The stage contract expands to include
`'continue' | 'stop' | 'suspend'`. When a `GateDeliveryStage` runs, it delivers output via the
configured adapter and then returns `'suspend'` with the gate token. `TriggerRouter` resumes the
session when the gate is satisfied, using the same stage's `resume()` method (optional on
`DeliveryStage`).

**Artifact type routing vs generic payload:**
Each `DeliveryStage` has a `canHandle(artifacts: readonly Artifact[]) => boolean` filter. The
resolver includes only stages whose filter returns true for the session's typed artifacts. A
`GitHubDraftReviewStage` only activates when `wr.review_verdict` is present. A `SlackStage` can
handle anything. This is additive routing, not a mapping table.

**dispatch() path:**
The resolver is a pure function of `(workflowId, globalConfig, triggerId?)`. When `triggerId` is
absent, the resolver uses global + workflow-type config only. The returned pipeline is identical
regardless of path. The dispatch path's current gap (TODO at trigger-router.ts:1361) is closed by
calling the same resolver with `triggerId: undefined`.

**Synchronous vs async delivery:**
`DeliveryStage` gains an optional `suspend()` method. Sync stages do not implement it. The
`GateDeliveryStage` and any polling stage implement `suspend()` to return a `SuspendHandle` that
the gate resume path calls `resume()` on. The `'suspend'` outcome in `DeliveryStageOutcome` carries
the handle.

**Backward compatibility:**
The existing `parseHandoffStage`, `gitDeliveryStage`, `cleanupWorktreeStage`, `deleteSidecarStage`
in `delivery-pipeline.ts` are already `DeliveryStage` implementations. They become the canonical
`'git_commit'` pipeline. The new resolver either includes them in the resolved pipeline (when
`autoCommit: true`) or replaces them with the new adapter stages. Zero changes to existing stage
implementations.

### Key tradeoffs

- The existing `DeliveryStage` interface in `delivery-pipeline.ts` is already the right abstraction.
  This approach extends it properly rather than replacing it -- lowest coupling to existing code.
- `'suspend'` as a new `DeliveryStageOutcome` is a clean discriminant but changes the interface
  contract for all existing stages. Existing stages must explicitly handle (or ignore) the new
  variant. The `assertNever` pattern on `outcome.kind` in `runDeliveryPipeline()` will catch any
  unhandled variant at compile time -- so the breaking change is safe but still a breaking change.
- The `canHandle()` filter per stage is elegant for extensibility but makes it less obvious which
  stage will run for a given workflow without tracing through all registered stages. A centralized
  routing table (Approach 1's registry) is more explicitly inspectable. This matters for
  `worktrain trigger validate` -- the validator needs to predict which delivery stages will activate
  for a trigger.
- Gate-as-a-stage makes gate behavior visible in the pipeline log output, which is a genuine
  observability win. The console could show "pipeline: [parse_handoff, github_draft_review,
  GATE: human_approval, ...]" which maps directly to the workflow's execution arc.
- This is the approach that most naturally extends what already exists. A senior engineer reading
  `delivery-pipeline.ts` would recognize this as the natural evolution of the existing staged
  design.

### TypeScript shape

```typescript
// Extensions to delivery-pipeline.ts

// New outcome variant (breaking change, safe via assertNever)
export type DeliveryStageOutcome =
  | { readonly kind: 'continue' }
  | { readonly kind: 'stop'; readonly reason: string }
  | { readonly kind: 'suspend'; readonly handle: SuspendHandle; readonly reason: string };

export interface SuspendHandle {
  readonly stageKind: string;     // e.g. 'gate_delivery'
  readonly data: Readonly<Record<string, unknown>>; // serializable, written to sidecar
}

// Extension to DeliveryStage for gate-capable stages
export interface SuspendableDeliveryStage extends DeliveryStage {
  /**
   * Called when the gate is satisfied (human approved or coordinator approved).
   * Returns the resume token for the engine to continue the session.
   */
  resume(handle: SuspendHandle, verdict: GateVerdict): Promise<string>; // returns gateToken
}

// New stage interface fields
export interface DeliveryStage {
  readonly name: string;
  /** True when this stage is relevant for the given artifacts. Default: always. */
  canHandle?(artifacts: readonly Artifact[]): boolean;
  run(
    result: WorkflowRunSuccess,
    trigger: TriggerDefinition,
    execFn: ExecFn,
    ctx: PipelineContext,
    deps?: DeliveryPipelineDeps,
  ): Promise<DeliveryStageOutcome>;
}

// DeliveryPipelineResolver: pure function, no side effects
export type DeliveryPipelineResolver = (
  workflowId: string,
  globalConfig: WorkrailConfig,
  triggerDefinition?: TriggerDefinition,
) => readonly DeliveryStage[];

// Example resolved pipeline for a review trigger:
// [parseHandoffStage, gitHubDraftReviewStage, gateDeliveryStage, cleanupWorktreeStage]
```

### Does it reach the ideal end state?

**Mostly.** Criteria 1-5 are fully satisfied. Criterion 6 (dispatch path gets same guarantees) is
satisfied once the resolver is called with `triggerId: undefined`.

The gap: `GateDeliveryStage` bridges gate and delivery cleanly for new adapters, but the existing
`human_approval` gate path in `TriggerRouter` must be refactored to use the pipeline suspension
model. This is non-trivial: today's `human_approval` path directly calls
`maybeRunPostWorkflowActions()`, which reads session store artifacts, calls `createDraftReview()`,
and starts `PendingDraftReviewPoller` -- all in one `void (async () => {})()` block. Refactoring
this into a `GateDeliveryStage` with a `SuspendHandle` requires decomposing this monolithic block,
which is the right thing to do but represents real effort.

The existing `DeliveryStage` interface in `delivery-pipeline.ts` is the strongest existing hook
point in the codebase. This approach leverages it without abandoning it.

---

## Approach 5 (p=0.02): Capability-Based Delivery Graph with Static Type Safety

**Primary mechanism:** Each workflow step declares a typed `OutputCapability` rather than an
artifact contract. Capabilities are named, versioned, and registered in a `CapabilityRegistry`. A
`DeliveryGraph` is a static TypeScript type that maps `OutputCapability -> readonly AdapterKind[]`.
The compiler enforces that every capability has at least one adapter configured. The gate fires
through the adapter that is statically known to handle `'awaiting_approval'` capability.

This approach is rare because it requires making delivery correctness a compile-time property
rather than a runtime property. The insight: if the type system can guarantee that every output
capability has a configured adapter, a category of runtime errors (unconfigured delivery, wrong
adapter for capability) becomes impossible.

### How it resolves each tension

**Delivery config ownership:**
`DeliveryGraph` is a TypeScript module that operators customize per-deployment. It is not YAML
config -- it is typed TypeScript code checked into the operator's deployment repo. Changing the
delivery channel means changing the `DeliveryGraph` module and redeploying. This sounds like more
work than editing `config.json`, but it has a decisive advantage: the type checker rejects an
invalid delivery graph at build time. An operator who removes the adapter for a capability they
still use gets a compile error, not a runtime warning.

**Gate and delivery coupling:**
`'awaiting_approval'` is an `OutputCapability`. The `DeliveryGraph` maps it to an adapter that
implements `GateAdapter extends DeliveryAdapter`. The gate checkpoint builder calls
`registry.resolveGateAdapter(capability)` -- a typed call that fails at compile time if no
gate-capable adapter is registered for this capability. The gate and delivery are decoupled at
runtime but coupled at the type level: the compiler guarantees they are always co-present.

**Artifact type routing vs generic payload:**
`OutputCapability` is a richer type than artifact kind. It declares not just what the artifact
IS but what it CAN be used for: `{ kind: 'code_review_comment', canRequestApproval: true,
renderable: ['markdown', 'github_review', 'gitlab_note'] }`. The adapter registry resolves to an
adapter that supports the required renderable format. No runtime mapping table.

**dispatch() path:**
`dispatch()` receives a `WorkflowTrigger` with `workflowId`. The `CapabilityRegistry` maps
`workflowId` to capabilities (compiled from the workflow definition). The `DeliveryGraph`
(statically known) maps capabilities to adapters. No trigger lookup needed.

**Synchronous vs async delivery:**
`GateAdapter` is a type-discriminated sub-interface of `DeliveryAdapter`. The type system
distinguishes sync adapters (`DeliveryAdapter`) from gate-capable adapters (`GateAdapter`).
Attempting to use a non-gate adapter for an `'awaiting_approval'` capability is a compile error.

**Backward compatibility:**
Legacy delivery config (`callbackUrl`, `autoCommit`, `reviewerIdentity`) must be translated to
`DeliveryGraph` entries via a one-time migration tool (`worktrain migrate-delivery-graph`). Existing
`triggers.yml` files cannot be used directly -- this is a breaking change. A shim layer could read
legacy fields at startup and synthesize a runtime `DeliveryGraph`, but this defeats the compile-time
safety guarantee that is the core value of this approach.

### Key tradeoffs

- This is the only approach that makes delivery misconfiguration a compile-time error rather than a
  runtime warning. For teams running WorkTrain in production, this is a significant reliability
  improvement. For solo operators who edit `config.json` in a text editor, it is a burden.
- The `DeliveryGraph` module couples deployment configuration to TypeScript code. This is unusual
  for operational tools (most operators expect YAML or JSON config) but is the correct choice for
  infrastructure that must be correct-by-construction. Terraform, Kubernetes controllers, and
  strongly-typed rule engines follow the same pattern.
- The migration burden from legacy fields is real. The existing `callbackUrl`, `autoCommit`,
  `reviewerIdentity` fields in `triggers.yml` are not TypeScript -- they are YAML. A one-time
  migration tool resolves this, but it creates a sharper upgrade cliff than Approach 1's migration
  shim.
- `CapabilityRegistry` adds an indirection layer between the workflow step and the delivery adapter.
  The registry must be kept in sync with the compiled workflow definitions. A mismatch between
  registered capabilities and what a workflow step actually emits is not caught at compile time --
  only at runtime when the adapter tries to render an unexpected artifact.
- This is the highest intellectual overhead for operators. Most WorkTrain operators are
  infrastructure engineers or developer tools engineers who are comfortable with TypeScript, but
  expecting them to edit a typed TypeScript module for delivery config is a higher bar than editing
  YAML.

### TypeScript shape

```typescript
// src/trigger/delivery/capability-registry.ts

export interface OutputCapability {
  readonly kind: string;           // e.g. 'code_review_comment'
  readonly version: number;
  readonly canRequestApproval: boolean;
  readonly renderableFormats: readonly ('markdown' | 'github_review' | 'gitlab_note' | 'json' | 'slack_blocks')[];
}

export const CAPABILITIES = {
  CODE_REVIEW_COMMENT: {
    kind: 'code_review_comment',
    version: 1,
    canRequestApproval: true,
    renderableFormats: ['github_review', 'gitlab_note', 'markdown'],
  },
  SUMMARY_NOTIFICATION: {
    kind: 'summary_notification',
    version: 1,
    canRequestApproval: false,
    renderableFormats: ['slack_blocks', 'markdown', 'json'],
  },
} as const satisfies Record<string, OutputCapability>;

// Delivery graph (typed TypeScript module, not YAML config)
// Operators customize this module per deployment.
export interface DeliveryGraph {
  /**
   * For each capability kind, the ordered list of adapters to invoke.
   * The compiler enforces this mapping covers all registered capabilities.
   */
  readonly routes: {
    readonly [K in keyof typeof CAPABILITIES]: readonly AdapterConfig[];
  };
  /**
   * The adapter to use for awaiting_approval gates.
   * Must implement GateAdapter. Compile error if not gate-capable.
   */
  readonly gateAdapter: GateAdapter;
}

// Example deployment delivery graph (operator-authored TypeScript):
export const myDeliveryGraph: DeliveryGraph = {
  routes: {
    CODE_REVIEW_COMMENT: [
      { kind: 'github_draft_review', token: process.env.GITHUB_REVIEWER_TOKEN!, login: 'etienneb' },
      { kind: 'slack_webhook', webhookUrl: process.env.SLACK_WEBHOOK_URL! },
    ],
    SUMMARY_NOTIFICATION: [
      { kind: 'slack_webhook', webhookUrl: process.env.SLACK_WEBHOOK_URL! },
    ],
  },
  gateAdapter: new GitHubDraftReviewAdapter({ token: process.env.GITHUB_REVIEWER_TOKEN!, login: 'etienneb' }),
};
```

### Does it reach the ideal end state?

**Yes -- with the strongest type safety guarantee of any approach, but at the highest adoption
cost.** All six criteria are technically satisfied. The key differentiators:

- Criterion 4 (new adapter in 18 months: zero changes to workflow JSON, `triggers.yml`, or engine
  code): fully satisfied. Adding a new adapter requires only implementing `DeliveryAdapter` and
  updating the `DeliveryGraph` module. The type checker enforces completeness.
- Criterion 5 (deterministic TypeScript routing): maximally satisfied. The routing is not just
  deterministic -- it is provably exhaustive at compile time.
- Criterion 6 (dispatch path): satisfied via capability-to-adapter resolution from compiled
  workflow definitions.

Where it falls short of ideal: the migration cliff is real. Existing operators would need to
author a typed `DeliveryGraph` module to adopt this approach. The lack of YAML-native config makes
this a non-starter for operators who treat WorkTrain as an appliance rather than a programmable
platform. A viable path: ship Approach 1 first, then offer Approach 5 as a "typed delivery graph"
feature for operators who want compile-time guarantees on top.

---

## Comparative Matrix

| Criterion | Approach 1 | Approach 2 | Approach 3 | Approach 4 | Approach 5 |
|---|---|---|---|---|---|
| Operator changes config, not workflow JSON | Full | Partial (new targets need schema) | Full | Full | Full |
| No silent output loss | Full | Full | Full | Full | Compile-time enforced |
| Gate control flow preserved | Full | Full (via target type) | Full | Full | Full |
| New adapter: zero changes to existing files | Full | Full (new platform) | Full | Full | Full |
| Deterministic TypeScript routing | Full | Full | Full | Full | Compile-time |
| dispatch() same guarantees as route() | Full | Full | Full | Full | Full |
| Backward compat: no trigger.yml migration | Shim | Shim | Shim | Shim | Migration required |
| Observability (auditable delivery decisions) | Log-level | Log-level | Session log (best) | Pipeline log | Build-time + log |
| Implementation cost | Medium | Medium | High | Low-Medium | High |
| Uses existing DeliveryStage abstraction | No | No | No | Yes | No |
| Async/sync adapter uniformity | Full | Full | Full | Full | Type-enforced |

## Recommendation

**Primary: Approach 4** (p=0.02 that a typical AI suggests it -- which is precisely why it is
the correct answer). Extend the existing `DeliveryStage` abstraction in `delivery-pipeline.ts`
rather than replacing it. Add `'suspend'` to `DeliveryStageOutcome`, introduce
`SuspendableDeliveryStage` for gate-capable adapters, and build a `DeliveryPipelineResolver` that
produces a typed pipeline from three-level config. This is the architectural fix, not a patch: it
extends the existing correct abstraction without abandoning the investment already made in
`parseHandoffStage`, `gitDeliveryStage`, etc.

**Secondary: Approach 3** for the session event log side of the story. Appending
`delivery_planned` events at session start costs almost nothing to implement and gives full
observability of delivery decisions -- which is what the console needs to display "this session
was planned to deliver to GitHub draft review". This is additive to Approach 4, not a competing
design.

**Approach 1** is the typical senior engineer's first instinct and is sound. The reason to prefer
Approach 4 is that the existing `DeliveryStage` interface is already the right abstraction; Approach
1 implicitly discards it and builds a parallel `DeliveryAdapter` interface. Two interfaces for the
same concept is a design smell that will cause confusion in 18 months.

**Approach 5** is the right answer for a 5-year horizon with a professional platform team.
It should be explicitly flagged as a future direction once Approach 4 is stable.
