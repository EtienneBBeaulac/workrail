# Session Harness Design Candidates -- Angle A

**Angle:** Anchor every candidate to the ideal end state. What would a principal engineer build if
they had to make daemon sessions never get stuck, ever, and had unlimited time?

**Persona:** Distributed systems engineer with production-grade retry and circuit-breaker
infrastructure. Strong opinions about what separates systems that degrade gracefully from ones
that fall apart.

**Date:** 2026-05-20

---

## Problem Recap

The daemon has no mechanism to observe what a session is doing, intervene when it goes wrong, or
recover gracefully -- so sessions that encounter errors spiral into stuck states or terminate
unexpectedly with no recovery path, making autonomous overnight operation unreliable.

**Riskiest assumption (from brief):** The harness can intercept and modify tool results mid-flight
without the agent loop exposing a result-modification hook. Currently `_executeTools()` returns
results straight into `_messages` with no interception point. Any candidate requiring result
modification depends on adding this hook to `agent-loop.ts`.

---

## Approach 1 (p=0.70): Turn-End Enrichment Pipeline

**Primary mechanism:** A composable pipeline of pure `TurnEnricher` rules that execute at the
existing `turn_end` hook, inspect `SessionState` + recent tool results, and inject steered
messages before the next LLM turn.

**How it resolves each tension:**

- *Prevention vs recovery:* Leans toward prevention -- enrichers fire before the next LLM turn
  and can inject correct context, missing schema hints, or outputContract reminders before the
  agent makes a mistake. Recovery is limited to steering the agent toward a different approach,
  not rewriting past errors.
- *Coupling vs generality:* Rules are structural-pattern-only: they inspect `toolName`,
  `turnCount`, `stepAdvanceCount`, and `lastNToolCalls` -- never specific step IDs. Workflow-agnostic
  by construction.
- *Transparency vs invisibility:* Each enricher that fires appends a `harness_injection` event to
  the session event log via `emitter.emit()`. The agent sees the injected message as a regular user
  turn; there is no confusion about history.
- *Suspension granularity:* Step-boundary only -- enrichers fire at `turn_end`, which is naturally
  a clean suspension point. No within-turn suspension is possible under this model.
- *Operator escalation vs autonomy:* Enrichers can escalate by calling `agent.abort()` + writing to
  the stuck outbox. Autonomous recovery is limited to hint injection; genuine deadlocks still
  escalate.
- *Single harness vs composable rules:* Fully composable. Each `TurnEnricher` is a pure function.
  The pipeline is an ordered array. Composition order is explicit and documented in the pipeline
  constructor.

**Key tradeoffs:**

- The `turn_end` hook already exists (`buildTurnEndSubscriber`), so this requires no changes to
  `agent-loop.ts` -- lowest blast radius of any approach.
- Prevention-only: cannot rewrite a bad tool result the agent already received. If the engine
  returned an error on `continue_workflow`, the enricher can only tell the agent what to try next
  turn -- it cannot erase the error from conversation history.
- The ordered pipeline introduces a composition-order dependency: a `StepRewindEnricher` must run
  after a `ConsecutiveFailureEnricher` to ensure rewinds only fire after hints are exhausted.
  Order bugs are hard to catch in review.
- Ring buffer size (currently 3) limits the window over which pattern recognition operates.
  Structural patterns that require seeing more than 3 turns are invisible to this approach.

**TypeScript interface sketch:**

```typescript
/** Pure inspection result -- what a single enricher sees. */
interface TurnSnapshot {
  readonly state: Readonly<SessionState>;
  readonly toolResults: ReadonlyArray<AgentToolCallResult>;
  readonly turnCount: number;
}

/**
 * A single harness rule. Returns an InjectionDirective or null (no-op on happy path).
 * Pure: no I/O, no side effects. Must be deterministic.
 */
interface TurnEnricher {
  readonly name: string;
  evaluate(snapshot: TurnSnapshot): InjectionDirective | null;
}

type InjectionDirective =
  | { readonly kind: 'steer'; readonly message: string; readonly reason: string }
  | { readonly kind: 'abort'; readonly terminalReason: string }
  | { readonly kind: 'rewind'; readonly targetStepId: string; readonly context: string };

/** Ordered pipeline of enrichers. Runs each in order; first non-null directive wins. */
interface TurnEnrichmentPipeline {
  readonly enrichers: ReadonlyArray<TurnEnricher>;
  evaluate(snapshot: TurnSnapshot): InjectionDirective | null;
}

/** Wired into buildTurnEndSubscriber as a collaborator. */
interface HarnessEnricherSubscriberContext extends TurnEndSubscriberContext {
  readonly pipeline: TurnEnrichmentPipeline;
}
```

**Does it reach the ideal end state?**

Partially. It reaches:
- Zero latency on the happy path (pipeline returns null; enrichers short-circuit).
- New recovery behavior = one new `TurnEnricher` implementation.
- Pure TypeScript, fully deterministic.
- Open/closed for new failure patterns (add a rule, touch nothing else).
- Clean `turn_end` suspension granularity.

It does NOT reach:
- Tool result interception -- cannot rewrite bad engine errors before the LLM sees them.
- Daemon-side synthetic tool calls -- no mechanism for the harness to perform its own I/O and
  inject results as synthetic messages.
- Tiered recovery ladder within a single failure episode -- the pipeline fires once per turn;
  it cannot track "hint fired turn N, scaffold fired turn N+3, rewind fires turn N+6" without
  additional state threaded through `SessionState`.
- Session segmentation compatibility: the steer queue assumes a single linear conversation;
  sub-session handoff requires extending `InjectionDirective` with a `spawn_sub_session` kind.

---

## Approach 2 (p=0.35): Tool Result Interceptor with Pre/Post Middleware

**Primary mechanism:** Add a result-modification hook to `AgentLoop._executeTools()` that routes
each `AgentToolCallResult` through an ordered `ToolResultInterceptor` chain before the result
enters `_messages`. Interceptors can rewrite error text, inject recovery guidance, or replace a
result entirely with a synthetic success.

**How it resolves each tension:**

- *Prevention vs recovery:* Strongly recovery-oriented. The interceptor fires after a tool call
  completes and can rewrite the error the agent sees -- turning a raw `engine: token expired`
  into `Token expired. Call refresh_token with the current session ID then retry continue_workflow.`
  Prevention is not addressed (no pre-turn hook in this approach alone).
- *Coupling vs generality:* Interceptors that match on `toolName === 'continue_workflow'` are
  moderately coupled. Interceptors that match on `isError && result.content[0].text.includes('TOKEN_')`
  are structural. The design permits both; discipline governs which is used.
- *Transparency vs invisibility:* Every rewritten result is logged as a `harness_intercept` event.
  The agent sees the rewritten text, not the original. This is a genuine invisibility risk -- the
  agent's conversation history diverges from what the tool actually returned.
- *Suspension granularity:* Any-turn suspension is possible -- an interceptor can replace a result
  with `{ kind: 'suspend', reason: 'gate' }` and the harness can abort the loop at that point.
  This is more flexible than step-boundary suspension but creates mid-turn suspension complexity.
- *Operator escalation vs autonomy:* Interceptors can escalate transparently (log + rewrite to
  include escalation guidance) or silently retry. The autonomy/escalation tradeoff is per-rule.
- *Single harness vs composable rules:* Composable. Each `ToolResultInterceptor` is a pure function
  from `ToolCallContext -> AgentToolCallResult | null`. The chain is ordered; first non-null wins.

**Key tradeoffs:**

- This is the approach that directly hits the riskiest assumption: `_executeTools()` currently has
  no interception point. This requires a surgical addition to `agent-loop.ts` -- adding an
  optional `interceptors?: ReadonlyArray<ToolResultInterceptor>` field to `AgentLoopOptions` and a
  `_interceptResult()` private method that runs the chain. The change is additive and backward-
  compatible (absent interceptors = current behavior), but it is a contract change to a core
  infrastructure module.
- Result rewriting is a double-edged sword: fixing a bad error message is valuable; hiding a
  genuine failure the LLM should reason about is harmful. The discipline rule must be: interceptors
  enrich context but never suppress the failure signal (is_error must not be flipped to false).
- Conversation history divergence: the agent's internal model of "what happened" is the rewritten
  message. If the session is later resumed and the operator reads raw session events, the divergence
  can be confusing. Logging the original + rewritten text as a `harness_intercept` event mitigates
  this but does not eliminate it.
- Pre-turn injection (preventing mistakes before they happen) requires combining this with Approach 1
  or 4. On its own, this approach is purely reactive.

**TypeScript interface sketch:**

```typescript
/** Context available to an interceptor at the tool-result boundary. */
interface ToolCallContext {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly result: AgentToolCallResult;
  readonly sessionState: Readonly<SessionState>;
  readonly turnCount: number;
}

/**
 * A single tool-result interceptor. Pure function. Returns the (possibly rewritten)
 * result, or null to pass through unchanged.
 * INVARIANT: interceptors must NOT flip isError from true to false -- error signal
 * must always reach the LLM. Enrichment only.
 */
interface ToolResultInterceptor {
  readonly name: string;
  readonly targetTools: ReadonlyArray<string> | 'all';
  intercept(ctx: ToolCallContext): AgentToolCallResult | null;
}

/** Added to AgentLoopOptions as an optional extension point. */
interface AgentLoopOptions {
  // ... existing fields ...
  readonly toolResultInterceptors?: ReadonlyArray<ToolResultInterceptor>;
}

/** InterceptorChain: ordered composition, first non-null wins. */
interface InterceptorChain {
  readonly interceptors: ReadonlyArray<ToolResultInterceptor>;
  run(ctx: ToolCallContext): AgentToolCallResult;
}
```

**Does it reach the ideal end state?**

Substantially more than Approach 1 for the recovery side:
- Every tool call passes through an interception point that can rewrite error messages.
- Error enrichment (adding recovery guidance) is a one-rule operation.
- Deterministic TypeScript, fully testable.

It does NOT reach:
- Pre-turn injection (no hook before the LLM call).
- Tiered recovery ladder tracking (no per-step failure count in `SessionState`).
- Daemon-side synthetic tool calls (harness cannot perform its own I/O and inject results).
- Session segmentation compatibility requires extending the interceptor result type.

Requires: one additive change to `agent-loop.ts` -- the riskiest assumption must be resolved.

---

## Approach 3 (p=0.08): Layered Session Cortex with Event Sourcing

**Primary mechanism:** A `SessionCortex` -- a stateful object that subscribes to all agent events,
maintains its own separate event log of harness-observed facts (tool errors, consecutive failure
streaks, pattern windows), and drives a tiered recovery ladder (hint -> scaffold -> rewind ->
escalate) based on accumulated evidence across turns. Cortex state is append-only and
reconstructible from the event log, enabling crash-safe harness resumption.

**How it resolves each tension:**

- *Prevention vs recovery:* Both. The cortex fires a `pre_turn_hook` before each LLM call (inject
  context if needed) and a `post_result_hook` after each tool result (enrichment + recovery ladder
  advancement). Prevention and recovery are two phases of the same cortex tick.
- *Coupling vs generality:* Rules are expressed as `CortexPolicy` objects -- pure functions from
  `CortexState -> Directive | null`. Policies match on structural patterns (e.g.,
  `consecutiveToolFailures >= 2`) not step IDs. Workflow-specific policies can be loaded from
  workflow metadata as an optional extension.
- *Transparency vs invisibility:* Every cortex action emits a `harness_*` event to the session
  event log. Cortex state is stored separately from `SessionState` so the agent's conversation
  history is never polluted. The operator can read the cortex event log to understand every
  intervention.
- *Suspension granularity:* Step-boundary preferred (clean state), but the cortex can trigger
  mid-turn suspension by setting a `pendingSuspend` directive that fires at the next turn_end.
  Both granularities are available; the operator chooses via policy.
- *Operator escalation vs autonomy:* The recovery ladder has explicit tiers with explicit escalation
  at the top: `hint -> scaffold -> rewind -> operator_escalation`. Each tier has a configurable
  attempt budget. Autonomy is bounded; escalation is guaranteed after a finite number of attempts.
- *Single harness vs composable rules:* Composable policies + single cortex that runs them. The
  cortex is the imperative shell (accumulates state, fires effects). The policies are the functional
  core (pure decision functions). The distinction is sharp and enforced by types.

**Key tradeoffs:**

- The cortex is genuinely stateful: `CortexState` tracks `consecutiveToolFailures`,
  `recoveryLadderPosition`, `interventionHistory`, and `pendingDirective`. This is additional
  mutable state beyond `SessionState`. Under the "single source of state truth" principle, this is
  a design smell -- two objects now track session facts that must be kept coherent.
  Resolution: `SessionState` owns workflow-engine state; `CortexState` owns harness-observation
  state. The boundary is: cortex reads `SessionState` but never writes it; cortex writes only
  `CortexState`. If this invariant holds, the two-state objects are a coherent separation of
  concerns, not a duplication.
- Append-only cortex event log + crash-safe resumption is significantly more engineering than
  any other approach. It also enables the most durable vision: cortex state survives daemon
  restarts, which no other approach can claim.
- The cortex's pre_turn_hook requires a new subscription point in `agent-loop.ts` that fires
  before `client.messages.create()` -- currently only `onLlmTurnStarted` exists there (a callback
  that cannot steer). The hook must be able to call `agent.steer()`, which means it fires before
  the steer queue is drained, not during `turn_end`. This requires a modest `agent-loop.ts` change:
  add an `onBeforeLlmCall` hook to `AgentLoopCallbacks` that fires after the steer queue is drained
  but before the API call. A `steer()`-capable callback at this point is the key addition.
- Complexity is high. A cortex that tracks recovery ladder state + intervention history +
  pre-turn + post-result hooks is a meaningful surface area. The payoff is commensurate: this
  is the design that genuinely never lets sessions get stuck.

**TypeScript interface sketch:**

```typescript
/**
 * Cortex-managed observation state -- separate from SessionState.
 * WHY separate: cortex owns harness-observed facts; SessionState owns engine-domain facts.
 * Invariant: cortex reads SessionState but never writes it.
 */
interface CortexState {
  readonly consecutiveToolFailures: number;
  readonly recoveryLadderPosition: RecoveryTier;
  readonly interventionHistory: ReadonlyArray<HarnessIntervention>;
  readonly pendingDirective: HarnessDirective | null;
}

type RecoveryTier = 'hint' | 'scaffold' | 'rewind' | 'escalate';

type HarnessDirective =
  | { readonly kind: 'steer'; readonly message: string }
  | { readonly kind: 'rewind'; readonly targetStepId: string; readonly injectedContext: string }
  | { readonly kind: 'suspend'; readonly reason: string; readonly resumeCondition: ResumeCondition }
  | { readonly kind: 'escalate'; readonly summary: string };

type ResumeCondition =
  | { readonly kind: 'operator_approval' }
  | { readonly kind: 'timer'; readonly resumeAfterMs: number }
  | { readonly kind: 'external_event'; readonly eventType: string };

/**
 * Pure policy function. Reads cortex + session state; returns a directive or null.
 * Deterministic: same inputs, same output. No I/O.
 */
interface CortexPolicy {
  readonly name: string;
  evaluate(
    cortexState: Readonly<CortexState>,
    sessionState: Readonly<SessionState>,
    trigger: ToolEventOrTurnEvent,
  ): HarnessDirective | null;
}

/**
 * The session cortex. Stateful imperative shell that:
 * 1. Subscribes to agent events (turn_end, tool results, pre_turn).
 * 2. Runs policies in order to produce directives.
 * 3. Executes directives (steer, abort, escalate) as side effects.
 * 4. Appends every action to the cortex event log.
 */
interface SessionCortex {
  readonly policies: ReadonlyArray<CortexPolicy>;
  onPreTurn(sessionState: Readonly<SessionState>): Promise<void>;
  onToolResult(result: AgentToolCallResult, sessionState: Readonly<SessionState>): void;
  onTurnEnd(event: AgentEvent, sessionState: Readonly<SessionState>): Promise<void>;
  getState(): Readonly<CortexState>;
}
```

**Does it reach the ideal end state?**

Yes -- this is the architecture that reaches the full ideal:
- Zero overhead on happy path (policies return null; cortex tick is pure TypeScript).
- One new `CortexPolicy` = one new recovery behavior, zero changes elsewhere.
- Tiered recovery ladder: hint -> scaffold -> rewind -> escalate, all driven by policy state.
- Sessions suspend cleanly (at step boundary or on demand) with `ResumeCondition` encoding
  exactly what must happen before resumption.
- Append-only cortex event log enables crash-safe harness state -- the cortex can be
  reconstructed after a daemon restart.
- Open/closed: new failure pattern = new `CortexPolicy`. Existing policies are untouched.
- Session segmentation compatible: `HarnessDirective.kind = 'spawn_sub_session'` is a natural
  extension that does not require changes to the cortex infrastructure.

Requires two modest agent-loop.ts additions:
1. `onBeforeLlmCall` callback that can steer (pre-turn injection point).
2. Per-tool `interceptors` for result rewriting (from Approach 2, composable with this).

---

## Approach 4 (p=0.05): Workflow-Aware Pre-Turn Context Injector

**Primary mechanism:** A stateless pre-turn enricher that decodes the current `continueToken` to
read the engine's pending step metadata (outputContract, expectedArtifacts, stepId) and
automatically injects a compact reminder into the steer queue if the conversation is long or the
last turn produced no step advance. It knows what the engine expects and tells the agent before
the agent has a chance to drift.

**How it resolves each tension:**

- *Prevention vs recovery:* Purely preventative. This approach makes the pre-turn context injection
  part of the ideal end state concrete -- specifically, it reads the engine's step metadata and
  silently enriches the next message. It does not handle errors after they happen.
- *Coupling vs generality:* The enricher is tied to the WorkRail engine's `continueToken` contract
  -- it decodes HMAC tokens (or reads cached step metadata) to extract structured step context.
  This is the most engine-coupled of all approaches, but it also has the most signal: it knows
  the exact outputContract the agent must satisfy, which is far more actionable than structural
  patterns alone.
- *Transparency vs invisibility:* Injected reminders appear in the steer queue exactly like any
  other steer message. The agent sees them as regular user-turn instructions. The session event
  log records a `harness_pre_turn_inject` event for every injection.
- *Suspension granularity:* Step-boundary only. Injection fires at `turn_end` (before the next
  turn). No within-turn injection is possible.
- *Operator escalation vs autonomy:* No escalation mechanism in this approach. It enriches; it
  does not intervene. Combine with Approach 1 or 3 for escalation.
- *Single harness vs composable rules:* Stateless and composable. Each `StepContextEnricher` rule
  is a pure function from step metadata -> `string | null`. Multiple rules can be stacked (e.g.,
  outputContract reminder, artifact schema reminder, conversation-length warning).

**Key tradeoffs:**

- Reading step metadata from the continueToken decodes an HMAC-signed blob. Per the codebase
  invariant ("HMAC tokens are opaque signed blobs -- never decode, inspect, or modify their
  contents"), this approach MUST use the engine's `parseContinueTokenOrFail()` path (which is
  already called in pre-agent session setup) and cache the decoded metadata in `SessionState`
  rather than re-decoding at each turn. This is architecturally sound -- `parseContinueTokenOrFail`
  is already called once; extending `SessionState` with a `currentStepMetadata` field is a minimal
  extension.
- The payoff is highest for outputContract drift (the agent produces artifacts in the wrong format)
  and for conversation-length context loss (the agent forgets what it was supposed to do after 80
  turns). These are genuinely common failure modes.
- This approach alone is insufficient for recovery. It prevents drift; it does not handle a session
  that is already stuck. It is best composed with Approach 1 (adds recovery) or Approach 3 (adds
  full recovery ladder).
- The enricher fires unconditionally on every turn (even when the agent is progressing) unless
  guarded by a "last N turns had no advance" condition. Without this guard, the agent sees
  redundant reminders on every turn, which adds token cost and may confuse the model. The guard
  is a simple `turnsSinceLastAdvance > threshold` check -- but this requires `turnsSinceLastAdvance`
  to be tracked in `SessionState`, which it currently is not.

**TypeScript interface sketch:**

```typescript
/**
 * Metadata about the current pending step, decoded from the continueToken and cached in SessionState.
 * Populated once per step advance (after parseContinueTokenOrFail succeeds).
 * Replaces re-decoding the token on every turn.
 */
interface PendingStepMetadata {
  readonly stepId: string;
  readonly outputContractHint: string | null;
  readonly expectedArtifactSchemas: ReadonlyArray<string>;
  readonly stepPromptPreview: string;
}

/**
 * Extended SessionState field (additive, optional).
 * Set by advanceStep(); cleared on completion.
 */
interface SessionStateWithStepMetadata extends SessionState {
  readonly currentStepMetadata: PendingStepMetadata | null;
}

/**
 * A single step-context enricher rule. Pure: reads step metadata + session state;
 * returns a reminder string or null (no-op on happy path).
 */
interface StepContextEnricher {
  readonly name: string;
  /** Threshold of turns-since-last-advance before this enricher activates. 0 = always active. */
  readonly activationThreshold: number;
  enrich(
    metadata: Readonly<PendingStepMetadata>,
    state: Readonly<SessionStateWithStepMetadata>,
  ): string | null;
}

/**
 * Fires at turn_end when turnsSinceLastAdvance >= any enricher's threshold.
 * Pure: no I/O. Returns the combined injection message or null.
 */
interface StepContextInjectionPipeline {
  readonly enrichers: ReadonlyArray<StepContextEnricher>;
  evaluate(state: Readonly<SessionStateWithStepMetadata>): string | null;
}
```

**Does it reach the ideal end state?**

Partially -- specifically the prevention half:
- Before each LLM turn, the harness inspects pending step state and silently enriches the next
  message with outputContract and artifact schema (ideal end state sentence 1).
- Zero latency on happy path (returns null until threshold exceeded).
- Pure TypeScript, deterministic, testable.
- One new `StepContextEnricher` = one new injection pattern.

It does NOT reach:
- Tool result interception (no error enrichment).
- Tiered recovery ladder (no recovery, only prevention).
- Session suspension and clean resumption.
- Daemon-side synthetic tool calls.

This approach is best understood as a required component of the full design (Approach 3) rather
than a standalone candidate.

---

## Approach 5 (p=0.04): Circuit-Breaker Session Wrapper with Segment Boundaries

**Primary mechanism:** A `SessionCircuitBreaker` wraps each `runAgentLoop()` call and maintains
failure state across a configurable window. When failures accumulate past a threshold, the
circuit trips and the session is suspended rather than terminated -- the state is written to a
`SuspendedSessionStore`, the circuit resets after a backoff period, and the session resumes with
injected context describing what the circuit observed. Segment boundaries between breaker-controlled
runs are first-class -- each resumed run is a distinct "segment" in the session event log,
enabling later forensics and enabling sub-session extraction as a natural extension.

**How it resolves each tension:**

- *Prevention vs recovery:* Recovery-first, with prevention as a secondary effect (the injected
  context on resumption tells the agent what went wrong, which prevents the same failure in the
  resumed run). This approach treats sessions as retry-safe units and ensures the retry carries
  the right context.
- *Coupling vs generality:* Circuit breaker logic is entirely structural: it measures failure rates
  over a time/turn window, not over specific steps or workflows. Adding a new failure type means
  registering a new `FailureClassifier` -- one pure function that identifies whether a tool result
  or stuck signal counts as a "failure" for circuit-breaker purposes.
- *Transparency vs invisibility:* Circuit trips are logged as `circuit_breaker_open` events.
  Each segment boundary is a `session_segment_start` event. The `SuspendedSessionStore` is
  queryable by the operator dashboard. No history manipulation -- what the agent saw is what
  the log shows.
- *Suspension granularity:* Any-turn suspension (circuit trips whenever the failure threshold is
  exceeded, regardless of where in the turn the detection fires). The tradeoff is that mid-turn
  suspension leaves the conversation in a potentially inconsistent state (tool results received
  but not fully processed). Resolution: circuit trips set a `pendingCircuitTrip` flag and the
  actual suspension fires at the next `turn_end` -- effectively step-boundary for most sessions.
- *Operator escalation vs autonomy:* The circuit breaker has a configurable `maxSegments` limit.
  After `maxSegments` trips without a complete session, the circuit enters `half_open` state and
  pages the operator (writes to the escalation outbox). Autonomy is bounded by segment count;
  escalation is guaranteed.
- *Single harness vs composable rules:* Composable `FailureClassifier` functions + a single
  `SessionCircuitBreaker` that accumulates them. The breaker is the shell; the classifiers are
  the core.

**Key tradeoffs:**

- This is the only approach that treats "session segments" as a first-class concept, which makes
  it uniquely aligned with the vision item "does not foreclose session segmentation." The
  `SuspendedSessionStore` and segment event log are the exact primitive that a future
  sub-session extraction feature would be built on. This is an unusually strong architecture
  compatibility guarantee -- the design was built around this capability.
- A `SuspendedSessionStore` is new infrastructure: a file (or in-memory store for the daemon)
  that persists circuit state between segment runs. In the daemon, this maps naturally to the
  existing `DAEMON_SESSIONS_DIR` sidecar pattern. Each segment run gets its own sidecar; the
  circuit breaker reads prior sidecar history to decide whether to trip.
- The backoff period between segments introduces latency that does not exist in any other
  approach. For a session stuck in a tight loop, this is desirable -- breaking the loop and
  waiting before retrying is exactly right. For a session that had one transient error and can
  immediately retry, the backoff adds unnecessary wall-clock time. Configurable per-trigger
  backoff (0ms minimum) mitigates this but adds configurability surface.
- Segment-boundary injection (telling the agent what the circuit observed) requires the
  `SessionContext` builder to accept a `previousSegmentSummary` field -- an additive change
  to `buildSessionContext()`.
- Does not address pre-turn injection or tool result interception. Can be combined with
  Approach 2 for result enrichment within each segment.

**TypeScript interface sketch:**

```typescript
/**
 * Persisted circuit state across segment runs.
 * Stored in DAEMON_SESSIONS_DIR alongside the existing sidecar.
 */
interface CircuitState {
  readonly sessionId: string;
  readonly segmentCount: number;
  readonly totalFailures: number;
  readonly lastFailureKind: FailureKind | null;
  readonly circuitStatus: 'closed' | 'open' | 'half_open';
  readonly nextRetryAfterMs: number;
  readonly segmentLog: ReadonlyArray<SegmentRecord>;
}

interface SegmentRecord {
  readonly segmentIndex: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly failureKind: FailureKind | null;
  readonly stepAdvanceCount: number;
  readonly injectedContextSummary: string;
}

type FailureKind =
  | 'stuck_repeated_tool'
  | 'stuck_no_progress'
  | 'stuck_stall'
  | 'timeout_wall_clock'
  | 'timeout_max_turns'
  | 'api_error';

/**
 * A failure classifier: pure function that maps a WorkflowRunResult to a FailureKind or null.
 * null = success or irrelevant outcome (not a circuit-breaker failure).
 */
interface FailureClassifier {
  readonly name: string;
  classify(result: WorkflowRunResult): FailureKind | null;
}

/**
 * Circuit breaker configuration.
 */
interface CircuitBreakerConfig {
  readonly failureThreshold: number;         // trips after N failures in a window
  readonly windowTurns: number;              // turns in the sliding failure window
  readonly backoffMs: number;                // wait between segments (0 = immediate)
  readonly maxSegments: number;              // max retries before operator escalation
  readonly classifiers: ReadonlyArray<FailureClassifier>;
}

/**
 * Wraps runAgentLoop(). Returns a multi-segment result that includes all segment records.
 */
interface SessionCircuitBreaker {
  readonly config: CircuitBreakerConfig;
  runWithBreaker(
    sessionFactory: () => Promise<WorkflowRunResult>,
    previousSegmentSummary: string | null,
  ): Promise<CircuitBreakerOutcome>;
}

type CircuitBreakerOutcome =
  | { readonly kind: 'completed'; readonly result: WorkflowRunResult; readonly segments: ReadonlyArray<SegmentRecord> }
  | { readonly kind: 'escalated'; readonly segments: ReadonlyArray<SegmentRecord>; readonly lastFailureKind: FailureKind }
  | { readonly kind: 'suspended'; readonly resumeAfterMs: number; readonly segments: ReadonlyArray<SegmentRecord> };
```

**Does it reach the ideal end state?**

It reaches several key aspects of the ideal:
- Sessions never terminate due to stuck -- they suspend cleanly with circuit state written to
  the segment store.
- Sessions resume with injected context describing what the circuit observed (operator escalation
  path is explicit and bounded by `maxSegments`).
- One new `FailureClassifier` = one new failure pattern handled; zero changes to the loop.
- Session segmentation as a first-class primitive -- the only approach where sub-session
  extraction requires no new infrastructure.

It does NOT reach:
- Pre-turn injection (no hook before the LLM call within a segment).
- Tool result interception (no mid-segment error enrichment).
- Tiered recovery ladder within a single segment (recovery is coarse: retry the whole segment
  with new context, not targeted: inject a hint on turn N+1 of the same segment).
- Daemon-side synthetic tool calls.

Combination recommendation: Approach 5 (macro-level segment recovery) + Approach 1 (micro-level
turn enrichment) + Approach 2 (tool result interception) covers the full ideal end state with
bounded complexity. Each layer has a clean responsibility: Approach 5 handles segment-level
retry-and-suspend, Approach 1 handles per-turn hint injection, Approach 2 handles error
message enrichment.

---

## Comparison Matrix

| Criterion | Approach 1 | Approach 2 | Approach 3 | Approach 4 | Approach 5 |
|---|---|---|---|---|---|
| Zero happy-path overhead | Yes | Yes | Yes | Yes | Yes |
| One rule = one new behavior | Yes | Yes | Yes | Yes | Yes |
| Pure TypeScript, deterministic | Yes | Yes | Yes | Yes | Yes |
| Clean session suspension | Step-boundary | Any-turn | Both | Step-boundary | Segment-boundary |
| Tool result interception | No | Yes | Yes (via Approach 2) | No | No |
| Pre-turn injection | No | No | Yes (new hook needed) | Yes (new hook needed) | No |
| Tiered recovery ladder | No | No | Yes | No | Coarse (segment retry) |
| Crash-safe harness state | No | No | Yes (append-only) | No | Yes (segment store) |
| Session segmentation aligned | No | No | Yes | No | Yes (first-class) |
| agent-loop.ts changes required | None | Interceptor hook | Pre-turn + interceptor hook | Pre-turn hook | None |
| Implementation complexity | Low | Medium | High | Low | Medium |
| p(typical AI assistant suggests) | 0.70 | 0.35 | 0.08 | 0.05 | 0.04 |

## Principal Engineer Recommendation

For a production-grade system that genuinely never gets stuck: **Approach 3 (SessionCortex)** as
the target architecture, implemented in phases:

- **Phase 1 (Approach 1):** Ship the `TurnEnrichmentPipeline` as a quick win. Requires zero
  agent-loop changes, installs the composable rule infrastructure, and immediately benefits from
  stuck-detection enrichment rules for the known failure patterns (repeated tool, no progress,
  outputContract drift).
- **Phase 2 (Approach 2):** Add the tool result interceptor hook to `agent-loop.ts`. Wire in
  `continue_workflow` error enrichment as the first interceptor. This resolves the riskiest
  assumption and unblocks the full cortex design.
- **Phase 3 (Approach 3):** Promote the Phase 1 pipeline and Phase 2 interceptors into a
  `SessionCortex` that unifies both under a single stateful observer. Add the pre-turn hook to
  `AgentLoopCallbacks`. Add `CortexState` to the session event log for crash-safety.
- **Phase 4 (Approach 5 primitives):** Promote the cortex's `suspend` directive into a first-class
  `SuspendedSessionStore` with segment records. This is the foundation for sub-session extraction.

This phased path ships value at each phase, keeps agent-loop changes additive and backward-
compatible, and lands at the full ideal end state without requiring the full cortex upfront.
