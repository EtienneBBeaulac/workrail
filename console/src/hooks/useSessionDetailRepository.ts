/**
 * Repository hook for session detail data.
 *
 * Wraps the useSessionDetail React Query hook and returns clean domain types.
 * Callers receive SessionDetailRepoData -- they never see raw React Query objects.
 *
 * Loading detection: uses query.isLoading (NOT query.isFetching).
 * isLoading is only true when there is no cached data.
 * isFetching is also true during background refetches (every 5s via refetchInterval),
 * which would incorrectly reset the view to a loading state on every poll cycle.
 */
import type { ConsoleSessionDetail } from '../api/types';
import { useSessionDetail } from '../api/hooks';

// ---------------------------------------------------------------------------
// Domain type returned by this repository
// ---------------------------------------------------------------------------

export interface SessionDetailRepoData {
  /** Session detail data. Undefined only during the initial fetch (no cached data). */
  readonly data: ConsoleSessionDetail | undefined;
  /**
   * True only during the initial fetch (no cached data exists yet).
   * False during background refetches where stale data remains visible.
   */
  readonly isLoading: boolean;
  /** Non-null only when the session detail query has failed. */
  readonly error: Error | null;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Returns clean session detail domain data from React Query.
 *
 * This hook is the repository layer: it owns the data-fetching boundary.
 * All React Query details (staleTime, refetchInterval, query keys) are
 * encapsulated here and never leak to callers.
 */
export function useSessionDetailRepository(sessionId: string): SessionDetailRepoData {
  const query = useSessionDetail(sessionId);

  return {
    data: query.data,
    // Use isLoading (not isFetching) to avoid flickering back to loading state
    // during the 5s poll refetches where stale data is still visible.
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error : null,
  };
}
