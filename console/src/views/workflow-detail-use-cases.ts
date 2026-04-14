/**
 * Pure use cases for WorkflowDetail.
 *
 * No React imports. All functions are deterministic and side-effect-free.
 */
import type { ConsoleWorkflowSummary } from '../api/types';

// ---------------------------------------------------------------------------
// getAdjacentWorkflows
// ---------------------------------------------------------------------------

export interface AdjacentWorkflows {
  readonly prevWorkflow: ConsoleWorkflowSummary | null;
  readonly nextWorkflow: ConsoleWorkflowSummary | null;
}

/**
 * Returns the immediately adjacent workflows (prev and next) in a flat list.
 *
 * Returns null for both when workflowId is null/empty or not found in the list.
 * Returns null for prevWorkflow when at the start of the list.
 * Returns null for nextWorkflow when at the end of the list.
 *
 * Pure function: same inputs always produce the same output.
 */
export function getAdjacentWorkflows(
  workflowId: string | null | undefined,
  workflows: readonly ConsoleWorkflowSummary[],
): AdjacentWorkflows {
  if (!workflowId) return { prevWorkflow: null, nextWorkflow: null };

  const idx = workflows.findIndex((w) => w.id === workflowId);
  if (idx === -1) return { prevWorkflow: null, nextWorkflow: null };

  return {
    prevWorkflow: idx > 0 ? (workflows[idx - 1] ?? null) : null,
    nextWorkflow: idx < workflows.length - 1 ? (workflows[idx + 1] ?? null) : null,
  };
}
