/**
 * ViewModel hook for WorkflowsView.
 *
 * Orchestrates the repository layer, use cases, and reducer into a single
 * WorkflowsViewState discriminated union for the UI to render.
 *
 * Owns:
 * - Repository data (via useWorkflowsRepository)
 * - UI interaction state (via workflowsReducer + useReducer)
 * - Derived display data (availableTags, availableSources, filteredWorkflows, flatWorkflows)
 * - Keyboard ownership:
 *     Escape           -> this ViewModel (dispatches modal_closed)
 *     ArrowLeft/Right  -> WorkflowsView (requires modalTransition.navigate, which ViewModel does not own)
 *     Grid j/k/arrows  -> useGridKeyNav in WorkflowsView (catalog nav, no modal)
 * - Focus management (blur trigger element on modal open, restore on close)
 * - Body scroll lock when modal is open
 * - triggerRef: ref to the focused element before modal opens
 *
 * Does NOT own:
 * - useModalTransition -- stays in WorkflowsView since it's pure animation state
 * - scrollRef -- stays in WorkflowsView (pure UI concern)
 * - modalPanelRef -- stays in WorkflowsView (rAF focus target)
 *
 * Tag handling:
 * - selectedTag is URL-driven. The ViewModel accepts initialTag as a parameter and
 *   calls onSelectTag when the tag changes so AppShell can sync the URL.
 */
import {
  useReducer,
  useMemo,
  useEffect,
  useRef,
  useCallback,
  type RefObject,
} from 'react';
import { useWorkflowsRepository } from './useWorkflowsRepository';
import {
  workflowsReducer,
  INITIAL_WORKFLOWS_STATE,
  type WorkflowsEvent,
} from '../views/workflows-reducer';
import {
  getAvailableTags,
  getAvailableSources,
  filterWorkflows,
  flattenWorkflows,
  type WorkflowSourceOption,
} from '../views/workflows-use-cases';
import type { ConsoleWorkflowSummary } from '../api/types';

// ---------------------------------------------------------------------------
// View state
// ---------------------------------------------------------------------------

export type WorkflowsViewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string; readonly onRetry: () => void }
  | {
      readonly kind: 'ready';
      readonly selectedWorkflowId: string | null;
      readonly selectedTag: string | null;
      readonly selectedSource: string | null;
      readonly hintVisible: boolean;
      readonly availableTags: readonly string[];
      readonly availableSources: readonly WorkflowSourceOption[];
      readonly filteredWorkflows: readonly ConsoleWorkflowSummary[];
      readonly flatWorkflows: readonly ConsoleWorkflowSummary[];
    };

// ---------------------------------------------------------------------------
// Hook result
// ---------------------------------------------------------------------------

export interface UseWorkflowsViewModelResult {
  readonly state: WorkflowsViewState;
  readonly dispatch: (event: WorkflowsEvent) => void;
  /** Ref to the element that triggered the modal open. Restored focus on close. */
  readonly triggerRef: RefObject<HTMLElement | null>;
  /**
   * Call this instead of dispatching workflow_selected directly.
   * Captures the trigger element for focus restoration and blurs it before
   * opening the modal (so blur does not fire after the modal is visible).
   */
  readonly onCardSelect: (id: string, triggerEl: HTMLButtonElement) => void;
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export interface UseWorkflowsViewModelParams {
  /** Initial tag from the URL search param. Initializes the reducer's selectedTag. */
  readonly initialTag: string | null;
  /**
   * Called when the user changes the tag filter so AppShell can sync the URL.
   * The ViewModel dispatches tag_changed AND calls this callback.
   */
  readonly onSelectTag: (tag: string | null) => void;
}

// ---------------------------------------------------------------------------
// ViewModel hook
// ---------------------------------------------------------------------------

export function useWorkflowsViewModel({
  initialTag,
  onSelectTag,
}: UseWorkflowsViewModelParams): UseWorkflowsViewModelResult {
  const repo = useWorkflowsRepository();

  const [interactionState, dispatch] = useReducer(workflowsReducer, {
    ...INITIAL_WORKFLOWS_STATE,
    selectedTag: initialTag,
  });

  // Keep selectedTag in sync with URL-driven initialTag.
  // useWorkflowsViewModel is mounted unconditionally in AppShell (not inside the
  // workflows tab conditional), so it never remounts on tab switch. The reducer
  // seeds from initialTag once; this effect keeps it reactive to external navigation
  // (e.g. browser back/forward or direct link to /workflows?tag=foo).
  useEffect(() => {
    if (initialTag !== interactionState.selectedTag) {
      dispatch({ type: 'tag_changed', tag: initialTag });
    }
    // dispatch is stable (useReducer guarantee); interactionState.selectedTag is read
    // inside the effect body, not as a dep, to avoid re-firing after the dispatch itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTag]);

  const triggerRef = useRef<HTMLElement | null>(null);

  // Stable callback: capture trigger element, blur it, then dispatch workflow_selected.
  // Blur must happen before dispatch so it does not fire after the modal becomes visible
  // and confuse focus management. (See design-review-findings.md, Yellow finding.)
  const onCardSelect = useCallback((id: string, triggerEl: HTMLButtonElement) => {
    triggerRef.current = triggerEl;
    triggerEl.blur();
    dispatch({ type: 'workflow_selected', id });
  }, []);

  // Focus management: move focus into the modal on open, restore to trigger on close.
  // modalPanelRef lives in the view -- the view passes it as a focus target via rAF.
  // Here we only handle the restore-to-trigger path.
  useEffect(() => {
    if (!interactionState.selectedWorkflowId && triggerRef.current) {
      const el = triggerRef.current;
      triggerRef.current = null;
      el.focus();
    }
  }, [interactionState.selectedWorkflowId]);

  // Body scroll lock when modal is open.
  // Setting overflow:hidden alone resets scroll to top -- position:fixed preserves it.
  useEffect(() => {
    if (!interactionState.selectedWorkflowId) return;

    const scrollY = window.scrollY;
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = '100%';

    return () => {
      document.body.style.overflow = '';
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
      window.scrollTo(0, scrollY);
    };
  }, [interactionState.selectedWorkflowId]);

  // Keyboard: Escape closes the modal.
  // ArrowLeft/ArrowRight navigation is handled in the view because it requires
  // access to modalTransition.navigate (which the ViewModel does not own).
  useEffect(() => {
    if (!interactionState.selectedWorkflowId) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dispatch({ type: 'modal_closed' });
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [interactionState.selectedWorkflowId]);

  // Derive display data from repo + interaction state.
  // Computed before the hint effect so flatWorkflows.length is readable without
  // a duplicate filter/flatten computation.
  const { isLoading, error, workflows } = repo;

  const state = useMemo((): WorkflowsViewState => {
    if (isLoading) return { kind: 'loading' };
    if (error) return { kind: 'error', message: error.message, onRetry: repo.refetch };
    if (!workflows) return { kind: 'loading' };

    const availableTags = getAvailableTags(workflows);
    const availableSources = getAvailableSources(workflows);
    const filteredWorkflows = filterWorkflows(
      workflows,
      interactionState.selectedTag,
      interactionState.selectedSource,
    );
    const flat = flattenWorkflows(filteredWorkflows, interactionState.selectedTag);

    return {
      kind: 'ready',
      selectedWorkflowId: interactionState.selectedWorkflowId,
      selectedTag: interactionState.selectedTag,
      selectedSource: interactionState.selectedSource,
      hintVisible: interactionState.hintVisible,
      availableTags,
      availableSources,
      filteredWorkflows,
      flatWorkflows: flat,
    };
  }, [
    isLoading,
    error,
    workflows,
    interactionState,
    repo.refetch,
  ]);

  // Hint auto-dismiss: show hint briefly when modal opens with multiple workflows.
  // Reads flatWorkflows.length from the already-computed state rather than
  // duplicating the filter/flatten pipeline.
  // Cleanup cancels the timer if the modal closes before 3s to prevent a stale
  // dispatch from hiding the hint on the next open.
  const flatWorkflowsLength = state.kind === 'ready' ? state.flatWorkflows.length : 0;
  useEffect(() => {
    if (!interactionState.selectedWorkflowId || flatWorkflowsLength <= 1) return;
    const id = setTimeout(() => dispatch({ type: 'hint_dismissed' }), 3000);
    return () => clearTimeout(id);
  }, [interactionState.selectedWorkflowId, flatWorkflowsLength]);

  // Wrap dispatch to intercept tag_changed events and call onSelectTag for URL sync.
  const wrappedDispatch = useCallback(
    (event: WorkflowsEvent) => {
      if (event.type === 'tag_changed') {
        onSelectTag(event.tag);
      }
      dispatch(event);
    },
    [onSelectTag],
  );

  return { state, dispatch: wrappedDispatch, triggerRef, onCardSelect };
}
