# Harness Candidates B: Defensible Designs Without _executeTools() Hook

Focus angle: anchor every candidate to the riskiest assumption. Build the most defensible
design that does NOT require modifying `_executeTools()` to add a result-interception hook.
All candidates work purely with today's existing hooks.

Available hooks (today, no changes required):
- `turn_end` subscriber -- fires after each turn, may call `agent.steer()` or `agent.abort()`
- `onToolCallStarted / onToolCallCompleted / onToolCallFailed` -- observe only, cannot modify
- `agent.abort()` -- hard stop
- `SessionState` mutation -- `pendingSteerParts`, `terminalSignal`, etc.

Riskiest assumption in scope: **can we intercept and rewrite a tool result before the LLM
sees it?** The answer is NO with today's hooks. Every candidate below accepts that constraint
and works around it.

---

## Approach 1 (p=0.55): Turn-End Classifier Rule Chain

**Primary mechanism:** A pure chain of classifier functions evaluated inside the `turn_end`
subscriber reads the ring buffer of tool results (`event.toolResults`) and produces a
`HarnessAction` (steer, abort, escalate, none) without touching `_executeTools()`.

### How it resolves each tension

| Tension | Resolution |
|---|---|
| Prevention vs recovery | Recovery only -- classifiers fire after tool results are committed. Prevention requires system-prompt rules injected at session start. |
| Coupling vs generality | Rules inspect `toolName` and `errorText` patterns (strings). Structural-only rules avoid per-step coupling but miss nuanced blocker types. |
| Transparency vs invisibility | Every classifier that fires writes a steer message prefixed with a machine-readable `[harness:rule-id]` tag, which agents treat as user context rather than history noise. |
| Suspension granularity | Step-boundary only (turn_end fires after each tool batch, not after each individual tool). |
| Operator escalation vs autonomous | Configurable per rule: `action: 'steer' | 'abort' | 'escalate'`. Escalation writes to the stuck outbox and aborts. |
| Single harness vs composable | Composable -- rules are a `readonly Rule[]` array; adding a rule is one object, no code changes. |

### Key tradeoffs

- Zero latency/overhead on the happy path: the subscriber fires regardless, but evaluating
  an empty rule list is a loop over zero items.
- Pattern-matching on `errorText` strings is fragile against engine message format changes.
  A rename in the blocked message template silently disables the rule.
- Cannot observe tool results from within a multi-tool turn (all results arrive together
  at turn_end). A rule that wants to respond to result N before tool N+1 runs cannot.
- `event.toolResults` is `ReadonlyArray<AgentToolCallResult>` -- the `isError` flag and
  `result.content[0].text` are readable today without any engine change.

### TypeScript interface sketch

```typescript
type HarnessAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'steer'; readonly message: string }
  | { readonly kind: 'abort'; readonly reason: string }
  | { readonly kind: 'escalate'; readonly reason: string };

interface HarnessRule {
  readonly id: string;
  /** Pure predicate over observable turn state. */
  evaluate(ctx: HarnessTurnContext): HarnessAction;
}

interface HarnessTurnContext {
  readonly toolResults: ReadonlyArray<AgentToolCallResult>;
  readonly state: Readonly<SessionState>;
  /** Number of times this session has seen `isError` results so far. */
  readonly errorTurnCount: number;
}

interface HarnessConfig {
  readonly rules: readonly HarnessRule[];
}

function buildHarnessSubscriber(
  config: HarnessConfig,
  agent: AgentLoop,
  state: SessionState,
  emitter: DaemonEventEmitter | undefined,
): (event: AgentEvent) => Promise<void>;
```

### Bets on or avoids the riskiest assumption

**Avoids.** Reads `event.toolResults` at turn_end -- observable today, no `_executeTools()`
modification needed. Cannot rewrite results, only react to them.

---

## Approach 2 (p=0.20): Per-Step Error Budget in SessionState

**Primary mechanism:** Add a `perStepErrorCount: Map<string, number>` field to `SessionState`
that `onToolCallFailed` increments, and a `HarnessBudgetRule` that reads it from the
`turn_end` subscriber to steer or abort when a step's error budget is exhausted.

### How it resolves each tension

| Tension | Resolution |
|---|---|
| Prevention vs recovery | Recovery. The budget is a counter after the fact. Prevention lives in system prompt guidance injected at session start via the enricher. |
| Coupling vs generality | Step-specific (the budget key is the step ID from `pendingStepIdAfterAdvance`). More effective than structural-only rules but requires the step ID to be stable. |
| Transparency vs invisibility | Budget exhaustion steers a human-readable message before aborting; the agent sees the diagnosis, not just an abort. |
| Suspension granularity | Step-boundary: budgets are checked at `turn_end`. The step ID is current as of the last advance; errors on the first step before any advance use a sentinel key. |
| Operator escalation vs autonomous | Budget config specifies `maxErrors` and `onExhaustion: 'steer' | 'abort' | 'escalate'`. |
| Single harness vs composable | The budget counter in SessionState is a single field; rules that read it are composable over the existing `HarnessRule` chain from Approach 1. |

### Key tradeoffs

- Adding a `Map<string, number>` to `SessionState` is a schema change. The factory
  `createSessionState()` initializes it to `new Map()`. This is a real, if small, coupling.
- `onToolCallFailed` fires synchronously for every tool throw. Incrementing a Map entry
  is O(1) -- zero overhead on the happy path.
- The step ID key is `pendingStepIdAfterAdvance`, which is null before the first advance.
  Rules must tolerate a null key (sentinel like `'__pre_advance__'`).
- This approach does NOT cover `complete_step` engine errors (which throw inside the tool
  and are caught as `isError` tool_results, visible in `event.toolResults`). That path
  is covered by Approach 1's error-text classifier.
- Pairs well with Approach 1: error-text classifier for tool result errors, budget counter
  for raw tool throws. They compose over the same rule chain.

### TypeScript interface sketch

```typescript
// Addition to SessionState
interface SessionState {
  // ... existing fields ...
  /** Error count per step ID. Keyed by pendingStepIdAfterAdvance, or '__pre_advance__'. */
  perStepErrorCount: Map<string, number>;
}

interface StepBudgetRule extends HarnessRule {
  readonly id: 'step_error_budget';
  readonly maxErrors: number;
  readonly onExhaustion: 'abort' | 'steer' | 'escalate';
}

// In onToolCallFailed callback (buildAgentCallbacks):
//   const key = state.pendingStepIdAfterAdvance ?? '__pre_advance__';
//   state.perStepErrorCount.set(key, (state.perStepErrorCount.get(key) ?? 0) + 1);
```

### Bets on or avoids the riskiest assumption

**Avoids.** `onToolCallFailed` is an observe-only callback that fires on tool throws.
Counting fails into `SessionState` and acting at `turn_end` requires no `_executeTools()`
hook. The counter is a pure state mutation; the effect (steer/abort) is deferred to the
subscriber.

---

## Approach 3 (p=0.08): Steer-Injection via Enriched System Prompt Fragment

**Primary mechanism:** The `WorkflowEnricher` (pre-agent phase) generates a harness-rules
fragment that is injected into the system prompt at session start. The fragment encodes
recovery guidance as conditional instructions the LLM follows autonomously. No runtime
subscriber logic.

### How it resolves each tension

| Tension | Resolution |
|---|---|
| Prevention vs recovery | Prevention -- the LLM has the recovery rules before the first turn. If the LLM follows them, errors self-correct. |
| Coupling vs generality | Structural: the fragment is workflow-specific (sourced from the workflow definition's `harnessRules` field) but the injection mechanism is general. |
| Transparency vs invisibility | Fully transparent -- the LLM authored its own recovery instructions. There is no hidden machinery injecting steer messages mid-session. |
| Suspension granularity | LLM-driven: the agent can self-suspend on any turn by calling `signal_coordinator` or stopping voluntarily. |
| Operator escalation vs autonomous | Encoded in the prompt fragment. `"If X fails three times, call signal_coordinator with kind: approval_needed"`. |
| Single harness vs composable | Composable at authoring time (workflow-level rules). Runtime is pure LLM behavior -- no daemon changes required. |

### Key tradeoffs

- Zero runtime overhead: no subscribers, no counters, no callbacks beyond what already exists.
- Relies entirely on LLM compliance. An agent that ignores its system prompt, hallucinates
  tool names, or enters a confused state will also ignore recovery instructions.
- Prompt length grows with rule count. Complex harness rules eat into the context window.
- Adding a new recovery behavior requires updating the workflow definition (or the enricher
  template), not writing a TypeScript rule. This is YAGNI-friendly but not type-safe.
- Does NOT address the specific failure modes that require machine-enforcement (token
  mangling, engine error loops). This approach is prevention, not recovery.
- Best used in combination with Approach 1 (structural rules as backstop for prompt failures).
- Does NOT foreclose session segmentation: the prompt fragment can include segment-boundary
  awareness ("when you see SEGMENT_BOUNDARY in the steer message...").

### TypeScript interface sketch

```typescript
// WorkflowEnricher output extension
interface EnricherResult {
  // ... existing fields ...
  readonly harnessSystemFragment?: string; // injected into systemPrompt
}

// Authoring-side (workflow JSON, not TypeScript)
// {
//   "harnessRules": [
//     { "trigger": "complete_step returns BLOCKED three times in a row",
//       "action": "Call signal_coordinator with kind: blocked" }
//   ]
// }
```

### Bets on or avoids the riskiest assumption

**Avoids entirely.** No hook on `_executeTools()`, no `turn_end` interception. The riskiest
assumption is "will the LLM follow the instructions?" -- a different and generally higher
risk than an interception hook.

---

## Approach 4 (p=0.04): Scope Callback Harness (Session-Scoped Observable)

**Primary mechanism:** `SessionScope` gains a `harness: HarnessObserver` field. Tool
factories (`makeCompleteStepTool`, etc.) call `harness.onToolResult(result)` synchronously
inside their `execute()` body -- after they have classified the result -- before returning.
The harness accumulates structured observations into `SessionState.harnessLog`. The
`turn_end` subscriber reads `harnessLog` and drives steering/abort.

This is NOT a result-interception hook: tool factories still return `AgentToolResult`
unchanged. The harness call is a pure observer call on the classified output.

### How it resolves each tension

| Tension | Resolution |
|---|---|
| Prevention vs recovery | Recovery, but with higher fidelity than turn_end classifiers. Tool factories already know whether the result is `ok / blocked / gate_checkpoint / error` -- they communicate this typed classification to the harness rather than requiring the harness to pattern-match raw error text. |
| Coupling vs generality | Typed coupling: harness sees `HarnessEvent` discriminated union (same kinds as engine response kinds). Changing message text does not break the harness. |
| Transparency vs invisibility | `harnessLog` entries are emitted as `daemon_event` records. Observers see a clean audit trail. |
| Suspension granularity | Any-turn: the harness observer accumulates per-turn, and the turn_end subscriber acts. Effectively per-turn. |
| Operator escalation vs autonomous | Rule-driven via `HarnessAction`. |
| Single harness vs composable | Composable: `HarnessObserver` is a pure function chain over `HarnessEvent[]`. |

### Key tradeoffs

- Requires one small change per tool factory: add one `scope.harness.onToolResult(event)`
  call inside each `execute()` body. This is a targeted, reviewable change -- not a
  `_executeTools()` modification.
- The `harness` field on `SessionScope` is a new required field. Existing scope construction
  sites need a default harness (the no-op harness is zero-overhead).
- Higher fidelity than Approach 1 because tool factories classify the result at the source
  (they already have the discriminated union) rather than the harness re-parsing raw text.
- This is the most architecturally clean option IF the team accepts the minimal scope
  changes. The key question is: "is this a hook on scope.callbacks, or is it creeping
  toward tool-factory coupling?"
- Does NOT require `_executeTools()` changes. Changes are in tool factories (which are
  already the known mutation point) and SessionScope (which is the established DI container).

### TypeScript interface sketch

```typescript
type HarnessEvent =
  | { readonly kind: 'tool_error'; readonly toolName: string; readonly message: string }
  | { readonly kind: 'step_blocked'; readonly stepId: string; readonly retryable: boolean; readonly blockerCount: number }
  | { readonly kind: 'step_advanced'; readonly stepId: string }
  | { readonly kind: 'gate_checkpoint'; readonly gateKind: string };

interface HarnessObserver {
  onToolResult(event: HarnessEvent): void;
  /** Read accumulated events for the current turn (cleared after turn_end). */
  readonly currentTurnEvents: readonly HarnessEvent[];
}

// SessionScope addition
interface SessionScope {
  // ... existing fields ...
  readonly harness: HarnessObserver; // defaults to noOpHarness
}

// In makeCompleteStepTool, after classifying out.kind:
// scope.harness.onToolResult({ kind: 'step_blocked', stepId: ..., retryable: out.retryable, blockerCount: out.blockers.blockers.length });
```

### Bets on or avoids the riskiest assumption

**Avoids the _executeTools() hook.** The calls are inside tool factories, not inside
`_executeTools()`. The riskiest assumption becomes "will future tool authors remember to
call `scope.harness.onToolResult()`?" -- a real coupling risk mitigated by a no-op default.

---

## Approach 5 (p=0.03): Append-Only Session Event Log with External Harness Process

**Primary mechanism:** Each daemon turn appends a `HarnessEntry` to an append-only
JSONL file (`~/.workrail/data/harness/<sessionId>.jsonl`). A lightweight out-of-process
harness reader tails this file and posts steering payloads back to the session via a
small HTTP endpoint the daemon exposes on localhost. The daemon's `turn_end` subscriber
drains any pending payloads from a `pendingHarnessPayloads: string[]` queue that the
HTTP handler populates.

### How it resolves each tension

| Tension | Resolution |
|---|---|
| Prevention vs recovery | Recovery. The out-of-process harness can apply rules with arbitrary complexity (LLM-assisted, rule engines, custom logic) without touching the agent loop. |
| Coupling vs generality | Complete decoupling: the daemon writes structured events; the harness process is an external consumer with its own release cycle. |
| Transparency vs invisibility | Every harness intervention is an explicit HTTP call with a structured payload, auditable in the JSONL log. |
| Suspension granularity | Any-turn granularity: the HTTP endpoint can inject payloads at any point; the `turn_end` subscriber drains them on the next turn boundary. |
| Operator escalation vs autonomous | The harness process makes the escalation decision; the agent loop only executes what arrives in the queue. |
| Single harness vs composable | The harness process is a single external service but can implement arbitrary rule composition internally. |

### Key tradeoffs

- Introduces a new distributed system with failure modes: the harness process can crash,
  the HTTP call can fail, the JSONL file can fill disk. Each failure mode needs handling.
- The turn_end drain is correct but the HTTP endpoint is a new surface area that must be
  authenticated (localhost-only is not sufficient in multi-tenant environments).
- Adding a new recovery behavior requires deploying a new harness process binary, not just
  a TypeScript rule. This violates criterion 2 (one rule, no agent loop changes) unless
  "rule" is defined broadly.
- Session segmentation fits naturally: the harness process can detect segment boundaries
  from the event log and post segment-advance steering payloads.
- This is massive complexity for the stated goal. It is included because it is a legitimate
  design option in large-scale orchestration systems (Temporal, Ray) that is almost never
  suggested by typical AI assistants for daemon harness problems.
- The most future-proof option IF the system grows to multi-node or multi-daemon. The most
  over-engineered option if it does not.

### TypeScript interface sketch

```typescript
interface HarnessEntry {
  readonly sessionId: string;
  readonly turnCount: number;
  readonly kind: 'tool_error' | 'step_blocked' | 'step_advanced' | 'turn_end';
  readonly payload: unknown;
  readonly ts: number;
}

// Daemon side: new HTTP endpoint (POST /harness/:sessionId/steer)
// Handler appends to pendingHarnessPayloads: string[] on SessionState.

// In turn_end subscriber:
// for (const payload of state.pendingHarnessPayloads.splice(0)) {
//   agent.steer({ role: 'user', content: payload, timestamp: Date.now() });
// }
```

### Bets on or avoids the riskiest assumption

**Avoids entirely** -- the out-of-process harness reads log files and posts back via HTTP.
It never needs to touch `_executeTools()`, `SessionScope`, or any agent loop internals.
The bet is instead on reliability of the file + HTTP channel, which is a different and in
some ways harder assumption.

---

## Summary Table

| Approach | p | Mechanism | Happy-path overhead | New rules require | Session segmentation |
|---|---|---|---|---|---|
| 1. Turn-End Classifier Chain | 0.55 | Pattern-match tool results at turn_end | ~0 (empty rule loop) | One `HarnessRule` object | Compatible |
| 2. Per-Step Error Budget | 0.20 | Counter in SessionState + budget rule | ~0 (Map.set) | One budget config change | Compatible |
| 3. Enriched System Prompt | 0.08 | LLM follows recovery fragment in system prompt | Zero | Edit workflow definition | Compatible |
| 4. Scope Callback Harness | 0.04 | Tool factories call `scope.harness.onToolResult()` | ~0 (no-op default) | One `HarnessRule` object | Compatible |
| 5. External Harness Process | 0.03 | Out-of-process reader + HTTP steer endpoint | File I/O per turn | Deploy new harness binary | Natural fit |

**Recommended pairing for production:** Approaches 1 + 2. Approach 1 covers engine-error
pattern recovery (blocked, token failures, `wr.assessment` confusion) at the structural
level. Approach 2 adds a per-step budget that catches raw tool throws independently of
message format. Together they satisfy all five criteria with zero overhead on the happy
path, no `_executeTools()` modification, and a single-rule extension model.

Approach 3 is a valuable complement (prevention layer) but insufficient alone. Approaches
4 and 5 are reserved for when the typed-classification fidelity or multi-process isolation
becomes a genuine operational requirement.
