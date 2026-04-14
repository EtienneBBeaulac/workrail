/**
 * Unit tests for workspaceReducer.
 *
 * Pure function tests -- no DOM, no React, no mocks.
 * Pattern follows perf-state.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  workspaceReducer,
  INITIAL_WORKSPACE_STATE,
  type WorkspaceInteractionState,
  type WorkspaceEvent,
} from '../../console/src/views/workspace-reducer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function reduce(
  state: WorkspaceInteractionState,
  event: WorkspaceEvent,
): WorkspaceInteractionState {
  return workspaceReducer(state, event);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('workspaceReducer', () => {
  describe('initial state', () => {
    it('has scope active, focusedIndex -1, archive null', () => {
      expect(INITIAL_WORKSPACE_STATE).toEqual({
        scope: 'active',
        focusedIndex: -1,
        archive: null,
      });
    });
  });

  describe('scope_changed', () => {
    it('updates scope to all', () => {
      const next = reduce(INITIAL_WORKSPACE_STATE, {
        type: 'scope_changed',
        scope: 'all',
      });
      expect(next.scope).toBe('all');
    });

    it('updates scope back to active', () => {
      const state: WorkspaceInteractionState = { ...INITIAL_WORKSPACE_STATE, scope: 'all' };
      const next = reduce(state, { type: 'scope_changed', scope: 'active' });
      expect(next.scope).toBe('active');
    });

    it('resets focusedIndex to -1 (item list reorders on scope change)', () => {
      const state: WorkspaceInteractionState = {
        scope: 'active',
        focusedIndex: 3,
        archive: { repoName: 'myrepo' },
      };
      const next = reduce(state, { type: 'scope_changed', scope: 'all' });
      expect(next.focusedIndex).toBe(-1);
    });

    it('preserves archive state on scope change', () => {
      const state: WorkspaceInteractionState = {
        scope: 'active',
        focusedIndex: 3,
        archive: { repoName: 'myrepo' },
      };
      const next = reduce(state, { type: 'scope_changed', scope: 'all' });
      expect(next.archive).toEqual({ repoName: 'myrepo' });
    });
  });

  describe('focus_moved', () => {
    it('updates focusedIndex', () => {
      const next = reduce(INITIAL_WORKSPACE_STATE, { type: 'focus_moved', index: 5 });
      expect(next.focusedIndex).toBe(5);
    });

    it('can reset focusedIndex to -1', () => {
      const state: WorkspaceInteractionState = { ...INITIAL_WORKSPACE_STATE, focusedIndex: 3 };
      const next = reduce(state, { type: 'focus_moved', index: -1 });
      expect(next.focusedIndex).toBe(-1);
    });

    it('does not mutate other fields', () => {
      const state: WorkspaceInteractionState = {
        scope: 'all',
        focusedIndex: 0,
        archive: null,
      };
      const next = reduce(state, { type: 'focus_moved', index: 2 });
      expect(next.scope).toBe('all');
      expect(next.archive).toBeNull();
    });
  });

  describe('archive_opened', () => {
    it('sets archive with a repoName', () => {
      const next = reduce(INITIAL_WORKSPACE_STATE, {
        type: 'archive_opened',
        repoName: 'zillow-android',
      });
      expect(next.archive).toEqual({ repoName: 'zillow-android' });
    });

    it('sets archive with undefined repoName (global archive)', () => {
      const next = reduce(INITIAL_WORKSPACE_STATE, {
        type: 'archive_opened',
        repoName: undefined,
      });
      expect(next.archive).toEqual({ repoName: undefined });
    });

    it('does not mutate other fields', () => {
      const state: WorkspaceInteractionState = {
        scope: 'all',
        focusedIndex: 2,
        archive: null,
      };
      const next = reduce(state, { type: 'archive_opened', repoName: 'repo' });
      expect(next.scope).toBe('all');
      expect(next.focusedIndex).toBe(2);
    });
  });

  describe('archive_closed', () => {
    it('sets archive to null', () => {
      const state: WorkspaceInteractionState = {
        ...INITIAL_WORKSPACE_STATE,
        archive: { repoName: 'myrepo' },
      };
      const next = reduce(state, { type: 'archive_closed' });
      expect(next.archive).toBeNull();
    });

    it('is a no-op when archive is already null', () => {
      const next = reduce(INITIAL_WORKSPACE_STATE, { type: 'archive_closed' });
      expect(next.archive).toBeNull();
    });

    it('does not mutate other fields', () => {
      const state: WorkspaceInteractionState = {
        scope: 'all',
        focusedIndex: 4,
        archive: { repoName: 'repo' },
      };
      const next = reduce(state, { type: 'archive_closed' });
      expect(next.scope).toBe('all');
      expect(next.focusedIndex).toBe(4);
    });
  });

  describe('immutability', () => {
    it('does not mutate the input state', () => {
      const state: WorkspaceInteractionState = {
        scope: 'active',
        focusedIndex: 0,
        archive: null,
      };
      const frozen = Object.freeze(state);
      // Should not throw even though input is frozen
      expect(() =>
        reduce(frozen, { type: 'scope_changed', scope: 'all' }),
      ).not.toThrow();
    });
  });
});
