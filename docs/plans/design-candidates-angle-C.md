# Output Delivery Design Candidates -- Angle C

**Framing angle:** Every candidate is stress-tested against the primary framing risk: what if
delivery and gating CANNOT be cleanly separated, and any attempt to separate them creates more
complexity than it solves?

**Persona:** pragmatic platform engineer who has watched elegant abstractions fail in production.
The goal is correct behavior, not architectural purity.

---

## Approach 1 (p=0.55): Typed Delivery Registry with Trigger-Level Override

**Primary mechanism:** A named `DeliveryTarget` registry (similar to the workflow registry)
where each target is declared in config.json once and referenced by name from triggers.yml.
Workflow JSON declares only what it produces (artifact kinds). Routing is a deterministic
lookup: `artifactKind -> triggerDeliveryTarget -> adapter.deliver(artifact)`.

### How it resolves each tension

**Delivery config ownership:** Targets live in `~/.workrail/config.json`
under `deliveryTargets: Record<string, DeliveryTargetConfig>`. Triggers reference by name
(`deliveryTarget: "github-draft-review"`). Per-trigger override is a different name reference,
not a field duplication. A default target can be declared at the workspace level in
`WorkspaceConfig`.

**Gate and delivery coupling:** This approach accepts the coupling as real. A `human_approval`
gate IS a delivery action -- the gate fires, creates the draft review (delivery), then parks
waiting for the operator to submit (gate control flow). The registry does not hide this; instead
it makes the delivery target for a `human_approval` gate explicit and configurable. The gate
definition in workflow JSON remains `requireConfirmation: { gateKind: "human_approval" }`.
The delivery target that backs that gate is wired at trigger config time, not at workflow
author time.

**Artifact type routing vs generic payload:** Each `DeliveryTarget` declares which artifact
kinds it handles (`handles: ["wr.review_verdict"]`). The delivery dispatcher iterates artifacts
from `lastStepArtifacts`, looks up targets that handle each kind, and calls them. Unknown kinds
fall through to the CLI inbox. This gives semantic precision without an N x M hardcoded matrix.

**dispatch() path:** `WorkflowTrigger` carries an optional `deliveryTargetName?: string`
forwarded from `TriggerDefinition`. The dispatch path looks up the target by name from the
registry injected into `TriggerRouter`. When absent, falls back to CLI inbox.

**Synchronous vs async delivery:** Each `DeliveryTarget` declares its delivery mode:
`mode: 'fire_and_forget' | 'poll_for_completion'`. The dispatcher handles both modes
without the caller knowing which adapter uses which. Polling is abstracted behind the
adapter's `awaitCompletion()` method.

**Backward compatibility:** `callbackUrl`, `autoCommit`, `autoOpenPR`, `reviewerIdentity`
all become named delivery targets at config load time. `trigger-store.ts` synthesizes
`DeliveryTargetConfig` entries from these legacy fields during parse. Zero changes to
existing triggers.yml files.

### Key tradeoffs

- The registry adds a layer of indirection. An operator debugging a broken delivery must
  look in both triggers.yml and config.json.
- Synthesizing legacy fields into registry entries at parse time is non-trivial migration
  logic that must be maintained indefinitely if backward compat is required.
- `mode: 'poll_for_completion'` on the adapter interface still leaks async behavior even
  though it is hidden from the dispatcher. The interface surface is honest but wide.
- The framing risk: if `human_approval` delivery and gate control flow truly cannot be
  separated, this approach still couples them -- it just moves the coupling from the
  workflow JSON into the trigger config. The gate fires delivery, then parks. The registry
  tells the gate which delivery target to use. This is slightly cleaner but not fundamentally
  different from today.

### Implementation shape

```typescript
// config.json shape
interface DeliveryTargetConfig =
  | { kind: 'github_draft_review'; token: string; login: string }
  | { kind: 'gitlab_mr_note';      token: string; projectId: string; baseUrl: string }
  | { kind: 'cli_inbox' }
  | { kind: 'callback_url';        url: string }
  | { kind: 'git_commit';          autoOpenPR?: boolean; secretScan?: boolean };

interface WorkrailConfig {
  deliveryTargets?: Record<string, DeliveryTargetConfig>;
  // existing fields...
}

// triggers.yml -- per trigger
interface TriggerDefinition {
  // existing fields...
  deliveryTarget?: string;  // references a key in config.json deliveryTargets
}

// Adapter interface
interface DeliveryAdapter {
  readonly kind: DeliveryTargetConfig['kind'];
  readonly mode: 'fire_and_forget' | 'poll_for_completion';

  deliver(
    artifact: unknown,
    context: DeliveryContext,
  ): Promise<DeliveryOutcome>;

  // Only called when mode === 'poll_for_completion'
  awaitCompletion?(handle: DeliveryHandle): Promise<DeliveryCompletionResult>;
}

type DeliveryOutcome =
  | { readonly _tag: 'delivered'; readonly handle?: DeliveryHandle }
  | { readonly _tag: 'skipped';   readonly reason: string }
  | { readonly _tag: 'failed';    readonly error: string };

type DeliveryCompletionResult =
  | { readonly kind: 'completed'; readonly completedAt: string }
  | { readonly kind: 'pending' }
  | { readonly kind: 'error';     readonly error: string };

// DeliveryContext: what the adapter receives
interface DeliveryContext {
  readonly triggerId: string;
  readonly workflowId: string;
  readonly sessionId?: string;
  readonly prNumber?: number;
  readonly prRepo?: string;
  readonly prUrl?: string;
}

// DeliveryHandle: opaque token for poll-for-completion
type DeliveryHandle = { readonly kind: string; readonly id: unknown };

// Dispatcher: called from trigger-router after workflow completes
async function dispatchDelivery(
  artifacts: readonly unknown[],
  context: DeliveryContext,
  target: DeliveryTargetConfig,
  adapterRegistry: Map<string, DeliveryAdapter>,
): Promise<void>;
```

### Framing risk assessment

**Partially resilient.** If the framing is wrong and delivery + gating cannot be separated,
this approach does not break -- it just means `human_approval` gates always use a
`poll_for_completion` adapter and the dispatcher must be aware of gate-parked sessions.
The registry still provides the value of making the delivery target configurable. However,
the `awaitCompletion` method on the adapter interface means every adapter that does not need
polling must implement a no-op or the interface must be split. That split is the first sign
of the framing failure surfacing as code complexity.

---

## Approach 2 (p=0.30): Output Contract + Post-Run Action Chain

**Primary mechanism:** Workflows declare a typed output contract (`outputContract: { produces:
["wr.review_verdict"] }`). After each workflow completes, a deterministic action chain reads
the output contract, looks up registered post-run actions for each produced artifact kind,
and executes them in order. Gates remain in the engine; delivery is a post-run hook on
`WorkflowRunResult`, not a gate behavior.

### How it resolves each tension

**Delivery config ownership:** Post-run actions are registered at the trigger level
(`postRunActions: [{ on: "wr.review_verdict", action: "github_draft_review" }]`) and at
a workspace default level. The action definition (credentials, target) lives in
`config.json`. Per-trigger override adds a `postRunActions` entry; workspace default
reduces duplication. Precedence: trigger > workspace > global default (CLI inbox).

**Gate and delivery coupling:** This is the approach that most aggressively tries to
separate them. Gates are engine execution pauses. Delivery is a post-run action that fires
after the session reaches a terminal or gate-parked state. For `human_approval` specifically:
the gate parks the session, the post-run action chain fires and creates the draft review,
the poller runs asynchronously to detect operator submission, and then separately
re-enqueues the session for resumption. Gate and delivery have different lifecycles --
the gate does not own the delivery, the action chain does.

**Artifact type routing vs generic payload:** Explicit: each action is registered for a
specific artifact kind. The action chain iterates `lastStepArtifacts` and dispatches
by kind. No N x M matrix in code -- the mapping is data.

**dispatch() path:** `WorkflowTrigger` carries `postRunActions?: readonly PostRunActionConfig[]`
forwarded from the trigger definition. The action chain is always available; dispatch path
gets same guarantees.

**Synchronous vs async delivery:** The action chain executes synchronously for
`fire_and_forget` actions (Slack, GitLab MR note, callbackUrl) and kicks off background
tasks for `poll_for_completion` actions (GitHub draft review poller). The distinction is
per-action-implementation, not per-call-site.

**Backward compatibility:** All existing delivery mechanisms (`autoCommit`, `autoOpenPR`,
`callbackUrl`, `reviewerIdentity`) are translated into equivalent `PostRunActionConfig`
entries at parse time. The output is identical.

### Key tradeoffs

- Aggressive separation of concerns is the explicit goal here, but the framing risk bites
  hardest here. If `human_approval` truly requires the gate to own the delivery (because
  the operator's submission of the draft review IS the gate verdict signal), then splitting
  them means: the action chain creates the draft review, the poller detects submission,
  and a separate mechanism resumes the gate. That mechanism must know the gate token. The
  gate token must flow through the action chain context into the poller. This is the exact
  complexity explosion the framing risk predicts.
- Testing the action chain in isolation is straightforward. Testing the full round-trip
  (gate parks -> action fires -> poller detects -> gate resumes) requires an integration
  test that touches four components.
- Adding a new post-run action in 18 months requires: one new `PostRunActionConfig` variant,
  one new action implementation. Zero engine changes. This criterion is cleanly met.

### Implementation shape

```typescript
// Workflow JSON (output contract -- what the workflow produces)
interface WorkflowStepDefinition {
  // existing fields...
  outputContract?: {
    produces: readonly string[]; // e.g. ["wr.review_verdict"]
  };
}

// triggers.yml (what to do with produced artifacts)
interface PostRunActionConfig =
  | { readonly on: string; readonly action: 'github_draft_review'; readonly targetRef: string }
  | { readonly on: string; readonly action: 'gitlab_mr_note';      readonly targetRef: string }
  | { readonly on: string; readonly action: 'cli_inbox' }
  | { readonly on: string; readonly action: 'callback_url';        readonly url: string };

interface TriggerDefinition {
  // existing fields...
  postRunActions?: readonly PostRunActionConfig[];
}

// Action interface
interface PostRunAction {
  readonly actionKind: string;
  execute(
    artifact: unknown,
    context: PostRunActionContext,
  ): Promise<PostRunActionResult>;
}

interface PostRunActionContext {
  readonly triggerId: string;
  readonly workflowId: string;
  readonly sessionId?: string;
  readonly workrailSessionId?: string;
  readonly gateToken?: string;     // present when result._tag === 'gate_parked'
  readonly gateKind?: GateKind;    // present when result._tag === 'gate_parked'
  readonly prContext?: {
    readonly prNumber: number;
    readonly prRepo: string;
    readonly prUrl: string;
  };
}

type PostRunActionResult =
  | { readonly _tag: 'ok';      readonly continuationHandle?: ContinuationHandle }
  | { readonly _tag: 'skipped'; readonly reason: string }
  | { readonly _tag: 'failed';  readonly error: string };

// ContinuationHandle: produced by poll_for_completion actions
// so the gate resume knows where to look
interface ContinuationHandle {
  readonly kind: 'review_poller';
  readonly reviewId: number;
  readonly prRepo: string;
  readonly prNumber: number;
}

// The chain runner -- called from TriggerRouter after workflow completes
async function runPostRunActionChain(
  result: WorkflowRunResult,
  actions: readonly PostRunActionConfig[],
  context: PostRunActionContext,
  actionRegistry: Map<string, PostRunAction>,
): Promise<void>;
```

### Framing risk assessment

**Most exposed.** This approach assumes delivery and gating CAN be separated. If the framing
is wrong -- if the `human_approval` gate fundamentally requires the delivery to be done
within the gate's own lifecycle (because the operator's review submission IS the gate signal
and must flow back to resume the session) -- then this approach adds real complexity:
the gate token must be plumbed through the action context into the poller, and the poller
must call a gate-resume function that knows how to rehydrate the parked session. Today's
code does this in `trigger-router.ts` where both sides are visible. Splitting them means
the poller callback acquires a dependency on gate resumption that makes it harder to test
and reason about in isolation.

---

## Approach 3 (p=0.08): Imperative Delivery Steps in Workflow JSON

**Primary mechanism:** Abandon the adapter abstraction entirely. Workflow authors declare
explicit delivery steps using a new step type (`type: "deliver"`) with a `channel` field.
The engine executes delivery steps as first-class workflow steps, deterministically, in
the workflow's declared order. Delivery is workflow behavior, not post-run infrastructure.

### How it resolves each tension

**Delivery config ownership:** `channel` references a named delivery target from
`config.json` (same registry as Approach 1). Workflow JSON names the channel;
config.json holds credentials. Per-trigger override is not needed -- the workflow
controls when and where it delivers. If a different target is needed, use a different
workflow variant or parameterize the channel via context variables.

**Gate and delivery coupling:** This approach names the coupling and makes it explicit.
A `deliver` step followed by a `requireConfirmation: { gateKind: "human_approval" }` step
is the canonical way to express "deliver, then wait for human." The engine executes them
in sequence. No separation is attempted because none is needed -- the workflow is the
specification of what happens in what order.

**Artifact type routing vs generic payload:** The `deliver` step specifies which artifact
to send: `artifact: "wr.review_verdict"`. No routing table. The engine finds the artifact
in the session state, resolves the channel, calls the adapter. If the artifact is absent,
the step fails with a structured error.

**dispatch() path:** Delivery happens inside the workflow execution, so the dispatch path
gets identical behavior automatically. No special-casing needed.

**Synchronous vs async delivery:** The engine executes the `deliver` step and waits for
the adapter to confirm delivery before advancing. For async platforms (GitHub draft review),
the adapter returns immediately with a delivery handle, and the next step in the workflow
can be a poll step or a gate. The workflow author models the async explicitly.

**Backward compatibility:** Existing workflows do not change. The `deliver` step type is
opt-in. Legacy `autoCommit`/`reviewerIdentity` paths continue working. New workflows can
use the explicit step type.

### Key tradeoffs

- This is the most honest model if the framing is wrong -- it does not attempt to separate
  delivery from gating because they ARE the same thing in the workflow's execution sequence.
- It requires workflow authors to understand delivery. Today, delivery is invisible to
  workflow authors; it is a platform concern. Making it a workflow step mixes platform
  concerns into the workflow definition, coupling them.
- A `deliver` step in workflow JSON means operators cannot change the delivery channel
  without editing workflow JSON. This violates criterion 1 directly -- unless `channel`
  is parameterized via context variables and the operator sets the context at trigger
  config time. That parameterization restores operator control but adds indirection.
- Changing the delivery channel in 18 months requires updating workflow JSON. If the
  workflow is bundled (shipped with workrail), that is a source change. Criterion 4 is
  weakened.
- The staged `deliver` step type requires engine changes: new step type, new execution
  path in `durable-core`, new event kinds. This is the largest implementation footprint
  of all approaches.

### Implementation shape

```typescript
// Workflow JSON -- new step type
interface DeliverStepDefinition {
  readonly type: 'deliver';
  readonly id: string;
  readonly artifact: string;           // artifact kind to deliver, e.g. "wr.review_verdict"
  readonly channel: string;            // named delivery target from config.json
  readonly onFailure?: 'stop' | 'continue';  // default: 'stop'
}

// Union of all step types (existing + new)
type WorkflowStepDefinition =
  | ExistingStepDefinition
  | DeliverStepDefinition;

// config.json -- same registry as Approach 1
type DeliveryChannelConfig =
  | { kind: 'github_draft_review'; token: string; login: string }
  | { kind: 'gitlab_mr_note';      token: string; projectId: string; baseUrl: string }
  | { kind: 'cli_inbox' }
  | { kind: 'callback_url';        url: string };

// Engine: new event kinds
type NewEngineEventKind =
  | 'delivery_step_started'
  | 'delivery_step_completed'
  | 'delivery_step_failed';

// Adapter called by engine during step execution
interface ChannelAdapter {
  readonly channelKind: string;
  deliver(
    artifact: unknown,
    channelConfig: DeliveryChannelConfig,
  ): Promise<DeliveryStepResult>;
}

type DeliveryStepResult =
  | { readonly _tag: 'delivered'; readonly externalId?: string }
  | { readonly _tag: 'failed';    readonly error: string };
```

### Framing risk assessment

**Most resilient.** This approach does not assume delivery and gating can be separated --
it makes them adjacent workflow steps with explicit ordering. If the framing is wrong and
they must be coupled, workflow authors couple them deliberately in the step sequence. If the
framing is right and they can be separated, authors can put a `deliver` step anywhere.
The risk is different: it couples delivery to workflow authoring, violating criterion 1 unless
`channel` is parameterized.

---

## Approach 4 (p=0.05): Gate-Owned Delivery Protocol

**Primary mechanism:** Accept that `human_approval` gates own their delivery mechanism.
Formalize this as a `GateDeliveryProtocol` -- a discriminated union where each `GateKind`
declares exactly what delivery it performs. No generic adapter registry. The gate IS the
delivery. `coordinator_eval` gates deliver to the autonomous evaluator. `human_approval`
gates deliver to the configured reviewer channel. Adding a new gate kind adds a new
protocol member.

### How it resolves each tension

**Delivery config ownership:** `reviewerIdentity` (already on `TriggerDefinition`) is the
delivery config for `human_approval` gates. New gate kinds add their own config fields to
`TriggerDefinition`. Per-trigger override is natural -- each trigger has its own gate
delivery config. No registry indirection.

**Gate and delivery coupling:** This approach names the coupling as correct and designs for
it. The `GateDeliveryProtocol` type makes the coupling explicit and exhaustive. There is no
illusion that delivery and gating are separate -- they are the same thing for gate-type
operations. Non-gate delivery (post-workflow artifact export, callbackUrl) remains a separate
mechanism and is not affected.

**Artifact type routing vs generic payload:** The gate's delivery protocol is
artifact-type-specific by construction. `human_approval` delivers `wr.review_verdict` to
the reviewer channel. The routing is encoded in the protocol definition, not in a routing
table.

**dispatch() path:** `WorkflowTrigger` carries `gateDeliveryConfig?: GateDeliveryConfig`
forwarded from `TriggerDefinition`. The dispatch path handles gate-parked results using
this config. Identical guarantees.

**Synchronous vs async delivery:** Each `GateDeliveryProtocol` member defines its own
delivery lifecycle. `human_approval` is inherently async (poller). `coordinator_eval` is
synchronous (spawn evaluator, await verdict). The type system enforces that each kind has
the right lifecycle shape.

**Backward compatibility:** `reviewerIdentity` maps directly to `human_approval` gate
delivery config. No migration needed.

### Key tradeoffs

- This approach is the most honest about what the code actually does today. The
  `human_approval` gate in `trigger-router.ts` already owns its delivery. This approach
  names that pattern and makes it the design.
- Criterion 4 (adding a new adapter in 18 months requires zero engine/workflow/trigger
  changes) is NOT met. Adding a new gate kind with a new delivery mechanism requires
  updating the `GateKind` union (compile-enforced) and all `switch(gateKind)` handlers.
  That is by design -- it is the `assertNever` exhaustiveness guarantee.
- Non-gate delivery (artifacts that need to reach humans or systems outside the gate flow)
  still has no clean path. This approach only addresses gate-coupled delivery, not the
  general case.
- The operator cannot change the delivery channel for a `human_approval` gate without
  changing `reviewerIdentity` in triggers.yml -- but that is a single field change in one
  file. Criterion 1 is met in practice, even if it is not architecturally elegant.

### Implementation shape

```typescript
// GateDeliveryProtocol: one member per GateKind
type GateDeliveryProtocol =
  | {
      readonly gateKind: 'coordinator_eval';
      readonly evaluatorWorkflowId: string;
      readonly timeoutMs: number;
    }
  | {
      readonly gateKind: 'human_approval';
      readonly reviewerIdentity: ReviewerIdentity;
      readonly pollIntervalMs?: number;
    };

// GateKind stays as-is -- exhaustive union
type GateKind = 'coordinator_eval' | 'human_approval'; // adding a kind = compile error in switch

// TriggerDefinition: explicit gate delivery config replaces reviewerIdentity
interface TriggerDefinition {
  // existing fields...
  // reviewerIdentity is deprecated in favor of gateDelivery
  readonly gateDelivery?: GateDeliveryProtocol;
}

// WorkflowTrigger: carries resolved gate delivery config
interface WorkflowTrigger {
  // existing fields...
  readonly gateDelivery?: GateDeliveryProtocol;
}

// GateDeliveryDispatcher: called from TriggerRouter when result._tag === 'gate_parked'
interface GateDeliveryDispatcher {
  dispatch(
    gateParked: WorkflowRunGateParked,
    trigger: WorkflowTrigger,
    ctx: V2ToolContext,
  ): Promise<void>;
}

// Implementation: exhaustive switch on protocol.gateKind
function createGateDeliveryDispatcher(
  coordinatorDeps: AdaptiveCoordinatorDeps,
  reviewApprovalAdapter: ReviewApprovalAdapter,
): GateDeliveryDispatcher;
```

### Framing risk assessment

**Fully resilient -- by accepting the framing as correct.** If delivery and gating cannot
be cleanly separated for gate types, this approach embraces that reality and makes it
structurally sound. If the framing is wrong and some gate kinds genuinely do not require
delivery, they simply declare a protocol member with no delivery fields. The exhaustive
switch is the invariant that prevents silent omissions. The weakness is the opposite: if
a new gate kind needs delivery that is NOT tightly coupled to gate control flow (e.g. a
gate that sends a Slack notification and then evaluates autonomously), this model wants
to put the Slack delivery inside the gate protocol. That coupling may be unnecessary.

---

## Approach 5 (p=0.02): Flat Delivery Event Log with Replay

**Primary mechanism:** Every delivery action -- draft review creation, MR note posting,
callbackUrl post, git commit -- is modeled as a `DeliveryEvent` appended to the session
event log. Post-workflow delivery is not a function call chain; it is event sourcing.
A `DeliveryExecutor` reads pending `delivery_requested` events and executes them idempotently.
Crash recovery, retries, and ordering are all handled by the event log.

### How it resolves each tension

**Delivery config ownership:** `delivery_requested` events carry the delivery target config
at the time they are appended (snapshot, not a reference). Trigger-level config determines
which events are appended. Changing the delivery channel for a future run changes what
events are appended on the next session; in-flight sessions use the config that was active
when they started.

**Gate and delivery coupling:** The event log separates them in time but not in causality.
A `gate_parked` event in the log is followed by a `delivery_requested` event for the
draft review. The `DeliveryExecutor` reads the `delivery_requested` event and acts on it.
Gate resumption happens when a `gate_resume_requested` event appears (appended by the
poller when submission is detected). The session event log is the single source of truth
for what happened and what still needs to happen.

**Artifact type routing vs generic payload:** `delivery_requested` events carry a typed
`artifactKind` field and a `targetKind` field. The executor dispatches on `targetKind`;
the `artifactKind` tells it which artifact to read from the session state.

**dispatch() path:** Delivery events are appended to the session log regardless of how the
session was started. The executor polls or is triggered after session completion. Same
guarantees.

**Synchronous vs async delivery:** All delivery is async by design -- events are appended
and executed asynchronously. Synchronous confirmation is not possible in this model.
For callers that need to know "delivery succeeded before proceeding," the event log provides
a `delivery_completed` event to poll against. This is honest about async reality but
complicates callers that today run synchronously.

**Backward compatibility:** The existing delivery pipeline continues running as today.
Migrating to the event-log model is incremental: each mechanism can be migrated one at a
time by appending `delivery_requested` events instead of calling functions directly.

### Key tradeoffs

- Event sourcing is the correct model for durable, crash-safe delivery. It is also the
  most complex model. The existing session event log infrastructure (`durable-core`)
  exists, but adding a delivery execution layer on top of it is a significant build.
- The `DeliveryExecutor` must be a long-running process or must be triggered somehow.
  Today the daemon starts immediately after session completion. With event sourcing,
  there is a gap between "session completed" and "delivery executed" that must be managed.
- Idempotency for each delivery action (draft review creation, git commit) is non-trivial.
  The existing `GitHubReviewApprovalAdapter` has an in-process dedup guard; at-least-once
  semantics require a persistent dedup key in the event log.
- Criterion 5 (delivery routing is deterministic TypeScript code, not LLM reasoning) is met.
  But the routing is spread across event schemas, the executor's dispatch logic, and the
  event appenders. Three places to understand instead of one.
- This is the approach with probability 0.02 for a reason: it solves a harder version of
  the problem than is required. Delivery events in a session log are valuable for
  observability, but full event-sourced execution of delivery is significant over-engineering
  for the current problem.

### Implementation shape

```typescript
// New event kinds added to the session event log
type DeliveryEventKind =
  | 'delivery_requested'
  | 'delivery_executing'
  | 'delivery_completed'
  | 'delivery_failed'
  | 'gate_resume_requested';

// delivery_requested event data
interface DeliveryRequestedEventData {
  readonly artifactKind: string;
  readonly targetKind: string;
  readonly targetConfig: DeliveryTargetSnapshot; // config snapshot at append time
  readonly prContext?: { prNumber: number; prRepo: string; prUrl: string };
}

// Snapshot of delivery config (not a reference -- avoids TOCTOU on config changes)
type DeliveryTargetSnapshot =
  | { kind: 'github_draft_review'; token: string; login: string }
  | { kind: 'cli_inbox' }
  | { kind: 'callback_url'; url: string }
  | { kind: 'git_commit'; flags: DeliveryFlags };

// DeliveryExecutor: reads pending delivery_requested events and executes them
interface DeliveryExecutor {
  // Called after session transitions to a terminal or gate-parked state
  executePending(sessionId: SessionId): Promise<void>;
}

// Adapter interface -- same as Approach 1 but called by the executor
interface DeliveryAdapter {
  readonly targetKind: string;
  execute(
    artifact: unknown,
    config: DeliveryTargetSnapshot,
    context: DeliveryExecutionContext,
  ): Promise<DeliveryAdapterResult>;
}

type DeliveryAdapterResult =
  | { readonly _tag: 'ok';      readonly externalId?: string }
  | { readonly _tag: 'retry';   readonly retryAfterMs: number }
  | { readonly _tag: 'failed';  readonly error: string };

interface DeliveryExecutionContext {
  readonly sessionId: SessionId;
  readonly workrailSessionId?: string;
  readonly gateToken?: string;
  readonly appendEvent: (event: SessionEvent) => Promise<void>;
}
```

### Framing risk assessment

**Resilient by making coupling explicit in the data model.** The event log records both
`gate_parked` and `delivery_requested` as separate events, making their causal relationship
visible and auditable. If delivery and gating cannot be cleanly separated in logic, they
CAN be separated in the event timeline -- the log shows what happened and in what order.
The risk is complexity: the executor, event schemas, idempotency guards, and the recovery
path for incomplete deliveries are all new infrastructure. If the framing IS wrong and
delivery + gating must be tightly coupled in execution (not just observed as coupled in
events), event sourcing adds latency and complexity without solving the core problem.
