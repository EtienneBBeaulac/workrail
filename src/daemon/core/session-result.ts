/**
 * Pure result construction for daemon workflow sessions.
 *
 * WHY this module: tagToStatsOutcome, sidecardLifecycleFor, and buildSessionResult
 * are pure functions -- no I/O, no node: imports, no SDK deps. They map session
 * state and trigger config to result types and lifecycle decisions.
 *
 * WHY no node: or @anthropic-ai/* imports: this module is part of the functional
 * core. It must be importable in any test context without I/O stubs.
 */

import type { WorkflowTrigger, WorkflowRunResult } from '../types.js';
import type { SessionState } from '../state/session-state.js';
import { assertNever } from '../../runtime/assert-never.js';
import { DEFAULT_SESSION_TIMEOUT_MINUTES, DEFAULT_MAX_TURNS } from './session-context.js';

// ---------------------------------------------------------------------------
// tagToStatsOutcome
// ---------------------------------------------------------------------------

/**
 * Map a WorkflowRunResult._tag to the stats outcome string recorded in execution-stats.jsonl.
 *
 * WHY pure function with assertNever: the compiler enforces exhaustiveness.
 * Adding a new _tag variant to WorkflowRunResult without updating this function
 * produces a TypeScript compile error -- silent omissions are impossible.
 *
 * WHY delivery_failed -> 'success': the workflow ran to completion; only the
 * HTTP callback POST failed. The stats should reflect that the work was done.
 * See WorkflowDeliveryFailed and invariants doc section 1.3.
 */
export function tagToStatsOutcome(tag: WorkflowRunResult['_tag']): 'success' | 'error' | 'timeout' | 'stuck' {
  switch (tag) {
    case 'success': return 'success';
    case 'error': return 'error';
    case 'timeout': return 'timeout';
    case 'stuck': return 'stuck';
    case 'delivery_failed': return 'success'; // workflow succeeded; only POST failed
    default: return assertNever(tag);
  }
}

// ---------------------------------------------------------------------------
// SidecarLifecycle
// ---------------------------------------------------------------------------

/**
 * Sidecar lifecycle decision for a completed runWorkflow() session.
 *
 * WHY a discriminated union: the two outcomes have categorically different
 * cleanup owners. 'delete_now' means runWorkflow() (via finalizeSession) deletes
 * the sidecar before returning. 'retain_for_delivery' means TriggerRouter.maybeRunDelivery()
 * deletes it after git delivery completes -- runWorkflow() must NOT delete it.
 */
export type SidecarLifecycle =
  | { readonly kind: 'delete_now' }
  | { readonly kind: 'retain_for_delivery' };

/**
 * Determine the correct sidecar lifecycle action for a completed session.
 *
 * Pure: no I/O, no side effects, deterministic.
 *
 * Rules (from worktrain-daemon-invariants.md section 2.2):
 * - success + worktree: retain -- delivery (git push, gh pr create) runs in the
 *   worktree after runWorkflow() returns; sidecar must outlive this function.
 * - all other outcomes and branch strategies: delete immediately.
 *
 * WHY delivery_failed hits an explicit throw: runWorkflow() never produces delivery_failed
 * (invariant 1.2). If it ever does, a compile error here forces the caller to handle it.
 */
export function sidecardLifecycleFor(
  tag: WorkflowRunResult['_tag'],
  branchStrategy: WorkflowTrigger['branchStrategy'],
): SidecarLifecycle {
  switch (tag) {
    case 'success':
      return branchStrategy === 'worktree'
        ? { kind: 'retain_for_delivery' }
        : { kind: 'delete_now' };
    case 'error':
    case 'timeout':
    case 'stuck':
      return { kind: 'delete_now' };
    case 'delivery_failed':
      // WHY throw: delivery_failed is in WorkflowRunResult but is never produced by
      // runWorkflow() directly (invariant 1.2). This case is unreachable in production.
      throw new Error(`sidecardLifecycleFor: delivery_failed is not a valid input (invariant 1.2)`);
    default:
      return assertNever(tag);
  }
}

// ---------------------------------------------------------------------------
// buildSessionResult
// ---------------------------------------------------------------------------

/**
 * Build the WorkflowRunResult for the completed session.
 *
 * Pure: reads state and trigger config, produces a typed result value.
 * Does NOT call finalizeSession -- the caller is responsible for that.
 *
 * WHY pure: the result-building logic is deterministic from its inputs.
 * Extracting it makes the mapping from session state to result type
 * independently readable and testable.
 */
export function buildSessionResult(
  state: Readonly<SessionState>,
  stopReason: string,
  errorMessage: string | undefined,
  trigger: WorkflowTrigger,
  sessionId: string,
  sessionWorktreePath: string | undefined,
): WorkflowRunResult {
  // Terminal signal: stuck takes priority over timeout (invariant 1.4 -- structurally
  // enforced by setTerminalSignal's first-writer-wins; this switch handles the result).
  if (state.terminalSignal !== null) {
    const signal = state.terminalSignal;
    if (signal.kind === 'stuck') {
      return {
        _tag: 'stuck',
        workflowId: trigger.workflowId,
        reason: signal.reason,
        message: `Session aborted: stuck heuristic fired (${signal.reason})`,
        stopReason: 'aborted',
        ...(state.issueSummaries.length > 0 ? { issueSummaries: [...state.issueSummaries] } : {}),
      };
    }
    if (signal.kind === 'timeout') {
      const limitDescription = signal.reason === 'wall_clock'
        ? `${trigger.agentConfig?.maxSessionMinutes ?? DEFAULT_SESSION_TIMEOUT_MINUTES} minutes`
        : `${trigger.agentConfig?.maxTurns ?? DEFAULT_MAX_TURNS} turns`;
      return {
        _tag: 'timeout',
        workflowId: trigger.workflowId,
        reason: signal.reason,
        message: `Workflow ${signal.reason === 'wall_clock' ? 'timed out' : 'exceeded turn limit'} after ${limitDescription}`,
        stopReason: 'aborted',
      };
    }
    // WHY assertNever: if TerminalSignal gains a new kind variant, the compiler
    // forces this function to handle it before the code will compile.
    return assertNever(signal);
  }

  if (stopReason === 'error' || errorMessage) {
    const errMsg = errorMessage ?? 'Agent stopped with error reason';
    const lastToolCalled = state.lastNToolCalls.length > 0 ? state.lastNToolCalls[state.lastNToolCalls.length - 1] : null;
    const stuckMarker = `\n\nWORKTRAIN_STUCK: ${JSON.stringify({
      reason: 'session_error',
      error: errMsg.slice(0, 500),
      workflowId: trigger.workflowId,
      sessionId,
      turnCount: state.turnCount,
      stepAdvanceCount: state.stepAdvanceCount,
      ...(lastToolCalled !== null && { lastToolCalled }),
      ...(state.issueSummaries.length > 0 && { issueSummaries: state.issueSummaries }),
    })}`;
    return {
      _tag: 'error',
      workflowId: trigger.workflowId,
      message: errMsg,
      stopReason,
      lastStepNotes: stuckMarker,
    };
  }

  // Success
  return {
    _tag: 'success',
    workflowId: trigger.workflowId,
    stopReason,
    ...(state.lastStepNotes !== undefined ? { lastStepNotes: state.lastStepNotes } : {}),
    ...(state.lastStepArtifacts !== undefined ? { lastStepArtifacts: state.lastStepArtifacts } : {}),
    ...(sessionWorktreePath !== undefined ? { sessionWorkspacePath: sessionWorktreePath } : {}),
    ...(sessionWorktreePath !== undefined ? { sessionId } : {}),
    ...(trigger.botIdentity !== undefined ? { botIdentity: trigger.botIdentity } : {}),
  };
}
