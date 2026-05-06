/**
 * Stuck detection: pure signal evaluation for the daemon agent loop.
 *
 * WHY a separate module: evaluateStuckSignals() is a pure function over
 * Readonly<SessionState> and StuckConfig -- it has no I/O and can be tested
 * independently without any agent loop infrastructure.
 *
 * WHY this module has no node: or SDK imports: it is part of the functional
 * core. It must be importable in any test context without I/O stubs.
 *
 * The subscriber (buildTurnEndSubscriber) handles all effects (abort, emit,
 * outbox write) after evaluateStuckSignals() returns a signal. The evaluation
 * and the effects are deliberately separated.
 */

import type { SessionState } from './session-state.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Configuration for stuck detection heuristics.
 *
 * WHY separated from SessionState: these are read-only inputs (trigger config +
 * constants). They do not change during the session and do not belong in the
 * mutable SessionState record.
 */
export interface StuckConfig {
  /** Configured max LLM turns for this session (DEFAULT_MAX_TURNS if not set). */
  maxTurns: number;
  /** 'abort' (default) or 'notify_only' -- controls whether abort fires on stuck. */
  stuckAbortPolicy: 'abort' | 'notify_only';
  /** When true, Signal 2 (no_progress) participates in abort. Default: false. */
  noProgressAbortEnabled: boolean;
  /** How many consecutive identical tool calls trigger Signal 1. Currently 3. */
  stuckRepeatThreshold: number;
}

/**
 * A stuck signal returned by evaluateStuckSignals(). Each kind maps to a
 * specific stuck detection heuristic.
 *
 * WHY discriminated union: forces the subscriber to handle each kind explicitly.
 * The subscriber is inherently imperative (calls agent.abort(), emitter.emit(),
 * writes outbox), but the decision of WHICH signal fired is pure.
 */
export type StuckSignal =
  | { kind: 'repeated_tool_call'; toolName: string; argsSummary: string }
  | { kind: 'no_progress'; turnCount: number; maxTurns: number }
  | { kind: 'max_turns_exceeded' }
  | { kind: 'timeout_imminent'; timeoutReason: 'wall_clock' | 'max_turns' };

// ---------------------------------------------------------------------------
// Pure evaluation function
// ---------------------------------------------------------------------------

/**
 * Evaluate all stuck detection signals for the current turn and return the
 * first applicable one, or null if none fires.
 *
 * Pure: reads `state` and `config`, no I/O, no side effects.
 * The caller (turn_end subscriber) handles all effects (abort, emit, outbox).
 *
 * WHY check max_turns_exceeded before repeated_tool_call: the max_turns path
 * in the subscriber returns early (skipping steer injection), so it must be
 * evaluated first. If we returned a repeated_tool_call signal when max_turns
 * also fired, the subscriber would handle the wrong signal.
 *
 * WHY check timeout_imminent last: it is purely observational (the abort was
 * already triggered by the wall-clock timeout). It does not cause a new abort.
 *
 * @param state - Current session state (read-only view).
 * @param config - Stuck detection configuration from the trigger.
 */
export function evaluateStuckSignals(state: Readonly<SessionState>, config: StuckConfig): StuckSignal | null {
  // Signal: max_turns exceeded -- this turn is the termination turn.
  // WHY evaluated first: the subscriber returns early on this signal (no steer injection).
  if (config.maxTurns > 0 && state.turnCount >= config.maxTurns && state.terminalSignal === null) {
    return { kind: 'max_turns_exceeded' };
  }

  // Signal 1: same tool + same args called stuckRepeatThreshold times in a row.
  // WHY argsSummary comparison: same tool with different args is not stuck.
  if (
    state.lastNToolCalls.length === config.stuckRepeatThreshold &&
    state.lastNToolCalls.every(
      (c) => c.toolName === state.lastNToolCalls[0]?.toolName && c.argsSummary === state.lastNToolCalls[0]?.argsSummary,
    )
  ) {
    return {
      kind: 'repeated_tool_call',
      toolName: state.lastNToolCalls[0]?.toolName ?? 'unknown',
      argsSummary: state.lastNToolCalls[0]?.argsSummary ?? '',
    };
  }

  // Signal 2: 80%+ of turns used with 0 step advances.
  // WHY 0.8: conservative -- avoids false positives on research workflows.
  // Returns regardless of noProgressAbortEnabled -- the subscriber checks the flag
  // before deciding whether to abort.
  if (
    config.maxTurns > 0 &&
    state.turnCount >= Math.floor(config.maxTurns * 0.8) &&
    state.stepAdvanceCount === 0
  ) {
    return { kind: 'no_progress', turnCount: state.turnCount, maxTurns: config.maxTurns };
  }

  // Signal 3: wall-clock timeout already firing (session is aborting).
  // WHY observational: the abort was triggered by the timeout Promise rejection,
  // not by this signal. Signal 3 is a last-chance notification, not a new abort.
  if (state.terminalSignal?.kind === 'timeout') {
    return { kind: 'timeout_imminent', timeoutReason: state.terminalSignal.reason };
  }

  return null;
}
