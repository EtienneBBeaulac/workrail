/**
 * Repository hook for workflows catalog data.
 *
 * Wraps useWorkflowList() from the API layer and returns clean domain types.
 * Callers receive WorkflowsRepoData -- they never see raw React Query objects.
 *
 * The 'routines' tag exclusion happens here so all downstream consumers
 * (use cases, ViewModel, view) receive a pre-filtered list.
 */
import type { ConsoleWorkflowSummary } from '../api/types';
import { useWorkflowList } from '../api/hooks';

// ---------------------------------------------------------------------------
// Domain type returned by this repository
// ---------------------------------------------------------------------------

export interface WorkflowsRepoData {
  /**
   * Workflow list, excluding 'routines' workflows.
   * Undefined only during the initial fetch (no cached data).
   */
  readonly workflows: readonly ConsoleWorkflowSummary[] | undefined;
  /**
   * True only during the initial fetch (no cached data exists yet).
   */
  readonly isLoading: boolean;
  /** Non-null only when the workflows query has failed with no recoverable data. */
  readonly error: Error | null;
  /** Triggers an immediate re-fetch of workflow data. */
  readonly refetch: () => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Returns clean workflows domain data from React Query.
 *
 * This hook is the repository layer: it owns the data-fetching boundary.
 * All React Query details (staleTime, query keys) are encapsulated here
 * and never leak to callers.
 */
export function useWorkflowsRepository(): WorkflowsRepoData {
  const query = useWorkflowList();

  return {
    // Filter out 'routines' at the boundary so downstream consumers never
    // see them. Routines are implementation building blocks for workflow
    // authors, not user-facing catalog entries.
    workflows: query.data?.workflows.filter((w) => !w.tags.includes('routines')),
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error : null,
    refetch: query.refetch,
  };
}
