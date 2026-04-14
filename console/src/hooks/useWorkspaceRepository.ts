/**
 * Repository hook for workspace data.
 *
 * Wraps React Query hooks (useSessionList, useWorktreeList, useWorkspaceEvents)
 * and returns clean domain types. Callers receive WorkspaceRepoData -- they
 * never see raw React Query objects.
 *
 * Loading detection: uses query.isLoading (NOT query.isFetching).
 * isLoading is only true when there is no cached data.
 * isFetching is also true during SSE-triggered background refetches, which
 * would incorrectly reset the view to a loading state on every server event.
 *
 * SSE subscription: useWorkspaceEvents() is called here to maintain the
 * server-sent event connection that invalidates the sessions cache in
 * real time. It must be called in the repository so the subscription
 * lifetime is tied to the WorkspaceView's mount lifetime.
 */
import type { ConsoleSessionSummary, ConsoleRepoWorktrees } from '../api/types';
import { useSessionList, useWorktreeList, useWorkspaceEvents } from '../api/hooks';

// ---------------------------------------------------------------------------
// Domain type returned by this repository
// ---------------------------------------------------------------------------

export interface WorkspaceRepoData {
  /** Session list data. Undefined only during the initial fetch (no cached data). */
  readonly sessions: readonly ConsoleSessionSummary[] | undefined;
  /** Worktree repos. Defaults to empty array while loading. */
  readonly worktreeRepos: readonly ConsoleRepoWorktrees[];
  /**
   * True only during the initial fetch (no cached data exists yet).
   * False during SSE-triggered background refetches where stale data remains visible.
   */
  readonly isLoading: boolean;
  /** Non-null only when the sessions query has failed with no recoverable data. */
  readonly error: Error | null;
  /** Triggers an immediate re-fetch of session data. */
  readonly refetch: () => void;
  /** True while the worktrees enrichment fetch is in progress. */
  readonly worktreesFetching: boolean;
  /** Count of sessions currently in progress. 0 when sessions are not yet loaded. */
  readonly liveCount: number;
  /** Count of sessions currently blocked. 0 when sessions are not yet loaded. */
  readonly blockedCount: number;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Returns clean workspace domain data from React Query.
 *
 * This hook is the repository layer: it owns the data-fetching boundary.
 * All React Query details (staleTime, refetchInterval, query keys) are
 * encapsulated here and never leak to callers.
 */
export function useWorkspaceRepository(): WorkspaceRepoData {
  const sessionsQuery = useSessionList();
  const worktreesQuery = useWorktreeList();

  // Subscribe to server-sent events. This call has no return value;
  // its side effect is to invalidate the sessions cache when the server
  // reports a change. Must be called here (not in the ViewModel) so the
  // SSE connection lifetime is tied to this hook's mount lifetime.
  // In practice this is AppShell's lifetime (never unmounts), which is
  // the intended behavior -- the workspace stays live for the entire session.
  useWorkspaceEvents();

  const sessions = sessionsQuery.data?.sessions;

  return {
    sessions,
    worktreeRepos: worktreesQuery.data?.repos ?? [],
    // Use isLoading (not isFetching) to avoid flickering back to loading state
    // during SSE-triggered background refetches where stale data is still visible.
    isLoading: sessionsQuery.isLoading,
    error: sessionsQuery.error instanceof Error ? sessionsQuery.error : null,
    refetch: sessionsQuery.refetch,
    worktreesFetching: worktreesQuery.isFetching,
    liveCount: sessions?.filter((s) => s.status === 'in_progress').length ?? 0,
    blockedCount: sessions?.filter((s) => s.status === 'blocked').length ?? 0,
  };
}
