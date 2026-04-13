/**
 * Pure reducer for SessionList UI interaction state.
 *
 * Manages only user-driven interaction state: search input, sort axis,
 * group axis, status filter, and pagination cursor. Loading and error state
 * come from the repository layer (React Query) and are composed into
 * SessionListViewState by the ViewModel hook -- they do not live here.
 *
 * No React imports. Pure function: same inputs always produce the same output.
 *
 * Invariant: `page` is always reset to 0 when any filter, sort, or group
 * changes. Only `page_changed` events may set page to a non-zero value.
 * This prevents stale pagination state after a filter narrows the result set.
 */
import type { SortField, GroupBy, StatusFilter } from './session-list-use-cases';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface SessionListInteractionState {
  /**
   * Raw (undebounced) search value. Drives the input field display.
   * The ViewModel applies debouncing before using this in the data pipeline.
   */
  readonly rawSearch: string;
  readonly sort: SortField;
  readonly groupBy: GroupBy;
  readonly statusFilter: StatusFilter;
  readonly page: number;
}

// ---------------------------------------------------------------------------
// Initial state factory
// ---------------------------------------------------------------------------

/**
 * Creates the initial interaction state.
 *
 * @param initialSearch - Optional search string to pre-seed the search field
 *   (e.g. branch name from worktree click-through).
 */
export function createInitialSessionListState(
  initialSearch = '',
): SessionListInteractionState {
  return {
    rawSearch: initialSearch,
    sort: 'recent',
    groupBy: 'none',
    statusFilter: 'all',
    page: 0,
  };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type SessionListEvent =
  | { readonly type: 'search_changed'; readonly value: string }
  | { readonly type: 'sort_changed'; readonly sort: SortField }
  | { readonly type: 'group_changed'; readonly groupBy: GroupBy }
  | { readonly type: 'status_changed'; readonly statusFilter: StatusFilter }
  | { readonly type: 'page_changed'; readonly page: number };

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function assertNever(value: never): never {
  throw new Error(`Unhandled SessionListEvent type: ${String((value as { type: string }).type)}`);
}

/**
 * Pure session list reducer. Handles UI interaction events only.
 *
 * Invariant: page is reset to 0 on all non-page_changed events. This ensures
 * the user does not see a blank list after a filter narrows the result set
 * to fewer pages than the current page index.
 */
export function sessionListReducer(
  state: SessionListInteractionState,
  event: SessionListEvent,
): SessionListInteractionState {
  switch (event.type) {
    case 'search_changed':
      return { ...state, rawSearch: event.value, page: 0 };

    case 'sort_changed':
      return { ...state, sort: event.sort, page: 0 };

    case 'group_changed':
      return { ...state, groupBy: event.groupBy, page: 0 };

    case 'status_changed':
      return { ...state, statusFilter: event.statusFilter, page: 0 };

    case 'page_changed':
      // page_changed is the only event that does NOT reset page to 0.
      return { ...state, page: event.page };

    default:
      return assertNever(event);
  }
}
