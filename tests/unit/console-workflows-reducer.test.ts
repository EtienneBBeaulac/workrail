/**
 * Unit tests for workflowsReducer.
 *
 * Pure function tests -- no DOM, no React, no mocks.
 * Pattern follows console-workspace-reducer.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  workflowsReducer,
  INITIAL_WORKFLOWS_STATE,
  type WorkflowsInteractionState,
  type WorkflowsEvent,
} from '../../console/src/views/workflows-reducer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function reduce(
  state: WorkflowsInteractionState,
  event: WorkflowsEvent,
): WorkflowsInteractionState {
  return workflowsReducer(state, event);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('workflowsReducer', () => {
  describe('initial state', () => {
    it('has all fields null/false', () => {
      expect(INITIAL_WORKFLOWS_STATE).toEqual({
        selectedWorkflowId: null,
        selectedTag: null,
        selectedSource: null,
        hintVisible: false,
      });
    });
  });

  describe('workflow_selected', () => {
    it('sets selectedWorkflowId to the given id', () => {
      const next = reduce(INITIAL_WORKFLOWS_STATE, {
        type: 'workflow_selected',
        id: 'workflow-abc',
      });
      expect(next.selectedWorkflowId).toBe('workflow-abc');
    });

    it('sets hintVisible to true when a non-null id is selected', () => {
      const next = reduce(INITIAL_WORKFLOWS_STATE, {
        type: 'workflow_selected',
        id: 'workflow-abc',
      });
      expect(next.hintVisible).toBe(true);
    });

    it('sets selectedWorkflowId to null when id is null', () => {
      const state: WorkflowsInteractionState = {
        ...INITIAL_WORKFLOWS_STATE,
        selectedWorkflowId: 'workflow-abc',
        hintVisible: true,
      };
      const next = reduce(state, { type: 'workflow_selected', id: null });
      expect(next.selectedWorkflowId).toBeNull();
    });

    it('sets hintVisible to false when id is null', () => {
      const state: WorkflowsInteractionState = {
        ...INITIAL_WORKFLOWS_STATE,
        selectedWorkflowId: 'workflow-abc',
        hintVisible: true,
      };
      const next = reduce(state, { type: 'workflow_selected', id: null });
      expect(next.hintVisible).toBe(false);
    });

    it('does not mutate other fields', () => {
      const state: WorkflowsInteractionState = {
        selectedWorkflowId: null,
        selectedTag: 'coding',
        selectedSource: 'bundled',
        hintVisible: false,
      };
      const next = reduce(state, { type: 'workflow_selected', id: 'wf-1' });
      expect(next.selectedTag).toBe('coding');
      expect(next.selectedSource).toBe('bundled');
    });
  });

  describe('tag_changed', () => {
    it('sets selectedTag', () => {
      const next = reduce(INITIAL_WORKFLOWS_STATE, {
        type: 'tag_changed',
        tag: 'coding',
      });
      expect(next.selectedTag).toBe('coding');
    });

    it('clears selectedWorkflowId on tag change', () => {
      const state: WorkflowsInteractionState = {
        ...INITIAL_WORKFLOWS_STATE,
        selectedWorkflowId: 'wf-1',
      };
      const next = reduce(state, { type: 'tag_changed', tag: 'design' });
      expect(next.selectedWorkflowId).toBeNull();
    });

    it('clears hintVisible on tag change', () => {
      const state: WorkflowsInteractionState = {
        ...INITIAL_WORKFLOWS_STATE,
        hintVisible: true,
      };
      const next = reduce(state, { type: 'tag_changed', tag: 'design' });
      expect(next.hintVisible).toBe(false);
    });

    it('can set tag back to null (clear filter)', () => {
      const state: WorkflowsInteractionState = {
        ...INITIAL_WORKFLOWS_STATE,
        selectedTag: 'coding',
      };
      const next = reduce(state, { type: 'tag_changed', tag: null });
      expect(next.selectedTag).toBeNull();
    });

    it('does not mutate selectedSource', () => {
      const state: WorkflowsInteractionState = {
        ...INITIAL_WORKFLOWS_STATE,
        selectedSource: 'bundled',
      };
      const next = reduce(state, { type: 'tag_changed', tag: 'coding' });
      expect(next.selectedSource).toBe('bundled');
    });
  });

  describe('source_changed', () => {
    it('sets selectedSource', () => {
      const next = reduce(INITIAL_WORKFLOWS_STATE, {
        type: 'source_changed',
        source: 'bundled',
      });
      expect(next.selectedSource).toBe('bundled');
    });

    it('clears selectedWorkflowId on source change', () => {
      const state: WorkflowsInteractionState = {
        ...INITIAL_WORKFLOWS_STATE,
        selectedWorkflowId: 'wf-1',
      };
      const next = reduce(state, { type: 'source_changed', source: 'user' });
      expect(next.selectedWorkflowId).toBeNull();
    });

    it('clears hintVisible on source change', () => {
      const state: WorkflowsInteractionState = {
        ...INITIAL_WORKFLOWS_STATE,
        hintVisible: true,
      };
      const next = reduce(state, { type: 'source_changed', source: 'user' });
      expect(next.hintVisible).toBe(false);
    });

    it('can clear source filter by setting null', () => {
      const state: WorkflowsInteractionState = {
        ...INITIAL_WORKFLOWS_STATE,
        selectedSource: 'bundled',
      };
      const next = reduce(state, { type: 'source_changed', source: null });
      expect(next.selectedSource).toBeNull();
    });

    it('does not mutate selectedTag', () => {
      const state: WorkflowsInteractionState = {
        ...INITIAL_WORKFLOWS_STATE,
        selectedTag: 'coding',
      };
      const next = reduce(state, { type: 'source_changed', source: 'bundled' });
      expect(next.selectedTag).toBe('coding');
    });
  });

  describe('modal_closed', () => {
    it('clears selectedWorkflowId', () => {
      const state: WorkflowsInteractionState = {
        ...INITIAL_WORKFLOWS_STATE,
        selectedWorkflowId: 'wf-1',
      };
      const next = reduce(state, { type: 'modal_closed' });
      expect(next.selectedWorkflowId).toBeNull();
    });

    it('sets hintVisible to false', () => {
      const state: WorkflowsInteractionState = {
        ...INITIAL_WORKFLOWS_STATE,
        hintVisible: true,
        selectedWorkflowId: 'wf-1',
      };
      const next = reduce(state, { type: 'modal_closed' });
      expect(next.hintVisible).toBe(false);
    });

    it('is a no-op when modal is already closed', () => {
      const next = reduce(INITIAL_WORKFLOWS_STATE, { type: 'modal_closed' });
      expect(next.selectedWorkflowId).toBeNull();
      expect(next.hintVisible).toBe(false);
    });

    it('does not mutate selectedTag or selectedSource', () => {
      const state: WorkflowsInteractionState = {
        selectedWorkflowId: 'wf-1',
        selectedTag: 'coding',
        selectedSource: 'bundled',
        hintVisible: true,
      };
      const next = reduce(state, { type: 'modal_closed' });
      expect(next.selectedTag).toBe('coding');
      expect(next.selectedSource).toBe('bundled');
    });
  });

  describe('hint_dismissed', () => {
    it('sets hintVisible to false', () => {
      const state: WorkflowsInteractionState = {
        ...INITIAL_WORKFLOWS_STATE,
        hintVisible: true,
      };
      const next = reduce(state, { type: 'hint_dismissed' });
      expect(next.hintVisible).toBe(false);
    });

    it('is a no-op when hint is already hidden', () => {
      const next = reduce(INITIAL_WORKFLOWS_STATE, { type: 'hint_dismissed' });
      expect(next.hintVisible).toBe(false);
    });

    it('does not mutate other fields', () => {
      const state: WorkflowsInteractionState = {
        selectedWorkflowId: 'wf-1',
        selectedTag: 'coding',
        selectedSource: 'bundled',
        hintVisible: true,
      };
      const next = reduce(state, { type: 'hint_dismissed' });
      expect(next.selectedWorkflowId).toBe('wf-1');
      expect(next.selectedTag).toBe('coding');
      expect(next.selectedSource).toBe('bundled');
    });
  });

  describe('immutability', () => {
    it('does not mutate the input state on workflow_selected', () => {
      const state = Object.freeze({ ...INITIAL_WORKFLOWS_STATE });
      expect(() => reduce(state, { type: 'workflow_selected', id: 'wf-1' })).not.toThrow();
    });

    it('does not mutate the input state on tag_changed', () => {
      const state = Object.freeze({ ...INITIAL_WORKFLOWS_STATE });
      expect(() => reduce(state, { type: 'tag_changed', tag: 'coding' })).not.toThrow();
    });

    it('does not mutate the input state on modal_closed', () => {
      const state = Object.freeze({ ...INITIAL_WORKFLOWS_STATE, selectedWorkflowId: 'wf-1' });
      expect(() => reduce(state, { type: 'modal_closed' })).not.toThrow();
    });
  });

  describe('assertNever exhaustiveness', () => {
    it('throws on unknown event type', () => {
      const state = INITIAL_WORKFLOWS_STATE;
      const unknownEvent = { type: 'unknown_event_type' } as unknown as WorkflowsEvent;
      expect(() => reduce(state, unknownEvent)).toThrow('Unhandled WorkflowsEvent type: unknown_event_type');
    });
  });
});
