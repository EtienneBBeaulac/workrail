/**
 * ViewModel hook for WorkspaceView.
 *
 * Orchestrates the repository layer, use cases, and reducer into a single
 * WorkspaceViewState discriminated union for the UI to render.
 *
 * Owns:
 * - Repository data (via useWorkspaceRepository)
 * - UI interaction state (via workspaceReducer + useReducer)
 * - Derived display data (via buildRepoGroups in useMemo)
 * - Keyboard navigation (via useWorkspaceKeyboard helper)
 * - Scroll position ref (captured before navigation, restored on return)
 * - Side effects: repo.refetch() called directly when 'r' key is pressed
 *
 * Does NOT own:
 * - expandStateRef (UI concern -- kept in WorkspaceView to survive SSE remounts)
 */
import {
  useReducer,
  useMemo,
  useEffect,
  useRef,
  useCallback,
  type RefObject,
} from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useWorkspaceRepository } from './useWorkspaceRepository';
import {
  workspaceReducer,
  INITIAL_WORKSPACE_STATE,
  type WorkspaceEvent,
  type ArchiveState,
} from '../views/workspace-reducer';
import {
  buildRepoGroups,
  type RepoGroup,
  type WorkspaceItem,
  type Scope,
} from '../views/workspace-types';

// ---------------------------------------------------------------------------
// View state
// ---------------------------------------------------------------------------

export type WorkspaceViewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'ready';
      readonly scope: Scope;
      readonly focusedIndex: number;
      readonly archive: ArchiveState | null;
      readonly repoGroups: readonly RepoGroup[];
      readonly orderedItems: readonly WorkspaceItem[];
      readonly archiveRepos: ReadonlyArray<readonly [string, string]>;
      readonly dormantHiddenCount: number;
      readonly worktreesFetching: boolean;
      readonly hasAnySessions: boolean;
      /** Count of sessions currently in progress. Derived from repository sessions. */
      readonly liveCount: number;
      /** Count of sessions currently blocked. Derived from repository sessions. */
      readonly blockedCount: number;
    };

// ---------------------------------------------------------------------------
// Hook result
// ---------------------------------------------------------------------------

export interface UseWorkspaceViewModelResult {
  readonly state: WorkspaceViewState;
  readonly dispatch: (event: WorkspaceEvent) => void;
  /** Scroll Y position captured before session-detail navigation. Restored on return. */
  readonly scrollYRef: RefObject<number>;
  /** Navigate to a session detail page. Captures scroll position before navigating. */
  readonly onSelectSession: (sessionId: string) => void;
}

// ---------------------------------------------------------------------------
// Internal keyboard hook
// ---------------------------------------------------------------------------

interface WorkspaceKeyboardOptions {
  readonly items: readonly WorkspaceItem[];
  readonly focusedIndex: number;
  readonly scope: Scope;
  readonly archive: ArchiveState | null;
  readonly dispatch: (event: WorkspaceEvent) => void;
  readonly onSelectSession: (sessionId: string) => void;
  /** Called when the user presses 'r'. Side effect; not dispatched as an event. */
  readonly onRefetch: () => void;
  readonly disabled: boolean;
}

/**
 * Installs a document-level keydown handler for workspace keyboard navigation.
 *
 * Keys:
 *   j / ArrowDown  -> focus_moved (next item)
 *   k / ArrowUp    -> focus_moved (prev item)
 *   Enter / Space  -> navigate to focused item's primary session
 *   /              -> archive_opened (global archive)
 *   r              -> calls onRefetch() directly (side effect, not an event)
 *   a              -> scope_changed (toggle active <-> all)
 *   Escape         -> archive_closed (when archive is open)
 *
 * Skips when modifier keys are held or when focus is in a form control.
 */
function useWorkspaceKeyboard({
  items,
  focusedIndex,
  scope,
  archive,
  dispatch,
  onSelectSession,
  onRefetch,
  disabled,
}: WorkspaceKeyboardOptions): void {
  // Refs prevent stale closures inside the stable event listener
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const focusedIndexRef = useRef(focusedIndex);
  focusedIndexRef.current = focusedIndex;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const archiveRef = useRef(archive);
  archiveRef.current = archive;
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  const onSelectSessionRef = useRef(onSelectSession);
  onSelectSessionRef.current = onSelectSession;
  const onRefetchRef = useRef(onRefetch);
  onRefetchRef.current = onRefetch;

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (disabledRef.current) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement
      ) {
        return;
      }

      const items = itemsRef.current;
      const focusedIndex = focusedIndexRef.current;

      switch (e.key) {
        case 'j':
        case 'ArrowDown': {
          e.preventDefault();
          dispatchRef.current({
            type: 'focus_moved',
            index: Math.min(focusedIndex + 1, items.length - 1),
          });
          break;
        }
        case 'k':
        case 'ArrowUp': {
          e.preventDefault();
          dispatchRef.current({
            type: 'focus_moved',
            index: Math.max(focusedIndex - 1, 0),
          });
          break;
        }
        case 'Enter':
        case ' ': {
          e.preventDefault();
          if (focusedIndex >= 0 && focusedIndex < items.length) {
            const item = items[focusedIndex];
            const sessionId = item?.primarySession?.sessionId;
            if (sessionId) {
              onSelectSessionRef.current(sessionId);
            }
          }
          break;
        }
        case 'Escape': {
          if (archiveRef.current !== null) {
            dispatchRef.current({ type: 'archive_closed' });
          }
          break;
        }
        case '/': {
          e.preventDefault();
          dispatchRef.current({ type: 'archive_opened', repoName: undefined });
          break;
        }
        case 'r': {
          e.preventDefault();
          onRefetchRef.current();
          break;
        }
        case 'a': {
          e.preventDefault();
          dispatchRef.current({
            type: 'scope_changed',
            scope: scopeRef.current === 'active' ? 'all' : 'active',
          });
          break;
        }
      }
    }

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

// ---------------------------------------------------------------------------
// ViewModel hook
// ---------------------------------------------------------------------------

export function useWorkspaceViewModel(disabled = false): UseWorkspaceViewModelResult {
  const navigate = useNavigate();
  const repo = useWorkspaceRepository();
  const [interactionState, dispatch] = useReducer(workspaceReducer, INITIAL_WORKSPACE_STATE);

  const scrollYRef = useRef<number>(0);

  const onSelectSession = useCallback(
    (sessionId: string) => {
      scrollYRef.current = window.scrollY;
      void navigate({ to: '/session/$sessionId', params: { sessionId } });
    },
    [navigate],
  );

  // dispatch from useReducer is stable by React spec -- no need to wrap.
  const wrappedDispatch = dispatch;

  // Derive display data from repo + interaction state
  const repoGroupsResult = useMemo(() => {
    if (!repo.sessions) return null;
    return buildRepoGroups(
      repo.sessions,
      repo.worktreeRepos,
      interactionState.scope,
      Date.now(),
    );
  }, [repo.sessions, repo.worktreeRepos, interactionState.scope]);

  // Install keyboard navigation handler
  useWorkspaceKeyboard({
    items: repoGroupsResult?.orderedItems ?? [],
    focusedIndex: interactionState.focusedIndex,
    scope: interactionState.scope,
    archive: interactionState.archive,
    dispatch: wrappedDispatch,
    onSelectSession,
    onRefetch: repo.refetch,
    disabled,
  });

  // Destructure stable scalar values from repo so the state memo only
  // re-runs when specific values change -- not whenever the repo object
  // identity changes (which is every render since it's a new literal).
  const { isLoading, error, worktreesFetching, sessions, liveCount, blockedCount } = repo;

  // Construct the discriminated view state from repo data + interaction state
  const state: WorkspaceViewState = useMemo((): WorkspaceViewState => {
    if (isLoading) return { kind: 'loading' };
    if (error) return { kind: 'error', message: error.message };
    if (!repoGroupsResult) return { kind: 'loading' };

    return {
      kind: 'ready',
      scope: interactionState.scope,
      focusedIndex: interactionState.focusedIndex,
      archive: interactionState.archive,
      repoGroups: repoGroupsResult.repoGroups,
      orderedItems: repoGroupsResult.orderedItems,
      archiveRepos: repoGroupsResult.archiveRepos,
      dormantHiddenCount: repoGroupsResult.dormantHiddenCount,
      worktreesFetching,
      hasAnySessions: (sessions?.length ?? 0) > 0,
      liveCount,
      blockedCount,
    };
  }, [isLoading, error, worktreesFetching, sessions, repoGroupsResult, interactionState, liveCount, blockedCount]);

  return { state, dispatch: wrappedDispatch, scrollYRef, onSelectSession };
}
