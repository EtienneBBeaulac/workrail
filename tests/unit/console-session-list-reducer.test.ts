/**
 * Unit tests for sessionListReducer.
 *
 * Pure function tests -- no DOM, no React, no mocks.
 * Pattern follows console-workspace-reducer.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  sessionListReducer,
  createInitialSessionListState,
  type SessionListInteractionState,
  type SessionListEvent,
} from '../../console/src/views/session-list-reducer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function reduce(
  state: SessionListInteractionState,
  event: SessionListEvent,
): SessionListInteractionState {
  return sessionListReducer(state, event);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sessionListReducer', () => {
  describe('createInitialSessionListState', () => {
    it('has correct default values with no args', () => {
      expect(createInitialSessionListState()).toEqual({
        rawSearch: '',
        sort: 'recent',
        groupBy: 'none',
        statusFilter: 'all',
        page: 0,
      });
    });

    it('seeds rawSearch from initialSearch arg', () => {
      const state = createInitialSessionListState('feature/my-branch');
      expect(state.rawSearch).toBe('feature/my-branch');
    });

    it('other fields are defaults when initialSearch is provided', () => {
      const state = createInitialSessionListState('foo');
      expect(state.sort).toBe('recent');
      expect(state.groupBy).toBe('none');
      expect(state.statusFilter).toBe('all');
      expect(state.page).toBe(0);
    });
  });

  describe('search_changed', () => {
    it('sets rawSearch', () => {
      const state = createInitialSessionListState();
      const next = reduce(state, { type: 'search_changed', value: 'hello' });
      expect(next.rawSearch).toBe('hello');
    });

    it('resets page to 0', () => {
      const state: SessionListInteractionState = { ...createInitialSessionListState(), page: 3 };
      const next = reduce(state, { type: 'search_changed', value: 'hello' });
      expect(next.page).toBe(0);
    });

    it('does not mutate other fields', () => {
      const state: SessionListInteractionState = {
        ...createInitialSessionListState(),
        sort: 'status',
        groupBy: 'workflow',
        statusFilter: 'in_progress',
        page: 2,
      };
      const next = reduce(state, { type: 'search_changed', value: 'test' });
      expect(next.sort).toBe('status');
      expect(next.groupBy).toBe('workflow');
      expect(next.statusFilter).toBe('in_progress');
    });

    it('can clear search by setting empty string', () => {
      const state: SessionListInteractionState = { ...createInitialSessionListState(), rawSearch: 'foo' };
      const next = reduce(state, { type: 'search_changed', value: '' });
      expect(next.rawSearch).toBe('');
    });
  });

  describe('sort_changed', () => {
    it('sets sort', () => {
      const state = createInitialSessionListState();
      const next = reduce(state, { type: 'sort_changed', sort: 'status' });
      expect(next.sort).toBe('status');
    });

    it('resets page to 0', () => {
      const state: SessionListInteractionState = { ...createInitialSessionListState(), page: 2 };
      const next = reduce(state, { type: 'sort_changed', sort: 'workflow' });
      expect(next.page).toBe(0);
    });

    it('does not mutate rawSearch or groupBy or statusFilter', () => {
      const state: SessionListInteractionState = {
        ...createInitialSessionListState(),
        rawSearch: 'foo',
        groupBy: 'status',
        statusFilter: 'blocked',
      };
      const next = reduce(state, { type: 'sort_changed', sort: 'nodes' });
      expect(next.rawSearch).toBe('foo');
      expect(next.groupBy).toBe('status');
      expect(next.statusFilter).toBe('blocked');
    });
  });

  describe('group_changed', () => {
    it('sets groupBy', () => {
      const state = createInitialSessionListState();
      const next = reduce(state, { type: 'group_changed', groupBy: 'workflow' });
      expect(next.groupBy).toBe('workflow');
    });

    it('resets page to 0', () => {
      const state: SessionListInteractionState = { ...createInitialSessionListState(), page: 5 };
      const next = reduce(state, { type: 'group_changed', groupBy: 'branch' });
      expect(next.page).toBe(0);
    });

    it('does not mutate rawSearch or sort or statusFilter', () => {
      const state: SessionListInteractionState = {
        ...createInitialSessionListState(),
        rawSearch: 'bar',
        sort: 'workflow',
        statusFilter: 'complete',
      };
      const next = reduce(state, { type: 'group_changed', groupBy: 'status' });
      expect(next.rawSearch).toBe('bar');
      expect(next.sort).toBe('workflow');
      expect(next.statusFilter).toBe('complete');
    });
  });

  describe('status_changed', () => {
    it('sets statusFilter', () => {
      const state = createInitialSessionListState();
      const next = reduce(state, { type: 'status_changed', statusFilter: 'in_progress' });
      expect(next.statusFilter).toBe('in_progress');
    });

    it('resets page to 0', () => {
      const state: SessionListInteractionState = { ...createInitialSessionListState(), page: 4 };
      const next = reduce(state, { type: 'status_changed', statusFilter: 'blocked' });
      expect(next.page).toBe(0);
    });

    it('can set statusFilter back to all', () => {
      const state: SessionListInteractionState = {
        ...createInitialSessionListState(),
        statusFilter: 'complete',
      };
      const next = reduce(state, { type: 'status_changed', statusFilter: 'all' });
      expect(next.statusFilter).toBe('all');
    });

    it('does not mutate rawSearch or sort or groupBy', () => {
      const state: SessionListInteractionState = {
        ...createInitialSessionListState(),
        rawSearch: 'baz',
        sort: 'nodes',
        groupBy: 'branch',
      };
      const next = reduce(state, { type: 'status_changed', statusFilter: 'dormant' });
      expect(next.rawSearch).toBe('baz');
      expect(next.sort).toBe('nodes');
      expect(next.groupBy).toBe('branch');
    });
  });

  describe('page_changed', () => {
    it('sets page', () => {
      const state = createInitialSessionListState();
      const next = reduce(state, { type: 'page_changed', page: 3 });
      expect(next.page).toBe(3);
    });

    it('does NOT reset rawSearch, sort, groupBy, or statusFilter', () => {
      const state: SessionListInteractionState = {
        rawSearch: 'foo',
        sort: 'status',
        groupBy: 'workflow',
        statusFilter: 'in_progress',
        page: 0,
      };
      const next = reduce(state, { type: 'page_changed', page: 5 });
      expect(next.rawSearch).toBe('foo');
      expect(next.sort).toBe('status');
      expect(next.groupBy).toBe('workflow');
      expect(next.statusFilter).toBe('in_progress');
    });

    it('can page back to 0', () => {
      const state: SessionListInteractionState = { ...createInitialSessionListState(), page: 3 };
      const next = reduce(state, { type: 'page_changed', page: 0 });
      expect(next.page).toBe(0);
    });
  });

  describe('page reset invariant', () => {
    it('search_changed resets page even when page is already 0', () => {
      const state = createInitialSessionListState();
      const next = reduce(state, { type: 'search_changed', value: 'x' });
      expect(next.page).toBe(0);
    });

    it('sort_changed resets page', () => {
      const state: SessionListInteractionState = { ...createInitialSessionListState(), page: 10 };
      const next = reduce(state, { type: 'sort_changed', sort: 'workflow' });
      expect(next.page).toBe(0);
    });

    it('group_changed resets page', () => {
      const state: SessionListInteractionState = { ...createInitialSessionListState(), page: 10 };
      const next = reduce(state, { type: 'group_changed', groupBy: 'status' });
      expect(next.page).toBe(0);
    });

    it('status_changed resets page', () => {
      const state: SessionListInteractionState = { ...createInitialSessionListState(), page: 10 };
      const next = reduce(state, { type: 'status_changed', statusFilter: 'complete' });
      expect(next.page).toBe(0);
    });

    it('page_changed is the ONLY event that does not reset page to 0', () => {
      const state: SessionListInteractionState = { ...createInitialSessionListState(), page: 3 };
      const next = reduce(state, { type: 'page_changed', page: 7 });
      expect(next.page).toBe(7);
    });
  });

  describe('immutability', () => {
    it('does not mutate the input state on search_changed', () => {
      const state = Object.freeze(createInitialSessionListState());
      expect(() => reduce(state, { type: 'search_changed', value: 'test' })).not.toThrow();
    });

    it('does not mutate the input state on sort_changed', () => {
      const state = Object.freeze(createInitialSessionListState());
      expect(() => reduce(state, { type: 'sort_changed', sort: 'status' })).not.toThrow();
    });

    it('does not mutate the input state on group_changed', () => {
      const state = Object.freeze(createInitialSessionListState());
      expect(() => reduce(state, { type: 'group_changed', groupBy: 'workflow' })).not.toThrow();
    });

    it('does not mutate the input state on status_changed', () => {
      const state = Object.freeze(createInitialSessionListState());
      expect(() => reduce(state, { type: 'status_changed', statusFilter: 'blocked' })).not.toThrow();
    });

    it('does not mutate the input state on page_changed', () => {
      const state = Object.freeze(createInitialSessionListState());
      expect(() => reduce(state, { type: 'page_changed', page: 2 })).not.toThrow();
    });
  });

  describe('assertNever exhaustiveness', () => {
    it('throws on unknown event type', () => {
      const state = createInitialSessionListState();
      const unknownEvent = { type: 'unknown_event_type' } as unknown as SessionListEvent;
      expect(() => reduce(state, unknownEvent)).toThrow('Unhandled SessionListEvent type: unknown_event_type');
    });
  });
});
