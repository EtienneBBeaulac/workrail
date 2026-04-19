/**
 * Unit tests for session-list-reducer.ts.
 *
 * Covers view_mode_changed behavior, which has non-trivial field-clearing
 * semantics: switching to tree clears rawSearch, statusFilter, and page;
 * switching to flat only resets page.
 */
import { describe, it, expect } from 'vitest';
import { sessionListReducer, createInitialSessionListState } from './session-list-reducer';

describe('sessionListReducer -- view_mode_changed', () => {
  it('switching to tree clears rawSearch, statusFilter, and page', () => {
    const state = {
      ...createInitialSessionListState(),
      rawSearch: 'my-branch',
      statusFilter: 'in_progress' as const,
      page: 3,
    };
    const next = sessionListReducer(state, { type: 'view_mode_changed', viewMode: 'tree' });
    expect(next.viewMode).toBe('tree');
    expect(next.rawSearch).toBe('');
    expect(next.statusFilter).toBe('all');
    expect(next.page).toBe(0);
  });

  it('switching to flat only resets page, preserving rawSearch, sort, and groupBy', () => {
    const state = {
      ...createInitialSessionListState(),
      rawSearch: 'my-branch',
      sort: 'status' as const,
      groupBy: 'workflow' as const,
      page: 2,
      viewMode: 'tree' as const,
    };
    const next = sessionListReducer(state, { type: 'view_mode_changed', viewMode: 'flat' });
    expect(next.viewMode).toBe('flat');
    expect(next.page).toBe(0);
    // These fields must be preserved -- flat mode does not clear them.
    expect(next.rawSearch).toBe('my-branch');
    expect(next.sort).toBe('status');
    expect(next.groupBy).toBe('workflow');
  });

  it('other events do not change viewMode', () => {
    const state = { ...createInitialSessionListState(), viewMode: 'tree' as const };
    const next = sessionListReducer(state, { type: 'search_changed', value: 'foo' });
    expect(next.viewMode).toBe('tree');
  });
});
