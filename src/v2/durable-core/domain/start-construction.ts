import type { Workflow } from '../../../types/workflow.js';
import type { CompiledWorkflowSnapshotV1 } from '../schemas/compiled-workflow/index.js';
import { type Result, ok, err } from 'neverthrow';

// ─────────────────────────────────────────────────────────────────────────────
// Startability Failure Discriminated Union
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Discriminated union for startability failures.
 *
 * Philosophy: "Make illegal states unrepresentable" + "Exhaustiveness everywhere"
 * Each failure mode is a distinct variant with specific context.
 */
export type StartabilityFailure =
  | { readonly reason: 'no_steps'; readonly detail: 'Workflow has no steps in authored form' }
  | { readonly reason: 'first_step_not_in_executable'; readonly authoredStepId: string; readonly detail: string }
  | { readonly reason: 'no_reachable_step'; readonly detail: 'Interpreter returned isComplete=true with zero completed steps' }
  | { readonly reason: 'interpreter_error'; readonly detail: string };

// ─────────────────────────────────────────────────────────────────────────────
// First-Step Resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the first step from an authored workflow, validating consistency
 * between authored and pinned executable forms.
 *
 * This is the **shared source of truth** for:
 * - Runtime `start.ts` (lines 62-70): determines the initial pending step
 * - Validation pipeline Phase 1b step 8: proves startability
 *
 * Philosophy: "Single source of resolution truth" + "Determinism over cleverness"
 * Pure function, no I/O, no hidden state, no feature-flag checks.
 *
 * Validates:
 * - Workflow has at least one step in authored form
 * - steps[0].id exists in the pinned executable workflow definition
 *
 * @param authoredWorkflow - The original authored workflow
 * @param pinnedSnapshot - The normalized v1_pinned snapshot with executable definition
 * @returns Result with first step ID or StartabilityFailure
 */
export function resolveFirstStep(
  authoredWorkflow: Workflow,
  pinnedSnapshot: Extract<CompiledWorkflowSnapshotV1, { sourceKind: 'v1_pinned' }>
): Result<{ readonly id: string }, StartabilityFailure> {
  // Check: workflow has at least one step in authored form
  const firstStep = authoredWorkflow.definition.steps[0];
  if (!firstStep) {
    return err({
      reason: 'no_steps',
      detail: 'Workflow has no steps in authored form',
    });
  }

  const firstStepId = firstStep.id;

  // Check: first step ID exists in executable form
  // (Catches normalization bugs where step IDs change or are dropped)
  // The pinned snapshot definition is a generic JSON value at this level,
  // but at runtime it's been validated to be an ExecutableWorkflowDefinition
  const definition = (pinnedSnapshot.definition as any);
  const steps = definition?.steps ?? [];
  const executableStep = steps.find((s: any) => s?.id === firstStepId);
  if (!executableStep) {
    return err({
      reason: 'first_step_not_in_executable',
      authoredStepId: firstStepId,
      detail: `Step '${firstStepId}' from authored workflow steps[0] not found in executable workflow`,
    });
  }

  return ok({ id: firstStepId });
}
