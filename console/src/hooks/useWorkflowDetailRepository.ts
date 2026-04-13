/**
 * Repository hook for workflow detail data.
 *
 * Wraps useWorkflowDetail() from the API layer and returns clean domain types.
 * Callers receive WorkflowDetailRepoData -- they never see raw React Query objects.
 *
 * HttpError handling: HTTP 404 is mapped to the `not_found` variant at this
 * boundary so callers never need to inspect HttpError directly. All other
 * errors are mapped to the `error` variant with a human-readable message.
 *
 * Enabled guard: uses `enabled: !!workflowId` internally (via the underlying
 * useWorkflowDetail hook) so passing null or empty string triggers no network
 * request and returns `{ kind: 'loading' }` until a real ID is provided.
 */
import type { ConsoleWorkflowDetail } from '../api/types';
import { useWorkflowDetail, HttpError } from '../api/hooks';

// ---------------------------------------------------------------------------
// Domain type returned by this repository
// ---------------------------------------------------------------------------

export type WorkflowDetailRepoData =
  | { readonly kind: 'loading' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'error'; readonly message: string; readonly refetch: () => void }
  | { readonly kind: 'ready'; readonly detail: ConsoleWorkflowDetail; readonly refetch: () => void };

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Returns clean workflow detail domain data from React Query.
 *
 * This hook is the repository layer: it owns the data-fetching boundary.
 * All React Query details (staleTime, query keys, HttpError) are encapsulated
 * here and never leak to callers.
 *
 * Pass null or empty string when no workflow is selected -- the query is
 * disabled and `{ kind: 'loading' }` is returned without triggering a fetch.
 */
export function useWorkflowDetailRepository(
  workflowId: string | null,
): WorkflowDetailRepoData {
  const query = useWorkflowDetail(workflowId);

  // Map the stable refetch to a plain () => void so callers
  // don't need to handle the React Query return value.
  const refetch = (): void => { void query.refetch(); };

  if (query.isLoading) return { kind: 'loading' };

  if (query.error) {
    // Map 404 to a typed not_found state so the view can render a
    // "workflow not found" message without inspecting HttpError directly.
    if (query.error instanceof HttpError && query.error.status === 404) {
      return { kind: 'not_found' };
    }
    return {
      kind: 'error',
      message: query.error instanceof Error
        ? query.error.message
        : 'Could not load workflow details.',
      refetch,
    };
  }

  if (query.data) {
    return { kind: 'ready', detail: query.data, refetch };
  }

  // No data and no error -- still loading (query disabled or pending).
  return { kind: 'loading' };
}
