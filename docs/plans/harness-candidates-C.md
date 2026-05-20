# Session Harness Design Candidates -- Angle C

**Focus angle:** Context degradation as primary failure mode. What if the dominant failure
is semantic incoherence at 1.7M tokens / 60+ turns -- not recoverable errors -- and
no amount of error-catching can fix it?

**Persona:** Pragmatic ML infrastructure engineer who has shipped LLM-powered systems in
production and has seen firsthand how context window limits cause silent failures that no
error-catching can fix.

**Generated:** 2026-05-20

---

## Framing

Sessions average 47 turns / 1.9M tokens at failure for wr.mr-review. 0/13 succeed.

The riskiest assumption for this design angle is: **that deterministic rules can reliably
detect when context degradation is occurring vs a recoverable error**. If you cannot tell
the difference, you cannot route to the right recovery strategy.

The five candidates below are sampled across a wide probability range. Two are things a
typical AI assistant would never propose. All are evaluated both for the "framing is right"
world (context degradation dominates) and the "framing is wrong" world (recoverable errors
dominate). The honest answer on degradation detection appears in each entry -- some candidates
give up on detection entirely and prevent instead; others make detection tractable by
constraining what can degrade.

---

## Approach 1 (p=0.65): Turn-Budget Checkpoint-and-Handoff Gate

**Primary mechanism:** A deterministic rule at `turn_end` checks cumulative token spend
against a configurable threshold; when the threshold is crossed, the session cleanly
checkpoints and hands off to a new session with a compressed context summary injected as
the first user message.

### How it resolves tensions

**Prevention vs recovery:** Pure prevention. The session never reaches the degradation zone.
Handoff fires before incoherence -- not in response to it. Recovery paths are irrelevant.

**Coupling vs generality:** The rule is a single threshold (configurable per workflow).
The content of the context summary is workflow-agnostic: it captures step notes, open
issues, and current artifact state from `SessionState` -- fields that already exist today.
No workflow-specific knowledge in the harness.

**Suspension granularity:** Suspension happens at step boundaries only (the rule checks at
`turn_end`, which fires after tool results are complete). The token state is always coherent:
step i is either done or not; there is no mid-step suspension.

**Operator escalation vs autonomous recovery:** Configurable. Default: autonomous re-spawn.
`respawnGeneration` field in checkpoint triggers operator escalation above a configurable cap
(same design as `session-budget-cooperative-completion.md`).

### Key tradeoffs

- Token counting requires reading `inputTokens` from each `onLlmTurnCompleted` callback and
  accumulating them in `SessionState`. The accumulator is cheap (one integer, updated per turn)
  but must survive the current session to bootstrap the new one.
- The context summary is written by deterministic TypeScript, not the LLM. It is a structured
  extraction of `SessionState` fields -- not a neural compression. This is intentional: LLM
  summarization would add latency and non-determinism to a control-path that must be reliable.
- If the threshold is set too low, sessions never accumulate enough context to make progress.
  If too high, the degradation zone is entered anyway. Calibration requires empirical data from
  the production failure corpus.
- The "framing wrong" case (recoverable errors dominate) is handled trivially: sessions hand
  off at budget but there is no degradation to prevent, so the handoff is pure overhead.
  Overhead is small: one checkpoint write + one session re-spawn. Tolerable.

### TypeScript interface sketch

```typescript
// New field in SessionState:
interface SessionState {
  // ... existing fields ...
  /** Cumulative input tokens consumed by LLM calls in this session. */
  cumulativeInputTokens: number;
  /** Generation count for respawn cycle-break detection (carried via firstStepPrompt). */
  respawnGeneration: number;
}

// New rule in TurnEndSubscriberContext / buildTurnEndSubscriber:
interface ContextHandoffRule {
  readonly kind: 'context_handoff';
  /** Fire handoff when cumulativeInputTokens exceeds this threshold. */
  readonly tokenThresholdMs: number;
  /** Maximum number of respawns before operator escalation. */
  readonly maxRespawnGenerations: number;
}

// Checkpoint payload (carried inline in WorkflowRunResult._tag = 'context_handoff'):
interface ContextHandoffCheckpoint {
  readonly continueToken: string;
  readonly completedStepNotes: ReadonlyArray<{ stepId: string; notes: string }>;
  readonly openIssues: readonly string[];
  readonly respawnGeneration: number;
  readonly tokensBurned: number;
}

// Context-restoration summary injected as first user message in new session:
function buildHandoffSummary(checkpoint: ContextHandoffCheckpoint): string {
  // Deterministic structured extraction -- no LLM call.
  // Format: "Context restoration: previous session completed N steps.
  //   Key findings: <completedStepNotes>. Open issues: <openIssues>.
  //   This is respawn generation N. Continue from where the previous session stopped."
}
```

### Works if framing is RIGHT (context degradation dominates)?

**Yes.** Handoff fires before the degradation zone. The new session starts with a clean
context window and a structured summary of prior work. If the summary is complete enough,
the new session can make progress the degraded session could not.

Weak point: "complete enough" is a design-time bet. If `completedStepNotes` is sparse (agents
who call `continue_workflow` with minimal notes), the summary carries little signal. The fix
is enforcement: output contracts on step notes (already being designed elsewhere).

### Works if framing is WRONG (recoverable errors dominate)?

**Yes, with overhead.** Sessions re-spawn at budget but there is no degradation. The overhead
is one checkpoint write + one re-spawn per N tokens. Tolerable if the threshold is generous
enough that most sessions complete within a single budget window.

---

## Approach 2 (p=0.30): Step-Scoped Context Windows (Session Segmentation at Compile Time)

**Primary mechanism:** The workflow compiler assigns a `contextBudgetTokens` value to each
step node. The agent loop tracks per-step token spend and hard-terminates the context window
at step boundaries, forcing a new session that starts with only the current step's inputs --
not the full conversation history.

This is workflow-coupled segmentation: the compiler (or workflow author) controls how much
context each step is allowed to accumulate. The harness enforces it without knowing what the
step is doing.

### How it resolves tensions

**Prevention vs recovery:** Full prevention. Context never accumulates across segment
boundaries. Incoherence at 1.9M tokens is prevented by design -- the architectural constraint
is that no step can accumulate more than `contextBudgetTokens` tokens.

**Coupling vs generality:** Moderate coupling. The compiler must assign budgets; the harness
enforces them. Budget assignment can be automatic (derive from step complexity heuristics or
historical data) or manual (workflow author sets `contextBudget` per step). The harness itself
is generic -- it reads one field and enforces one rule.

**Suspension granularity:** Step-level. The segment boundary IS the step boundary. Clean by
construction.

**Operator escalation:** Not needed. No session runs long enough to produce degradation.
Incoherence becomes structurally impossible if budgets are correctly calibrated.

### Key tradeoffs

- Requires workflow schema change: `contextBudgetTokens` field on step nodes. This touches
  the authoring spec and the compiler -- non-trivial scope.
- Per-step budgets are hard to calibrate without empirical data. A step that needs to read
  50 large files will legitimately consume more tokens than one that reads 5.
- The architecture assumes steps are independently executable with only their input artifacts.
  If a step needs to remember something from 20 turns ago, segmentation silently breaks it.
  This is the structural version of the "complete enough summary" problem from Approach 1,
  except here the breakage is architectural rather than a content quality issue.
- Positive side effect: forces workflow authors to make step inputs explicit (artifact
  contracts). Steps that cannot be re-entered with clean context are steps with implicit
  dependencies -- and those are the steps that cause incoherence at 1.9M tokens anyway.

### TypeScript interface sketch

```typescript
// New field in compiled step node (spec/workflow.schema.json change):
interface CompiledStepNode {
  // ... existing fields ...
  /**
   * Maximum input tokens this step may consume before a segment handoff is triggered.
   * Absent = no per-step budget (inherits session-level budget from SessionContext).
   */
  readonly contextBudgetTokens?: number;
}

// New field in SessionState:
interface SessionState {
  // ... existing fields ...
  /** Input tokens consumed since the start of the current step. Resets on step advance. */
  currentStepInputTokens: number;
}

// Rule in buildTurnEndSubscriber:
// After accumulating tokens for the current step:
//   if (state.currentStepInputTokens > compiledStep.contextBudgetTokens) {
//     triggerStepSegmentHandoff(state, agent);
//   }

// On step advance (advanceStep()), reset the counter:
function advanceStep(state: SessionState, ...): void {
  // ... existing writes ...
  state.currentStepInputTokens = 0;
}
```

### Works if framing is RIGHT (context degradation dominates)?

**Yes, most robustly.** This is the architecture that makes the degradation zone unreachable
by construction. If steps are correctly segmented, no step accumulates enough context to degrade.
The problem becomes one of calibration and artifact-contract completeness, not session management.

### Works if framing is WRONG (recoverable errors dominate)?

**Partially.** The segmentation is harmless -- it just means sessions re-segment at step
boundaries without degradation ever occurring. The overhead is a new session per step-boundary
segment. For workflows with many cheap steps, this is significant overhead. Not recommended
as a primary mechanism if recoverable errors dominate, but compatible as a secondary hardening
layer.

---

## Approach 3 (p=0.08): Coherence-Probe Turn (Probabilistic Detection)

**Primary mechanism:** Every N turns, before the normal LLM call, the harness fires a
structured coherence probe: a deterministic question about the session's current state
("What is the current step? What is the goal? List the last 3 actions taken."). The LLM's
response is parsed deterministically. Drift from the known-correct `SessionState` values
above a configurable threshold triggers an abort-and-handoff rather than continuation.

This is the only candidate that attempts to detect context degradation at runtime rather
than prevent it by budget.

### How it resolves tensions

**Prevention vs recovery:** This is the recovery side of the framing. If the probe fires
before incoherence is severe enough to cause silent failures, it becomes prevention. If it
fires after degradation is established, it is recovery from detectable (not silent) failure.
The gap between "detectable" and "silent" is the key risk.

**Coupling vs generality:** Low coupling. The probe questions are generic (goal, step, recent
actions) and derived from `SessionState`, not workflow structure.

**Suspension granularity:** Turn-level. Can fire mid-session at any turn. State is clean at
the probe point only if the probe fires after tool results are collected (at `turn_end`).

**Operator escalation:** On probe failure: session aborts, operator notified via outbox.
No autonomous re-spawn by default (coherence probes indicate a quality problem, not a budget
problem; re-spawning may not help if the summary is corrupted).

### Key tradeoffs

- **This approach directly addresses the riskiest assumption**: whether degradation is
  detectable before it causes silent failure. The honest answer: probes detect semantic drift
  only if the LLM is still coherent enough to answer the probe correctly. By the time
  context degradation causes silent failure (the LLM quietly does the wrong thing), the LLM
  may answer probes confidently but incorrectly. Detection may miss the worst cases.
- Each probe is an LLM call. This violates criterion 3 ("all deterministic TypeScript, no LLM
  calls") for the harness itself. The probe parses the LLM's response deterministically, but
  the probe is still an LLM call. This is a hard constraint violation unless the probe is
  implemented as a separate evaluator call outside the harness (same criterion violation).
- False positives: a coherent session may answer the probe with slightly different wording
  than `SessionState` expects. Threshold tuning is required. Wrong threshold = either
  unnecessary re-spawns or missed degradation.
- Not overnight-safe: false-positive probes at 3am kill sessions that were working fine.

### TypeScript interface sketch

```typescript
// NOTE: This approach violates criterion 3 (no LLM calls in harness).
// Included for completeness; not recommended unless criterion 3 is relaxed.

interface CoherenceProbeRule {
  readonly kind: 'coherence_probe';
  /** Fire probe every N turns. */
  readonly probeIntervalTurns: number;
  /**
   * Maximum allowed drift: fraction of probe answers that may diverge from SessionState
   * before abort is triggered. 0.0 = any divergence triggers abort.
   */
  readonly driftThreshold: number;
}

// Probe response parser (deterministic, no LLM):
interface CoherenceProbeResponse {
  readonly reportedGoal: string;
  readonly reportedCurrentStep: string;
  readonly reportedRecentActions: readonly string[];
}

function assessCoherence(
  response: CoherenceProbeResponse,
  state: SessionState,
  expected: { goal: string; currentStepId: string },
): 'coherent' | 'drifted' | 'incoherent';
```

### Works if framing is RIGHT (context degradation dominates)?

**Partially, with a serious caveat.** Probes may detect early-stage degradation (semantic
drift) before silent failure occurs. But the most dangerous degradation state -- where the
agent confidently does the wrong thing -- may not be detectable by a probe the agent answers
confidently but incorrectly. The silent failure case is structurally undetectable by this
approach.

### Works if framing is WRONG (recoverable errors dominate)?

**No overhead, no benefit.** Probes fire on schedule; all sessions answer coherently; no
probe-triggered aborts occur. Overhead: N LLM calls per session lifetime (one every
`probeIntervalTurns` turns). Latency cost on every probe turn.

---

## Approach 4 (p=0.04): Conversation Window Truncation with Artifact-Anchored State

**Primary mechanism:** The `_buildApiMessages()` method in `AgentLoop` currently sends the
full conversation history to the API on every turn. This approach replaces it with a sliding
window that sends only the last K turns plus a deterministic state anchor -- a structured
block injected at position 0 of the sliding window that contains current `SessionState`
fields (current step, token, notes, open issues). Older turns are dropped; the anchor
preserves semantic continuity.

This is not session handoff -- it is in-session context compression. The session continues;
only what the LLM sees each turn changes.

### How it resolves tensions

**Prevention vs recovery:** Prevention, but not by stopping the session. Prevention by
ensuring the LLM never sees a context large enough to degrade. The anchor provides semantic
continuity; the window prevents accumulation.

**Coupling vs generality:** Low coupling. The anchor is a structured extraction of
`SessionState` fields. No workflow-specific knowledge required in the harness. The window
size K is a configurable parameter.

**Suspension granularity:** Not applicable -- this approach does not suspend sessions.
Sessions run to completion; only the context window is managed.

**Operator escalation:** Not applicable. Sessions either complete or hit existing stuck/stall
detection. This approach removes context degradation as a failure mode without adding new
suspension mechanics.

### Key tradeoffs

- Significant behavioral risk: the LLM may reference a tool result from turn N that was
  dropped from the window. If the result of `read_file` at turn 10 is not in the window at
  turn 30, and the LLM asks about its contents, the session halts or hallucinates. This is
  a class of failure that does not exist today -- the approach introduces it.
- The anchor must capture everything the LLM needs to reason correctly about its current
  state. If the anchor omits a key artifact or context variable, the LLM may make locally-
  coherent but globally-wrong decisions. Completeness is not verifiable without empirical
  testing.
- `_buildApiMessages()` is currently a private method of `AgentLoop`. Making window
  truncation injectable (honoring the DI-for-boundaries principle) requires exposing a
  `MessageWindowStrategy` interface on `AgentLoopOptions`. This is a clean architectural
  change but requires modifying `AgentLoop`.
- This approach is the only candidate that improves the happy path: even sessions that would
  have succeeded at 0.5M tokens now send smaller context windows on every turn, reducing
  API latency and cost.

### TypeScript interface sketch

```typescript
// Injectable strategy on AgentLoopOptions:
interface MessageWindowStrategy {
  /**
   * Transform the full message history into the slice to send to the API.
   * Called by _buildApiMessages() on every turn.
   *
   * WHY injectable: allows the window strategy to be swapped without modifying
   * AgentLoop. Default (no strategy) = send all messages (current behavior).
   */
  buildWindow(
    messages: ReadonlyArray<AgentInternalMessage>,
    stateAnchor: SessionStateAnchor,
  ): ReadonlyArray<AgentInternalMessage>;
}

interface SessionStateAnchor {
  readonly currentStepId: string | null;
  readonly goal: string;
  readonly completedStepNotes: ReadonlyArray<{ stepId: string; notes: string }>;
  readonly openIssues: readonly string[];
  readonly continueToken: string; // opaque -- for the harness, not the LLM
}

// Concrete sliding window implementation:
class SlidingWindowStrategy implements MessageWindowStrategy {
  constructor(
    private readonly windowTurns: number, // e.g. 20 turns = ~40 messages
    private readonly anchorSerializer: (anchor: SessionStateAnchor) => string,
  ) {}

  buildWindow(
    messages: ReadonlyArray<AgentInternalMessage>,
    anchor: SessionStateAnchor,
  ): ReadonlyArray<AgentInternalMessage> {
    // Take last windowTurns * 2 messages (each turn = 1 assistant + 1 tool-result user).
    // Prepend a synthetic user message containing anchorSerializer(anchor).
    // Return the constructed slice.
  }
}
```

### Works if framing is RIGHT (context degradation dominates)?

**Yes, most directly.** Context degradation is caused by context accumulation. This approach
eliminates context accumulation in-session. The LLM never enters the degradation zone because
the context window never grows beyond K turns + anchor. No handoff required; sessions run to
completion.

Caveat: the anchor must be complete. Incomplete anchors shift the failure mode from
"degradation" to "hallucination about dropped context." This is potentially worse because
it is harder to detect.

### Works if framing is WRONG (recoverable errors dominate)?

**Yes, with benefit.** Smaller context windows mean faster API calls and lower token burn.
The window strategy is transparent to the rest of the system. Recoverable errors are still
recoverable -- nothing in this approach interferes with error handling.

---

## Approach 5 (p=0.02): Multi-Epoch Session Protocol with Cryptographic State Handoff

**Primary mechanism:** A session is divided into cryptographically-bounded epochs at compile
time. Each epoch has a maximum token budget. At epoch end, the engine produces an encrypted
state capsule (using the HMAC token infrastructure already in place) that the next epoch's
agent loop verifies before proceeding. The agent never sees the raw capsule -- it receives
a human-readable session brief derived from it. Epoch boundaries are step boundaries; the
capsule is the continueToken extended with a compressed epoch summary.

This approach collapses the distinction between "WorkRail engine session state" and "agent
context state" -- both are managed by the same token protocol.

### How it resolves tensions

**Prevention vs recovery:** Full prevention via compile-time epoch boundaries. No session
can exceed its epoch token budget any more than a session can bypass an HMAC token -- both
are enforced by the engine.

**Coupling vs generality:** Moderate. Epoch boundaries must be declared in the workflow
schema (or computed automatically from step structure). The capsule content is generic
(derived from `SessionState`). The enforcement mechanism is the existing token protocol.

**Suspension granularity:** Epoch-level = step-level. Clean by construction, same as
Approach 2.

**Operator escalation:** Engine refuses to start a new epoch if the capsule fails
verification (corrupted state, TTL expired). Escalation path is the same as blocked-node
handling today: human review required.

### Key tradeoffs

- High implementation complexity. Extending the HMAC token protocol to carry epoch capsules
  requires changes to `src/v2/durable-core/` -- the module that AGENTS.md explicitly marks
  as load-bearing infrastructure requiring extra adversarial scrutiny.
- The compile-time epoch assignment adds authoring complexity. Workflow authors must declare
  epoch structure or trust the compiler's heuristics. Wrong epoch assignment (too many steps
  per epoch) defeats the purpose.
- The key insight -- that HMAC tokens and context state are the same problem (both are "how
  do we carry trusted state across session boundaries?") -- is architecturally correct but
  the integration is novel and carries high implementation risk.
- The capsule injection (human-readable brief derived from the capsule) solves the
  "anchor completeness" problem from Approach 4: the brief is derived from the full engine
  state, not a subset, so completeness is verifiable.
- Most ambitious of the five candidates. Requires the most changes to protected files.
  Not recommended unless Approaches 1 or 4 are empirically insufficient.

### TypeScript interface sketch

```typescript
// Extended continueToken payload (conceptual -- actual HMAC encoding is opaque):
interface EpochCapsule {
  readonly epochIndex: number;
  readonly tokensBurned: number;
  readonly epochBudgetTokens: number;
  readonly stepNotesSummary: string;         // deterministic extraction from SessionState
  readonly openIssuesSummary: string;
  readonly contextVariablesSnapshot: Readonly<Record<string, unknown>>;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

// New engine output on epoch boundary:
interface EpochHandoffOutput {
  readonly kind: 'epoch_handoff';
  /** Opaque HMAC-signed capsule. Next epoch's start_workflow call must include this. */
  readonly epochCapsule: string;
  /** Human-readable brief injected as first user message in the new epoch's session. */
  readonly epochBrief: string;
  readonly nextEpochContinueToken: string;
}

// Workflow schema extension (new field on step node or workflow root):
interface WorkflowEpochConfig {
  /** Maximum input tokens per epoch. Absent = single epoch (current behavior). */
  readonly epochTokenBudget?: number;
  /** Steps per epoch. Alternative to token budget -- whichever fires first wins. */
  readonly epochStepBudget?: number;
}
```

### Works if framing is RIGHT (context degradation dominates)?

**Yes, most robustly and most expensively.** Epoch boundaries enforced by the token protocol
are structurally equivalent to the degradation zone being architecturally unreachable. The
cryptographic enforcement means no agent-side bug or misconfiguration can accidentally exceed
an epoch budget -- the engine refuses.

### Works if framing is WRONG (recoverable errors dominate)?

**Yes, with overhead.** Epoch handoffs fire at budget but there is no degradation. Overhead
is one capsule write + one session re-spawn per epoch boundary. For workflows that complete
within a single epoch, overhead is zero.

---

## Comparative Summary

| Approach | p(typical AI would suggest) | Degradation prevention | Recovery if framing wrong | Implementation risk | Breaks protected files |
|---|---|---|---|---|---|
| 1. Turn-Budget Checkpoint-and-Handoff | 0.65 | Strong (budget-based) | Low overhead | Low | No |
| 2. Step-Scoped Context Windows | 0.30 | Strongest (compile-time) | Harmless | Medium (schema change) | No |
| 3. Coherence-Probe Turn | 0.08 | Weak (detects, not prevents) | LLM call overhead | Low | No |
| 4. Sliding Window + State Anchor | 0.04 | Strong (in-session) | Net positive (lower cost) | Medium (AgentLoop) | No |
| 5. Multi-Epoch HMAC Protocol | 0.02 | Strongest + cryptographic | Low overhead | Very high | Yes (v2/durable-core) |

### Recommendation for production path

If calibration data from the production failure corpus is available (token counts and step
counts at failure): **Approach 1** is the lowest-risk starting point. It operates at the
existing session boundaries (gate_parked / resumeFromGate pattern already exists), requires
no schema changes, and produces a measurable outcome (0-of-13 improving to N-of-13).

If the wr.mr-review workflow is redesigned to have explicit step artifact contracts:
**Approach 2** is the highest-fidelity long-term architecture. It collapses the context
management problem into the already-planned output contract enforcement work.

**Approach 4** is the best candidate if the goal is to fix the current session without any
handoff mechanics -- it improves the happy path and eliminates degradation simultaneously.
The anchor completeness risk is manageable if `SessionState` is augmented with the required
fields. This is the approach most likely to fix 0/13 without requiring workflow redesign.

**Approaches 3 and 5** are not recommended for the near term: 3 violates criterion 3 (no
LLM calls in harness) and 5 touches the most dangerous files in the codebase for a benefit
achievable by simpler means.

### Relationship to existing design work

- **session-budget-cooperative-completion.md**: Approach 1 is compatible with and extends
  the cooperative completion design. `ContextHandoffCheckpoint` is a subtype of
  `PausedCheckpoint` with an added `handoffSummary` field.
- **native-context-management-epic.md**: That epic was tombstoned. Approach 4 is a narrower,
  harness-local version of the same idea -- it does not require the epic's scope.
- **Gate system (gate_parked / resumeFromGate)**: Approach 1 and Approach 5 both use the
  existing suspension/resumption mechanism as the handoff transport. Clean reuse.
