/**
 * Pure reducer for workspace UI interaction state.
 *
 * Manages only user-driven interaction state: scope toggle, keyboard focus,
 * and archive panel open/close. Loading and error state come from the
 * repository layer (React Query) and are composed into WorkspaceViewState
 * by the ViewModel hook -- they do not live here.
 *
 * No React imports. Pure function: same inputs always produce the same output.
 */
import type { Scope } from './workspace-types';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface ArchiveState {
  readonly repoName: string | undefined;
}

export interface WorkspaceInteractionState {
  readonly scope: Scope;
  readonly focusedIndex: number;
  readonly archive: ArchiveState | null;
}

export const INITIAL_WORKSPACE_STATE: WorkspaceInteractionState = {
  scope: 'active',
  focusedIndex: -1,
  archive: null,
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type WorkspaceEvent =
  | { readonly type: 'scope_changed'; readonly scope: Scope }
  | { readonly type: 'focus_moved'; readonly index: number }
  | { readonly type: 'archive_opened'; readonly repoName: string | undefined }
  | { readonly type: 'archive_closed' };

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function assertNever(value: never): never {
  throw new Error(`Unhandled WorkspaceEvent type: ${String((value as { type: string }).type)}`);
}

/**
 * Pure workspace reducer. Handles UI interaction events only.
 *
 * Invariant: focusedIndex of -1 means no item is focused.
 * Resetting focusedIndex to -1 when the item list changes is handled
 * by the ViewModel hook via a useEffect, not here.
 */
export function workspaceReducer(
  state: WorkspaceInteractionState,
  event: WorkspaceEvent,
): WorkspaceInteractionState {
  switch (event.type) {
    case 'scope_changed':
      // Reset keyboard focus when scope changes -- the item list reorders,
      // so the current index no longer points to the same item.
      return { ...state, scope: event.scope, focusedIndex: -1 };

    case 'focus_moved':
      return { ...state, focusedIndex: event.index };

    case 'archive_opened':
      return { ...state, archive: { repoName: event.repoName } };

    case 'archive_closed':
      return { ...state, archive: null };

    default:
      return assertNever(event);
  }
}
