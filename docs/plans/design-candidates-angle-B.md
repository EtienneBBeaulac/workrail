# Output Delivery Design Candidates -- Angle B

**Focus angle:** Anchor every candidate to the riskiest assumption. Build the most defensible design that does NOT bet on any single assumption being true. Design for the case where assumptions turn out to be wrong.

**Persona:** A cautious staff engineer who has been burned by over-engineered plugin systems and believes the simplest thing that works is usually right -- but also knows what "simple" actually costs long-term.

**Riskiest assumption:** The adapter interface can be uniform enough to handle both synchronous (Slack POST) and asynchronous (GitHub draft + poll) delivery without leaking platform-specific concerns. If this is wrong, a single adapter interface cannot hide the sync/async difference, and any design that pretends it can will develop a leaky abstraction over time.

---

## Approach 1 (p=0.55): Named Adapter Registry with Explicit Async Completion Tokens

**Primary mechanism:** A `DeliveryAdapter` interface with two methods -- `deliver(payload)` returning a `DeliveryReceipt` discriminated union (`{ kind: 'completed' }` | `{ kind: 'pending'; pollHandle: PollHandle }`). The adapter registry is populated at daemon startup. Config resolution follows a precedence order: trigger-level > workflow-type-level > global. Post-workflow dispatch calls `registry.resolve(config)` and invokes `deliver()`. Pending receipts are tracked in a sidecar store and polled by a background `DeliveryPoller`.

**How it resolves each tension:**

- *Delivery config ownership:* A `DeliveryConfig` type (a discriminated union of adapter refs and their params) lives at three locations -- `TriggerDefinition.delivery`, a `~/.workrail/config.json` `deliveryDefaults` section keyed by workflow type, and a global fallback. Resolution at dispatch time: trigger beats workflow-type beats global.
- *Gate and delivery coupling:* Gates inherit their delivery config by calling the same resolver. When `gate_parked` fires, the router calls `resolveDeliveryConfig(workflowTrigger, trigger)` and invokes the adapter's `deliverGateNotification(payload, config)` method -- a distinct method from `deliver()` that sends an "awaiting approval" message rather than a final result. The gate does not own the adapter; it calls it.
- *Artifact type routing vs generic payload:* The adapter interface accepts a `DeliveryPayload` type which is a tagged union: `{ kind: 'result'; artifacts: WorkflowArtifact[]; notes: string | null }` | `{ kind: 'gate_notification'; stepId: string; context: GateContext }`. Adapters that don't care about artifact type can match on `kind: 'result'` and serialize everything. Type-aware adapters narrow on specific artifact kinds. No N x M mapping -- adapters opt in to typed handling.
- *dispatch() gap:* `WorkflowTrigger` gains a `deliveryConfig?: DeliveryConfig` field, set by the trigger layer when it exists. `dispatch()` reads it from `workflowTrigger.deliveryConfig` if present, falls back to global config. The gap is closed by forwarding config onto the DTO -- the same pattern already used for `reviewerIdentity`.
- *Synchronous vs async delivery:* The `DeliveryReceipt` union makes sync/async explicit. A `{ kind: 'pending'; pollHandle: PollHandle }` receipt is written to a sidecar store immediately. A `DeliveryPoller` background task drives pending receipts to completion. Adapters that are inherently synchronous return `{ kind: 'completed' }` and the poller is never involved. No adapter lies about its nature.
- *Backward compatibility:* The four existing mechanisms (`callbackUrl`, `autoCommit+autoOpenPR`, `reviewerIdentity`, `NotificationService`) are wrapped as adapters during a migration window. `maybeRunDelivery()` and `maybeRunPostWorkflowActions()` remain in place but delegate to the adapter when a `deliveryConfig` is present; otherwise they fall through to the existing code. Feature flag controls the transition.

**Key tradeoffs:**

- The `PollHandle` type leaks some platform shape -- an HTTP polling adapter needs a URL while a GitHub review poller needs a reviewId. `PollHandle` becomes a tagged union itself or a `Record<string, unknown>` opaque blob. The opaque-blob approach trades type safety for simplicity; the tagged union approach requires the poller to know about adapter kinds.
- The sidecar store for pending receipts is a new persistence surface. It must be crash-safe (write before start, delete after completion) -- the same invariant already proven for the `pending-draft-review-poller` sidecar.
- Resolution at dispatch time means `dispatch()` callers must now populate `workflowTrigger.deliveryConfig`. This is additive (the field is optional) but requires callers to be updated over time.

**Implementation shape:**

```typescript
// Discriminated union: delivery is either instant or needs follow-through
type DeliveryReceipt =
  | { readonly kind: 'completed'; readonly detail?: string }
  | { readonly kind: 'pending'; readonly pollHandle: PollHandle };

// PollHandle is opaque at the adapter interface level -- adapters know their own shape
type PollHandle = { readonly adapterId: string; readonly state: Readonly<Record<string, unknown>> };

interface DeliveryPayload {
  readonly kind: 'result' | 'gate_notification';
  readonly workflowId: string;
  readonly sessionId?: string;
  readonly artifacts: readonly WorkflowArtifact[];
  readonly notes: string | null;
  readonly context: Readonly<Record<string, unknown>>;
}

interface DeliveryAdapter {
  readonly id: string;
  deliver(payload: DeliveryPayload, config: AdapterConfig): Promise<DeliveryReceipt>;
  poll?(handle: PollHandle): Promise<'done' | 'waiting' | 'failed'>;
  deliverGateNotification?(payload: DeliveryPayload, config: AdapterConfig): Promise<void>;
}

type DeliveryConfig =
  | { readonly adapter: 'github_draft_review'; readonly token: string; readonly login: string }
  | { readonly adapter: 'slack_webhook'; readonly url: string }
  | { readonly adapter: 'cli_inbox' }
  | { readonly adapter: 'callback_url'; readonly url: string };

// Resolution: trigger beats workflow-type beats global
function resolveDeliveryConfig(
  trigger: TriggerDefinition | undefined,
  workflowTypeDefaults: ReadonlyMap<string, DeliveryConfig>,
  globalDefault: DeliveryConfig,
  workflowId: string,
): DeliveryConfig { ... }
```

**Riskiest assumption -- bet or avoid?**

This approach explicitly avoids the bet. The `DeliveryReceipt` union exposes sync/async as a first-class distinction. The `poll()` method is optional on the interface -- sync-only adapters omit it. Adapters are not forced into a uniform async model; they declare their nature via the receipt type. The tradeoff: `PollHandle.state` being `Record<string, unknown>` sacrifices some type safety for adapter independence. If you later need to enforce the shape of poll state, you widen `PollHandle` to a union -- that is additive, not breaking.

---

## Approach 2 (p=0.25): Delivery as a First-Class Workflow Output Step (Push, Not Pull)

**Primary mechanism:** Instead of routing at the router layer after `runWorkflow()` returns, each workflow that wants external delivery emits a `wr.delivery_intent` typed artifact on its final step. The `DeliveryDispatcher` (a new post-run actor) reads `lastStepArtifacts`, finds `wr.delivery_intent` entries, and executes the appropriate adapter. Delivery config is NOT on the workflow JSON -- `wr.delivery_intent` carries a `channel` field (`'configured'` | `'github_draft_review'` | `'slack'`) and the dispatcher resolves the actual adapter from trigger/global config at execution time.

**How it resolves each tension:**

- *Delivery config ownership:* Dual-layer still applies: `wr.delivery_intent.channel: 'configured'` defers to trigger/global config. `wr.delivery_intent.channel: 'github_draft_review'` is a hint from the workflow but the dispatcher validates that the actual configured adapter supports it -- the workflow cannot override an unconfigured adapter.
- *Gate and delivery coupling:* When `gate_parked` fires, the engine can emit a synthetic `wr.delivery_intent { channel: 'configured', intent: 'gate_notification' }` artifact into the session store. The same dispatcher processes it. Gate and delivery share no direct code path -- both flow through the `wr.delivery_intent` contract.
- *Artifact type routing vs generic payload:* Routing happens in two stages: first the `wr.delivery_intent` artifact identifies the channel; then the dispatcher passes all `lastStepArtifacts` to the adapter. The adapter decides what to render. No N x M -- the intent artifact is the routing signal, not the artifact kind.
- *dispatch() gap:* Same `deliveryConfig` forwarding as Approach 1 applies here. The intent artifact is embedded in the session, not the trigger call.
- *Synchronous vs async delivery:* Same `DeliveryReceipt` model as Approach 1 -- this approach does not change how adapters signal their completion mode.
- *Backward compatibility:* Workflows that do not emit `wr.delivery_intent` fall through to the existing `maybeRunDelivery` / `maybeRunPostWorkflowActions` path. Migration is per-workflow, not a flag.

**Key tradeoffs:**

- This design pushes routing intelligence into the workflow artifact, which is a small but real coupling. A workflow that emits `wr.delivery_intent { channel: 'github_draft_review' }` is expressing a delivery preference in its output -- that is still a form of workflow-level delivery awareness, even if it does not encode credentials or URLs.
- Requires a schema change (new `wr.delivery_intent` kind in `spec/authoring-spec.json` and `spec/workflow.schema.json`). This satisfies the open/closed criterion for adapters but costs a schema migration.
- Gate delivery via synthetic artifact is conceptually clean but requires the engine (or the gate handler in `trigger-router.ts`) to write an artifact into the session store -- a new write path that must be tested for crash safety.
- The dispatcher becomes a second post-workflow actor alongside `maybeRunDelivery` and `maybeRunPostWorkflowActions`. Without removing the old code, there are now three places post-workflow side effects can happen.

**Implementation shape:**

```typescript
// New artifact kind added to spec/authoring-spec.json
interface WorkflowDeliveryIntentArtifact {
  readonly kind: 'wr.delivery_intent';
  readonly channel: 'configured' | 'github_draft_review' | 'slack' | 'cli_inbox';
  readonly intent: 'final_result' | 'gate_notification';
  readonly version: '1';
}

// DeliveryDispatcher reads this from lastStepArtifacts and dispatches
interface DeliveryDispatcher {
  dispatch(
    intent: WorkflowDeliveryIntentArtifact,
    allArtifacts: readonly WorkflowArtifact[],
    notes: string | null,
    config: ResolvedDeliveryConfig,
  ): Promise<DeliveryReceipt>;
}

// Config resolution remains at the trigger/global layer -- intent artifact
// carries only the channel hint, not credentials
type ResolvedDeliveryConfig = {
  readonly adapter: DeliveryAdapter;
  readonly adapterConfig: AdapterConfig;
};
```

**Riskiest assumption -- bet or avoid?**

Avoids the bet on uniform sync/async, same as Approach 1. However, this approach introduces a new assumption: that workflows can be updated to emit `wr.delivery_intent` without breaking existing behavior. If some workflows cannot be updated (e.g., third-party imported workflows), the dispatcher falls through to legacy code anyway, making the migration incomplete indefinitely. The fallthrough path is not a temporary bridge -- it becomes permanent infrastructure. This is a hidden cost of the "push" model.

---

## Approach 3 (p=0.08): Delivery Config as a Separate Config File, Resolved at Startup

**Primary mechanism:** A dedicated `~/.workrail/delivery.yml` file maps workflow IDs (and a `'*'` wildcard) to `DeliveryConfig` entries. Loaded at daemon startup into an immutable `DeliveryConfigIndex`. At dispatch time, `resolveDeliveryConfig(workflowId)` returns the most-specific match. Trigger-level overrides are added as a `delivery:` key in `triggers.yml` entries (parsed at load time, stored on `TriggerDefinition`). No delivery config in workflow JSON at all.

**How it resolves each tension:**

- *Delivery config ownership:* The separate file creates an explicit delivery configuration surface that is not entangled with trigger definitions or workflow definitions. The ownership boundary is clear: `triggers.yml` owns "when to run", `delivery.yml` owns "where results go". The `TriggerDefinition.delivery` field provides per-trigger overrides that override the file-level config.
- *Gate and delivery coupling:* Resolved identically to Approach 1 -- the gate handler calls `resolveDeliveryConfig(workflowId)` and invokes the appropriate adapter method.
- *Artifact type routing vs generic payload:* Adapters receive the full `DeliveryPayload` (all artifacts + notes). Type-aware adapters filter for relevant artifact kinds internally. No routing layer -- each adapter decides what to consume.
- *dispatch() gap:* `dispatch()` calls `resolveDeliveryConfig(workflowTrigger.workflowId)` using the workflow ID alone -- no trigger lookup required. This fully closes the gap without forwarding delivery config through `WorkflowTrigger`.
- *Synchronous vs async delivery:* Same `DeliveryReceipt` model as Approaches 1 and 2.
- *Backward compatibility:* `delivery.yml` is optional. When absent, existing `maybeRunDelivery` and `maybeRunPostWorkflowActions` run as before. The new delivery layer only activates when `delivery.yml` exists or `TriggerDefinition.delivery` is set.

**Key tradeoffs:**

- A new config file is a new cognitive surface for operators. Operators must now learn three config surfaces: `triggers.yml`, `~/.workrail/config.json`, and `delivery.yml`. Without a "delivery.yml" generator or guide, operators may not know it exists.
- The `dispatch()` path closes cleanly (workflow ID lookup instead of trigger ID lookup) -- this is arguably the cleanest resolution of the dispatch gap of all five approaches.
- Wildcard (`'*'`) matching is simple but the resolution algorithm must be explicit about tie-breaking when both a specific workflow ID match and a wildcard match exist. If the rules are not documented, operators will be surprised.
- Placing delivery outside `triggers.yml` prevents per-trigger delivery overrides unless you also add a `delivery:` key to `TriggerDefinition`. This is additive but requires updating both files for trigger-specific delivery.

**Implementation shape:**

```typescript
// delivery.yml structure
interface DeliveryFileConfig {
  readonly version: '1';
  readonly defaults: Record<string, DeliveryConfig>; // keyed by workflowId or '*'
}

// DeliveryConfigIndex: immutable after startup
interface DeliveryConfigIndex {
  resolve(workflowId: string, triggerOverride?: DeliveryConfig): DeliveryConfig;
}

// Resolution rule: triggerOverride > workflowId-specific > '*' wildcard > CLI inbox fallback
// (last entry is the no-silent-loss guarantee)

// WorkflowTrigger does NOT gain a deliveryConfig field -- workflow ID is the only lookup key
// This is the key structural difference from Approaches 1 and 2
```

**Riskiest assumption -- bet or avoid?**

Explicitly avoids the riskiest assumption (sync/async uniformity) via `DeliveryReceipt`. Introduces a different assumption: that operators will discover and populate `delivery.yml`. If adoption is poor, delivery config stays in `TriggerDefinition.delivery` exclusively and the separate file becomes vestigial. The design is still correct if `delivery.yml` is never used -- it degrades gracefully to trigger-level config only.

---

## Approach 4 (p=0.05): Two-Phase Delivery: Render Then Ship (Staged Output Buffer)

**Primary mechanism:** After `runWorkflow()` succeeds, the system first executes a `RenderPhase` that converts typed artifacts and notes into a `RenderedOutput` (a structured, adapter-independent representation: title, body, attachments, metadata). Then a `ShipPhase` takes the `RenderedOutput` and sends it to the configured adapter. The render step is pure and synchronous; the ship step handles sync/async adapter differences. This is the "functional core, imperative shell" principle applied directly to delivery.

**How it resolves each tension:**

- *Delivery config ownership:* `RenderedOutput` is adapter-agnostic, so the render step can run without knowing the delivery destination. Config resolution (trigger > workflow-type > global) happens only in the ship step, after rendering. The two phases have no shared config.
- *Gate and delivery coupling:* Gates call the render step with `intent: 'gate_notification'`, producing a `RenderedOutput { kind: 'gate_notification', ... }`. The ship step then delivers it through the configured adapter. Rendering is deterministic and testable independent of the adapter.
- *Artifact type routing vs generic payload:* The render step absorbs all artifact routing complexity. Adapters receive `RenderedOutput` -- a stable, typed, platform-agnostic structure. No adapter needs to know about `wr.review_verdict` or any other artifact kind. The render step maps artifact kinds to output fields.
- *dispatch() gap:* Same forwarding as Approach 1, or same index lookup as Approach 3 -- orthogonal to this approach's core mechanism.
- *Synchronous vs async delivery:* The `ShipPhase` handles this identically to Approaches 1-3 via `DeliveryReceipt`. The key novelty here is that the render step isolates the semantics-to-structure conversion from the network delivery.
- *Backward compatibility:* Existing `HandoffArtifact` parsing (in `delivery-action.ts`) is effectively a render step that is already present. This approach formalizes that pattern rather than replacing it.

**Key tradeoffs:**

- `RenderedOutput` is a new type that must be expressive enough for all current and future adapters (GitHub review, Slack message, GitLab MR note, CLI inbox, webhook payload). If it is too narrow, adapters will bypass it. If it is too wide, it becomes `Record<string, unknown>` in disguise.
- The render step is the new complexity locus. Every time a new artifact kind is added, the render step must be updated to know how to render it. This is an O(artifact types) coupling that Approaches 1-3 avoid by delegating rendering to the adapter.
- For adapters that need platform-specific rendering (e.g., a GitHub PR review comment with exact file/line position data), `RenderedOutput` must carry structured attachment data. This pulls rendering complexity back into the core.
- This is a genuinely different architecture from the other approaches -- it imposes a render contract on every output path, which is correct engineering but also means more upfront design work to get `RenderedOutput` right.

**Implementation shape:**

```typescript
// Platform-agnostic output representation
interface RenderedOutput {
  readonly kind: 'final_result' | 'gate_notification';
  readonly title: string;
  readonly body: string; // human-readable summary
  readonly structuredFindings?: readonly StructuredFinding[]; // for review-type outputs
  readonly metadata: Readonly<Record<string, unknown>>; // passthrough fields adapters may use
}

interface StructuredFinding {
  readonly severity: 'critical' | 'major' | 'minor' | 'info';
  readonly summary: string;
  readonly file?: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly remediation?: string;
}

// Render step: pure function, no I/O
function renderWorkflowOutput(
  artifacts: readonly WorkflowArtifact[],
  notes: string | null,
  intent: 'final_result' | 'gate_notification',
): RenderedOutput { ... }

// Ship step: adapter receives RenderedOutput, not raw artifacts
interface DeliveryAdapter {
  readonly id: string;
  ship(output: RenderedOutput, config: AdapterConfig): Promise<DeliveryReceipt>;
  shipGateNotification?(output: RenderedOutput, config: AdapterConfig): Promise<void>;
}
```

**Riskiest assumption -- bet or avoid?**

This approach makes a different bet: that `RenderedOutput` can be defined well enough upfront to serve all adapters without needing platform-specific fields. This is a related but distinct assumption from the original riskiest assumption. It replaces "can we hide sync/async behind a uniform interface" with "can we define a universal output representation". The sync/async question is handled cleanly via `DeliveryReceipt`. Whether `RenderedOutput` is expressive enough depends heavily on what future adapters need -- and that is unknown. This is a measured bet, but it is still a bet on future adapter requirements being expressible in a fixed schema.

---

## Approach 5 (p=0.04): Delivery as Continuation: Gate Token IS the Delivery Handle

**Primary mechanism:** Eliminate the post-workflow delivery phase entirely as a separate concern. Instead, every workflow run that produces output that needs external delivery must pass through a `requireConfirmation` gate. The gate token (already generated and stored by the engine) doubles as the delivery handle. When the gate fires, the configured adapter receives the gate token alongside the artifacts and is responsible for both delivering the notification AND returning the approval signal when ready. The engine's gate-resume path becomes the single coordination point.

**How it resolves each tension:**

- *Delivery config ownership:* Config lives exclusively at the trigger level (or global fallback). Since all delivery-requiring workflows must have a gate, the trigger is always available at the delivery point. No dispatch() gap -- dispatch() sessions that need delivery must have a gate.
- *Gate and delivery coupling:* This approach stops pretending separation is achievable. Gates and delivery are the same concern when the intent is "deliver, then wait for a human decision." The coupling is made explicit rather than worked around. For workflows that deliver without waiting, the gate is still the mechanism -- an "auto-approve" gate that fires immediately after delivering.
- *Artifact type routing vs generic payload:* The adapter receives the gate token, the step's artifacts, and the gate configuration. Routing by artifact kind is the adapter's responsibility, same as Approaches 1-3.
- *dispatch() gap:* Sessions that use `dispatch()` without a trigger and need delivery must have a gate in the workflow. The gate provides the coordination hook. Sessions that explicitly do not need delivery have no gate and no delivery -- intentional, not accidental.
- *Synchronous vs async delivery:* The async question dissolves: the gate is inherently asynchronous. The adapter fires the delivery and the gate remains parked until the adapter signals completion (via a gate-resume call or the existing `human_approval` sidecar + poller mechanism). There is no "pending receipt" to track -- the parked gate IS the pending state.
- *Backward compatibility:* `human_approval` gate already implements this model exactly. The change is to generalize it: any gate kind can have a configured adapter. `coordinator_eval` gates can still auto-route to `wr.gate-eval-generic`. A new `delivery_gate` kind routes to the configured delivery adapter.

**Key tradeoffs:**

- Workflows that need to deliver output but do NOT need human approval are forced to add a synthetic gate. This leaks the delivery mechanism into the workflow definition -- a form of the coupling this design set out to avoid. An "auto-approve" gate is confusing to workflow authors.
- Any workflow that currently delivers without gating (e.g., a coding workflow with `autoCommit: true`) must be restructured to use a gate. This is a non-trivial migration for existing workflows.
- The gate token lifetime (currently bounded by the session's completion) must be extended for long-polling adapters. Sidecars already handle this for `human_approval`, but the general case requires the engine to guarantee gate state durability for potentially hours.
- `GateKind` would need a new value (`'delivery'` or `'adapter_routed'`), which triggers the `assertNever` compile checks in two places -- those are safety mechanisms, not blockers, but they surface everywhere.
- This is the most principled approach for the "gates and delivery are fundamentally coupled" tension, but it has the highest migration cost and the most structural coupling to the engine.

**Implementation shape:**

```typescript
// GateKind gains a new member -- assertNever checks enforce handling everywhere
type GateKind =
  | 'coordinator_eval'   // existing: auto-routes to wr.gate-eval-generic
  | 'human_approval'     // existing: routes to configured review adapter + poller
  | 'adapter_delivery';  // new: routes to configured DeliveryAdapter; auto-resumes on ack

// The gate payload now carries delivery config
interface GatePayload {
  readonly kind: GateKind;
  readonly stepId: string;
  readonly artifacts: readonly WorkflowArtifact[];
  readonly notes: string | null;
  // Only present for 'adapter_delivery' kind
  readonly deliveryConfig?: DeliveryConfig;
  // For 'adapter_delivery', the gate auto-resumes after adapter.deliver() returns 'completed'
  // or after the adapter calls ackDelivery(gateToken, 'approved' | 'rejected')
  readonly autoResumeOnAck: boolean;
}

// The adapter receives a gate ack function -- this is the async completion handle
interface DeliveryAdapter {
  readonly id: string;
  deliver(
    payload: DeliveryPayload,
    config: AdapterConfig,
    ackDelivery: (verdict: 'approved' | 'rejected' | 'pending') => Promise<void>,
  ): Promise<void>;
}
```

**Riskiest assumption -- bet or avoid?**

This approach eliminates the riskiest assumption by dissolving the sync/async problem: the gate is always async, and adapters signal completion through the gate's ack callback rather than a receipt type. There is no sync adapter vs async adapter distinction -- all delivery is modeled as "fire, then eventually ack." Synchronous adapters call ack immediately; async adapters call it when ready. The interface is uniform because the gate provides the uniformity substrate.

However, this approach bets on a different, larger assumption: that it is acceptable to require every delivery-producing workflow to have a gate. If that assumption is wrong -- if many workflows need to deliver without human gating -- this design requires every such workflow to carry a synthetic auto-approve gate, which is workflow-schema pollution and a major conceptual compromise.

---

## Comparison Matrix

| Criterion | Approach 1 (Registry) | Approach 2 (Intent Artifact) | Approach 3 (delivery.yml) | Approach 4 (Render/Ship) | Approach 5 (Gate = Delivery) |
|---|---|---|---|---|---|
| Change delivery without editing workflow JSON | Yes | Partially (intent artifact is in workflow) | Yes | Yes | Yes |
| No silent output loss | Yes (CLI inbox fallback) | Yes (fallthrough to legacy) | Yes (wildcard fallback) | Yes | Yes (gate is always visible) |
| Gate control flow preserved | Yes | Yes | Yes | Yes | Yes (gate IS the mechanism) |
| New adapter: zero workflow/trigger changes | Yes | No (schema migration) | Yes | Yes | Yes |
| Delivery routing is deterministic TypeScript | Yes | Yes | Yes | Yes | Yes |
| dispatch() parity with route() | Via forwarded config | Via forwarded config | Via workflow ID lookup | Via forwarded config | Via gate presence |
| Bets on riskiest assumption | No (receipt union) | No (receipt union) | No (receipt union) | No (receipt union, different bet) | No (dissolves via gate) |
| Migration cost | Low (additive) | Medium (schema change) | Low (optional file) | Medium (render step everywhere) | High (all delivering workflows need gates) |
| Cognitive overhead for operators | Low | Low | Medium (3rd config file) | Low | Medium (gate semantics for delivery) |

## Recommendation Rationale

Approach 1 is the safest choice for a staff engineer who has been burned before. It is the most direct fix for the stated problem with the fewest new assumptions. The `DeliveryReceipt` union addresses the riskiest assumption explicitly. The forwarded `deliveryConfig` on `WorkflowTrigger` closes the `dispatch()` gap using a pattern already established in the codebase (`reviewerIdentity` forwarding). The existing four delivery mechanisms wrap as adapters without being removed -- there is no big-bang migration.

Approach 3 is worth considering if the `dispatch()` gap is a first-class concern: the workflow-ID-only lookup avoids touching `WorkflowTrigger` entirely, which is cleaner. But it requires operators to learn a third config surface.

Approach 4's `RenderedOutput` is a sound idea for adapter independence but should be treated as an internal refinement within Approach 1 rather than a top-level design choice. The render/ship split can be applied to the Approach 1 adapters without changing the delivery config resolution model.

Approaches 2 and 5 both introduce structural coupling (workflow schema and gate engine respectively) that does not justify the benefit. Approach 5's insight -- that gates and delivery are fundamentally coupled for "deliver-then-wait" workflows -- is correct but should influence how gate adapters are wired within Approach 1, not replace the delivery layer entirely.
