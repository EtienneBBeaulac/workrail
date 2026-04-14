/**
 * ViewModel hook for SessionList.
 *
 * Orchestrates the repository layer, use cases, and reducer into a single
 * SessionListViewState discriminated union for the UI to render.
 *
 * Owns:
 * - Repository data (via useSessionListRepository)
 * - UI interaction state (via sessionListReducer + useReducer)
 * - Debouncing of the search field (useDebounce -- 200ms)
 * - Derived display data (statusCounts, processed groups, flatPageSessions)
 * - Keyboard navigation for the flat (non-grouped) list (useGridKeyNav)
 *
 * Does NOT own:
 * - SSE subscription (handled by useWorkspaceRepository)
 * - Navigation to session detail (injected via onSelectSession parameter)
 * - SessionGroup per-group collapse/pagination state (pure UI sub-component)
 *
 * Debounce design:
 * - The reducer stores `rawSearch` (real-time input value).
 * - The ViewModel debounces rawSearch internally and uses only the debounced
 *   value in the useMemo filter pipeline to avoid expensive recomputation on
 *   every keystroke.
 * - The ViewState exposes `rawSearch` for the input field binding. Callers
 *   must NOT bind the input to the debounced value.
 *
 * Keyboard nav design:
 * - useGridKeyNav is called unconditionally (React hooks rule).
 * - count=0 when isGrouped=true -- the hook handles count=0 safely.
 * - onActivate uses a flatPageSessionsRef to avoid stale closures.
 */
import {
  useReducer,
  useMemo,
  useEffect,
  useRef,
  useCallback,
  useState,
} from 'react';
import { useSessionListRepository } from './useSessionListRepository';
import {
  sessionListReducer,
  createInitialSessionListState,
  type SessionListEvent,
} from '../views/session-list-reducer';
import {
  filterSessions,
  sortSessions,
  groupSessions,
  computeStatusCounts,
  PAGE_SIZE,
  type SortField,
  type GroupBy,
  type StatusFilter,
  SORT_AXES,
  GROUP_AXES,
  STATUS_FILTER_OPTIONS,
} from '../views/session-list-use-cases';
import { useGridKeyNav, type UseGridKeyNavResult } from './useGridKeyNav';
import type { ConsoleSessionSummary } from '../api/types';

// ---------------------------------------------------------------------------
// Debounce hook (internal)
// ---------------------------------------------------------------------------

function useDebounce<T>(value: T, delayMs: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setDebouncedValue(value), delayMs);
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [value, delayMs]);

  return debouncedValue;
}

// ---------------------------------------------------------------------------
// View state
// ---------------------------------------------------------------------------

export type SessionListViewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'ready';
      /** Raw (undebounced) search value -- bind the <input> to this field. */
      readonly rawSearch: string;
      readonly sort: SortField;
      readonly groupBy: GroupBy;
      readonly statusFilter: StatusFilter;
      readonly page: number;
      readonly totalPages: number;
      readonly isGrouped: boolean;
      readonly processed: {
        readonly groups: readonly { readonly label: string; readonly sessions: readonly ConsoleSessionSummary[] }[];
        readonly total: number;
        readonly filtered: number;
      };
      readonly statusCounts: Record<StatusFilter, number>;
      /** Flat sessions for the current page -- only populated when !isGrouped. */
      readonly flatPageSessions: readonly ConsoleSessionSummary[];
      /** Props to spread onto each session card for keyboard navigation. */
      readonly getSessionNavProps: UseGridKeyNavResult['getItemProps'];
      /** Props to spread onto the session list container for keyboard navigation. */
      readonly sessionContainerProps: UseGridKeyNavResult['containerProps'];
      /** Available sort options. */
      readonly sortAxes: typeof SORT_AXES;
      /** Available group options. */
      readonly groupAxes: typeof GROUP_AXES;
      /** Available status filter options. */
      readonly statusFilterOptions: typeof STATUS_FILTER_OPTIONS;
    };

// ---------------------------------------------------------------------------
// Hook result
// ---------------------------------------------------------------------------

export interface UseSessionListViewModelResult {
  readonly state: SessionListViewState;
  readonly dispatch: (event: SessionListEvent) => void;
  /** Navigate to a session. Injected from the caller; presentation does not own navigation. */
  readonly onSelectSession: (sessionId: string) => void;
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export interface UseSessionListViewModelParams {
  /** Called when the user selects a session (navigation is the caller's concern). */
  readonly onSelectSession: (sessionId: string) => void;
  /**
   * Optional search string to pre-seed the search field
   * (e.g. branch name from worktree click-through).
   */
  readonly initialSearch?: string;
}

// ---------------------------------------------------------------------------
// ViewModel hook
// ---------------------------------------------------------------------------

export function useSessionListViewModel({
  onSelectSession,
  initialSearch = '',
}: UseSessionListViewModelParams): UseSessionListViewModelResult {
  const repo = useSessionListRepository();
  const [interactionState, dispatch] = useReducer(
    sessionListReducer,
    undefined,
    () => createInitialSessionListState(initialSearch),
  );

  // Debounce the raw search value for the filter/sort/group pipeline.
  // The raw value drives the input display; debouncedSearch drives the pipeline.
  const debouncedSearch = useDebounce(interactionState.rawSearch, 200);

  // Stable ref to flatPageSessions to avoid stale closure in onActivate callback.
  // Updated every render so the callback always accesses the current list.
  const flatPageSessionsRef = useRef<readonly ConsoleSessionSummary[]>([]);

  // Stable onActivate callback -- reads from ref to avoid stale closure.
  const onActivate = useCallback(
    (i: number) => {
      const session = flatPageSessionsRef.current[i];
      if (session) onSelectSession(session.sessionId);
    },
    [onSelectSession],
  );

  // Destructure stable scalar values from repo to prevent useMemo re-running
  // when repo object identity changes (new literal every render).
  const { sessions, isLoading, error } = repo;

  // Compute status counts from the FULL unfiltered session list.
  // Invariant: status filter pills show counts for all sessions, regardless
  // of the active filter. Must use `sessions` not `filteredSessions`.
  const statusCounts = useMemo(() => {
    if (!sessions) return {} as Record<StatusFilter, number>;
    return computeStatusCounts(sessions);
  }, [sessions]);

  // Main data pipeline: filter -> sort -> group -> paginate
  const processed = useMemo(() => {
    if (!sessions) return null;
    const filtered = filterSessions(sessions, debouncedSearch, interactionState.statusFilter);
    const sorted = sortSessions(filtered, interactionState.sort);
    const groups = groupSessions(sorted, interactionState.groupBy);
    return { groups, total: sessions.length, filtered: filtered.length };
  }, [sessions, debouncedSearch, interactionState.statusFilter, interactionState.sort, interactionState.groupBy]);

  const isGrouped = interactionState.groupBy !== 'none';
  const totalPages = processed ? Math.ceil(processed.filtered / PAGE_SIZE) : 0;
  const pageStart = interactionState.page * PAGE_SIZE;
  const pageEnd = pageStart + PAGE_SIZE;

  // Flat sessions for the current page (non-grouped path only).
  const flatPageSessions = useMemo(() => {
    if (!processed || isGrouped) return [];
    return processed.groups[0]?.sessions.slice(pageStart, pageEnd) ?? [];
  }, [processed, isGrouped, pageStart, pageEnd]);

  // Keep ref current for stable onActivate callback.
  flatPageSessionsRef.current = flatPageSessions;

  // Keyboard navigation for the flat session list.
  // Called unconditionally -- count=0 when isGrouped=true (safe per useGridKeyNav impl).
  const { getItemProps: getSessionNavProps, containerProps: sessionContainerProps } = useGridKeyNav({
    count: flatPageSessions.length,
    cols: 1,
    onActivate,
  });

  // Construct the discriminated view state
  const state = useMemo((): SessionListViewState => {
    if (isLoading) return { kind: 'loading' };
    if (error) return { kind: 'error', message: error.message };
    if (!processed) return { kind: 'loading' };

    return {
      kind: 'ready',
      rawSearch: interactionState.rawSearch,
      sort: interactionState.sort,
      groupBy: interactionState.groupBy,
      statusFilter: interactionState.statusFilter,
      page: interactionState.page,
      totalPages,
      isGrouped,
      processed,
      statusCounts,
      flatPageSessions,
      getSessionNavProps,
      sessionContainerProps,
      sortAxes: SORT_AXES,
      groupAxes: GROUP_AXES,
      statusFilterOptions: STATUS_FILTER_OPTIONS,
    };
  }, [
    isLoading,
    error,
    processed,
    interactionState,
    totalPages,
    isGrouped,
    statusCounts,
    flatPageSessions,
    getSessionNavProps,
    sessionContainerProps,
  ]);

  return { state, dispatch, onSelectSession };
}
