/**
 * Repository hook for session list data.
 *
 * Wraps useSessionList() from the API layer and returns clean domain types.
 * Callers receive SessionListRepoData -- they never see raw React Query objects.
 *
 * Loading detection: uses query.isLoading (NOT query.isFetching).
 * isLoading is only true when there is no cached data.
 * isFetching is also true during SSE-triggered background refetches, which
 * would incorrectly reset the view to a loading state on every server event.
 *
 * SSE subscription: NOT subscribed here. useWorkspaceRepository already
 * maintains the server-sent event connection that invalidates the sessions
 * cache. Adding a second subscription here would create a redundant SSE
 * connection since both hooks share the same ['sessions'] React Query key.
 *
 * React Query deduplication: useSessionList() uses queryKey ['sessions'].
 * Since useWorkspaceRepository also calls useSessionList(), React Query will
 * deduplicate the network request -- no double fetch occurs.
 */
import type { ConsoleSessionSummary } from '../api/types';
import { useSessionList } from '../api/hooks';

// ---------------------------------------------------------------------------
// Domain type returned by this repository
// ---------------------------------------------------------------------------

export interface SessionListRepoData {
  /**
   * Session list data. Undefined only during the initial fetch (no cached data).
   */
  readonly sessions: readonly ConsoleSessionSummary[] | undefined;
  /**
   * True only during the initial fetch (no cached data exists yet).
   * False during SSE-triggered background refetches where stale data remains visible.
   */
  readonly isLoading: boolean;
  /** Non-null only when the sessions query has failed with no recoverable data. */
  readonly error: Error | null;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Returns clean session list domain data from React Query.
 *
 * This hook is the repository layer: it owns the data-fetching boundary.
 * All React Query details (staleTime, refetchInterval, query keys) are
 * encapsulated here and never leak to callers.
 */
export function useSessionListRepository(): SessionListRepoData {
  const query = useSessionList();

  return {
    sessions: query.data?.sessions,
    // Use isLoading (not isFetching) to avoid flickering back to loading state
    // during SSE-triggered background refetches where stale data is still visible.
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error : null,
  };
}
