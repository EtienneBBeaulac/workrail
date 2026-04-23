/**
 * Session recovery policy for daemon startup crash recovery.
 *
 * WHY a separate module: keeps the policy pure and testable without any I/O
 * setup. The caller (runStartupRecovery in workflow-runner.ts) handles all
 * I/O; this module only makes the binary resume/discard decision.
 *
 * Design invariants (from pitch + design-review):
 * - stepAdvances >= 1 -> 'resume': meaningful WorkRail step output exists; the
 *   agent can re-read prior step notes and orient itself even without LLM history.
 * - stepAdvances === 0 -> 'discard': no durable work recorded; re-dispatch is
 *   cheaper than resuming a session with no checkpointed progress.
 *
 * Intentionally excluded (per pitch no-gos):
 * - 'human_review': no operator-decision queue; recovery is fully automatic.
 * - LLM turn count as discriminator: turn count is not persisted across crashes.
 */

/**
 * Input for the recovery policy evaluation.
 * Pure data -- no I/O dependencies.
 */
export interface RecoveryEvaluationInput {
  /**
   * Number of WorkRail step advances (advance_recorded events) found in the
   * session event log. 0 means no step output was committed before the crash.
   */
  readonly stepAdvances: number;
  /**
   * Wall-clock age of the session sidecar in milliseconds.
   * Measured as (Date.now() - sidecar.ts) at recovery time.
   */
  readonly ageMs: number;
}

/**
 * Recovery action for an orphaned session.
 *
 * 'resume'  -- call executeContinueWorkflow with intent: 'rehydrate' to
 *              re-deliver the current step prompt to a fresh agent run.
 * 'discard' -- delete the session sidecar; issue eligible for re-dispatch
 *              in the next poll cycle (~5 min).
 */
export type RecoveryAction = 'resume' | 'discard';

/**
 * Evaluate the recovery action for an orphaned session.
 *
 * Pure function: no I/O, no side effects, deterministic output.
 *
 * Rules:
 * - stepAdvances >= 1: 'resume' (meaningful WorkRail step output exists)
 * - stepAdvances === 0: 'discard' (no durable progress; re-dispatch is safe)
 *
 * @param input - The session's step advance count and age.
 * @returns 'resume' or 'discard'.
 */
export function evaluateRecovery(input: RecoveryEvaluationInput): RecoveryAction {
  if (input.stepAdvances >= 1) {
    return 'resume';
  }
  return 'discard';
}
