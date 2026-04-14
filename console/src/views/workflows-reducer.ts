/**
 * Pure reducer for workflows UI interaction state.
 *
 * Manages only user-driven interaction state: selected workflow (inline modal),
 * tag filter, source filter, and keyboard hint visibility. Loading and error
 * state come from the repository layer and are composed into WorkflowsViewState
 * by the ViewModel hook -- they do not live here.
 *
 * No React imports. Pure function: same inputs always produce the same output.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface WorkflowsInteractionState {
  readonly selectedWorkflowId: string | null;
  readonly selectedTag: string | null;
  readonly selectedSource: string | null;
  /**
   * True briefly when the modal opens with multiple workflows available,
   * to show the keyboard navigation hint. Dismissed after 3s via ViewModel.
   */
  readonly hintVisible: boolean;
}

export const INITIAL_WORKFLOWS_STATE: WorkflowsInteractionState = {
  selectedWorkflowId: null,
  selectedTag: null,
  selectedSource: null,
  hintVisible: false,
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type WorkflowsEvent =
  | { readonly type: 'workflow_selected'; readonly id: string | null }
  | { readonly type: 'tag_changed'; readonly tag: string | null }
  | { readonly type: 'source_changed'; readonly source: string | null }
  | { readonly type: 'modal_closed' }
  | { readonly type: 'hint_dismissed' };

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function assertNever(value: never): never {
  throw new Error(`Unhandled WorkflowsEvent type: ${String((value as { type: string }).type)}`);
}

/**
 * Pure workflows reducer. Handles UI interaction events only.
 *
 * Invariants:
 * - selectedWorkflowId === null means the inline modal is closed.
 * - hintVisible is set to true when a workflow is selected (non-null id) and
 *   reset to false on modal close. The 3s auto-dismiss is handled in the
 *   ViewModel via a useEffect, not here.
 * - tag_changed and source_changed clear selectedWorkflowId because navigating
 *   away from the current filter invalidates the current modal context.
 */
export function workflowsReducer(
  state: WorkflowsInteractionState,
  event: WorkflowsEvent,
): WorkflowsInteractionState {
  switch (event.type) {
    case 'workflow_selected':
      return {
        ...state,
        selectedWorkflowId: event.id,
        // Show the nav hint when a workflow opens; hide it when the modal closes.
        hintVisible: event.id !== null,
      };

    case 'tag_changed':
      // Clear selected workflow -- the current modal is no longer valid after
      // the filter changes.
      return { ...state, selectedTag: event.tag, selectedWorkflowId: null, hintVisible: false };

    case 'source_changed':
      return { ...state, selectedSource: event.source, selectedWorkflowId: null, hintVisible: false };

    case 'modal_closed':
      return { ...state, selectedWorkflowId: null, hintVisible: false };

    case 'hint_dismissed':
      return { ...state, hintVisible: false };

    default:
      return assertNever(event);
  }
}
