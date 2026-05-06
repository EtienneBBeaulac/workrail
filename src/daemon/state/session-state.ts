/**
 * SessionState: the explicit mutable record for a single runWorkflow() call.
 *
 * WHY a separate module: concentrates the mutation surface in one place.
 * All code that writes to SessionState fields either calls a named transition
 * function from this module or is shell-layer code (buildTurnEndSubscriber,
 * buildPreAgentSession) that documents its impurity explicitly.
 *
 * WHY named transitions: each transition function either enforces a nontrivial
 * invariant or combines related writes that must happen atomically. A bare
 * `state.currentContinueToken = token` scattered across closures is harder to
 * audit than a named `updateToken(state, token)` call.
 *
 * WHY this module has no node: or SDK imports: it is part of the functional
 * core. It must be importable in any test context without I/O stubs.
 *
 * Shell-layer code that writes state directly (buildTurnEndSubscriber increments
 * turnCount, buildPreAgentSession sets workrailSessionId) does so intentionally --
 * these are orchestration-layer mutations, not domain mutations. The SessionState
 * interface documents which fields each layer owns.
 */

import type { TerminalSignal } from './terminal-signal.js';

// ---------------------------------------------------------------------------
// SessionState interface
// ---------------------------------------------------------------------------

/**
 * All mutable state for a single runWorkflow() call.
 *
 * WHY a named interface (not 13 separate let declarations): makes the mutation
 * surface explicit and auditable. Every field that changes during a session is
 * visible here, not scattered across a 1000-line function body. The object is
 * passed by reference so closures (onAdvance, onComplete, onTokenUpdate, the
 * steer callback) capture `state` once and see all mutations.
 *
 * WHY mutable (not readonly): the callback pattern inherently mutates shared
 * state. Making it explicitly mutable is better than hiding mutation in closures.
 *
 * INVARIANT: workrailSessionId starts null and is populated asynchronously
 * after parseContinueTokenOrFail() succeeds. All closures that need it capture
 * `state` by reference -- they see the correct value when they execute (after
 * assignment), because JavaScript object mutation is visible through all references.
 */
export interface SessionState {
  /** Set to true by onComplete when the workflow's final step is advanced. */
  isComplete: boolean;
  /** Notes from the agent's final continue_workflow/complete_step call. */
  lastStepNotes: string | undefined;
  /** Artifacts from the agent's final continue_workflow/complete_step call. */
  lastStepArtifacts: readonly unknown[] | undefined;
  /**
   * The current session token injected by complete_step.
   * Updated by advanceStep() and updateToken().
   * INVARIANT: always updated AFTER persistTokens() is called.
   */
  currentContinueToken: string;
  /**
   * The WorkRail sess_* ID decoded from the continueToken after executeStartWorkflow.
   * Starts null; populated by setSessionId(). Used to key DaemonRegistry,
   * ActiveSessionSet, and event emission.
   */
  workrailSessionId: string | null;
  /**
   * Number of times advanceStep() was called (workflow step advances in the agent loop).
   * Used for stuck detection Signal 2 and recorded in execution stats as stepCount.
   */
  stepAdvanceCount: number;
  /**
   * Ring buffer of the last STUCK_REPEAT_THRESHOLD tool calls.
   * Used by stuck detection Signal 1 (repeated tool + same args).
   * Written by recordToolCall().
   */
  lastNToolCalls: Array<{ toolName: string; argsSummary: string }>;
  /** Issue summaries from report_issue calls; included in WORKTRAIN_STUCK marker. */
  issueSummaries: string[];
  /**
   * Pending text parts to inject via agent.steer() on the next turn_end.
   * Populated by advanceStep() (step text) and the steer callback (coordinator injection).
   */
  pendingSteerParts: string[];
  /**
   * Terminal signal for this session, or null if none has fired.
   *
   * WHY a single discriminated union (not separate stuckReason + timeoutReason):
   * Two independent nullable fields encoded invariant 1.4 (stuck > timeout) via
   * convention. This field makes the illegal state (stuck AND timeout simultaneously)
   * structurally impossible. Only one terminal signal can exist per session.
   *
   * INVARIANT: write only through setTerminalSignal() -- never assign directly.
   * setTerminalSignal() is first-writer-wins; subsequent calls are silent no-ops.
   */
  terminalSignal: TerminalSignal | null;
  /** Number of complete LLM response turns since the agent loop started. */
  turnCount: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a fresh SessionState for a new runWorkflow() call.
 *
 * @param initialToken - The continueToken from executeStartWorkflow. This is
 *   the first token complete_step will inject for the first workflow step.
 */
export function createSessionState(initialToken: string): SessionState {
  return {
    isComplete: false,
    lastStepNotes: undefined,
    lastStepArtifacts: undefined,
    currentContinueToken: initialToken,
    workrailSessionId: null,
    stepAdvanceCount: 0,
    lastNToolCalls: [],
    issueSummaries: [],
    pendingSteerParts: [],
    terminalSignal: null,
    turnCount: 0,
  };
}

// ---------------------------------------------------------------------------
// Named transition functions
// ---------------------------------------------------------------------------

/**
 * Advance the workflow to the next step.
 *
 * WHY a named transition: combines three writes that must happen atomically --
 * pushing the step text to the steer queue, incrementing the advance count, and
 * updating the continue token. Writing these three separately risks forgetting one.
 *
 * Called by the onAdvance callback in buildAgentReadySession().
 */
export function advanceStep(state: SessionState, stepText: string, continueToken: string): void {
  state.pendingSteerParts.push(stepText);
  state.stepAdvanceCount++;
  state.currentContinueToken = continueToken;
}

/**
 * Record workflow completion with final step output.
 *
 * WHY a named transition: combines three writes (isComplete, lastStepNotes,
 * lastStepArtifacts) that represent a single atomic completion event.
 *
 * Called by the onComplete callback in buildAgentReadySession().
 */
export function recordCompletion(
  state: SessionState,
  notes: string | undefined,
  artifacts?: readonly unknown[],
): void {
  state.isComplete = true;
  state.lastStepNotes = notes;
  state.lastStepArtifacts = artifacts;
}

/**
 * Update the continue token without advancing the step.
 *
 * WHY a named transition: makes the blocked-node retry-token update explicit.
 * When the engine returns a blocked response, the token changes but the step
 * does not advance. A bare `state.currentContinueToken = t` at the retry path
 * is easy to confuse with a step advance.
 *
 * Called by the onTokenUpdate callback in buildAgentReadySession().
 */
export function updateToken(state: SessionState, token: string): void {
  state.currentContinueToken = token;
}

/**
 * Set the WorkRail session ID once it is decoded from the continue token.
 *
 * WHY a named transition: documents that this is the async resolve of a field
 * that starts null. A bare `state.workrailSessionId = id` in buildPreAgentSession
 * would be easy to miss in a code review as a mutation with timing significance.
 *
 * Called by buildPreAgentSession() after parseContinueTokenOrFail() succeeds.
 */
export function setSessionId(state: SessionState, id: string): void {
  state.workrailSessionId = id;
}

/**
 * Record a tool call in the ring buffer for stuck detection.
 *
 * WHY a named transition: the ring buffer pattern (push + bounded shift) is easy
 * to get wrong inline -- off-by-one on the cap or a missing shift leaves stale
 * entries that produce false positives or negatives in stuck detection.
 *
 * Called by the onToolCallStarted callback in buildAgentCallbacks().
 *
 * @param threshold - Maximum ring buffer size (STUCK_REPEAT_THRESHOLD, currently 3).
 */
export function recordToolCall(
  state: SessionState,
  toolName: string,
  argsSummary: string,
  threshold: number,
): void {
  state.lastNToolCalls.push({ toolName, argsSummary });
  if (state.lastNToolCalls.length > threshold) state.lastNToolCalls.shift();
}
