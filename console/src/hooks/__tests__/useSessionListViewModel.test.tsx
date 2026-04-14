/**
 * Integration tests for useSessionListViewModel.
 *
 * Tests state transitions, filtering, sorting, pagination, and
 * page reset invariant (any filter change resets page to 0).
 */
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSessionListViewModel } from '../useSessionListViewModel';
import type { ConsoleSessionSummary } from '../../api/types';

// ---------------------------------------------------------------------------
// Fake data
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<ConsoleSessionSummary> = {}): ConsoleSessionSummary {
  return {
    sessionId: `sess-${Math.random().toString(36).slice(2, 8)}`,
    sessionTitle: 'Test session',
    workflowId: 'wf-coding',
    workflowName: 'Coding Task',
    workflowHash: null,
    runId: null,
    status: 'complete',
    health: 'healthy',
    nodeCount: 3,
    edgeCount: 2,
    tipCount: 1,
    hasUnresolvedGaps: false,
    recapSnippet: null,
    gitBranch: 'main',
    repoRoot: '/repos/myapp',
    lastModifiedMs: Date.now(),
    ...overrides,
  };
}

const SESSIONS = [
  makeSession({ sessionId: 'sess-001', sessionTitle: 'Fix auth bug', status: 'in_progress' }),
  makeSession({ sessionId: 'sess-002', sessionTitle: 'Add dark mode', status: 'complete' }),
  makeSession({ sessionId: 'sess-003', sessionTitle: 'Write tests', status: 'blocked' }),
];

// ---------------------------------------------------------------------------
// Mock repository
// ---------------------------------------------------------------------------

vi.mock('../useSessionListRepository', () => ({
  useSessionListRepository: vi.fn(() => ({
    sessions: SESSIONS,
    isLoading: false,
    error: null,
  })),
}));

import { useSessionListRepository } from '../useSessionListRepository';
const mockUseRepo = vi.mocked(useSessionListRepository);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useSessionListViewModel', () => {
  const onSelectSession = vi.fn();

  beforeEach(() => {
    mockUseRepo.mockReturnValue({ sessions: SESSIONS, isLoading: false, error: null });
    onSelectSession.mockReset();
  });

  describe('state transitions', () => {
    it('returns loading when repository is loading', () => {
      mockUseRepo.mockReturnValue({ sessions: undefined, isLoading: true, error: null });
      const { result } = renderHook(() => useSessionListViewModel({ onSelectSession }));
      expect(result.current.state.kind).toBe('loading');
    });

    it('returns error when repository has an error', () => {
      mockUseRepo.mockReturnValue({ sessions: undefined, isLoading: false, error: new Error('fail') });
      const { result } = renderHook(() => useSessionListViewModel({ onSelectSession }));
      expect(result.current.state.kind).toBe('error');
    });

    it('returns ready with sessions when data is available', () => {
      const { result } = renderHook(() => useSessionListViewModel({ onSelectSession }));
      expect(result.current.state.kind).toBe('ready');
      if (result.current.state.kind === 'ready') {
        expect(result.current.state.flatPageSessions.length).toBeGreaterThan(0);
      }
    });
  });

  describe('status filter', () => {
    it('processed.total reflects the count of filtered sessions', () => {
      const { result } = renderHook(() => useSessionListViewModel({ onSelectSession }));
      if (result.current.state.kind === 'ready') {
        expect(result.current.state.processed.total).toBe(3);
      }
    });

    it('status_changed filters sessions and resets page to 0', () => {
      const { result } = renderHook(() => useSessionListViewModel({ onSelectSession }));

      // Navigate to page 1 first
      act(() => { result.current.dispatch({ type: 'page_changed', page: 1 }); });
      if (result.current.state.kind === 'ready') {
        expect(result.current.state.page).toBe(1);
      }

      // Change filter -- page must reset
      act(() => { result.current.dispatch({ type: 'status_changed', statusFilter: 'in_progress' }); });
      if (result.current.state.kind === 'ready') {
        expect(result.current.state.page).toBe(0);
        expect(result.current.state.statusFilter).toBe('in_progress');
        // Only in_progress sessions visible
        const ids = result.current.state.flatPageSessions.map(s => s.sessionId);
        expect(ids).toContain('sess-001');
        expect(ids).not.toContain('sess-002');
      }
    });
  });

  describe('search', () => {
    it('search_changed updates rawSearch and resets page', () => {
      const { result } = renderHook(() => useSessionListViewModel({ onSelectSession }));

      act(() => { result.current.dispatch({ type: 'page_changed', page: 1 }); });
      act(() => { result.current.dispatch({ type: 'search_changed', value: 'auth' }); });

      if (result.current.state.kind === 'ready') {
        expect(result.current.state.page).toBe(0);
        expect(result.current.state.rawSearch).toBe('auth');
      }
    });
  });

  describe('sort', () => {
    it('sort_changed updates sort field and resets page', () => {
      const { result } = renderHook(() => useSessionListViewModel({ onSelectSession }));

      act(() => { result.current.dispatch({ type: 'page_changed', page: 1 }); });
      act(() => { result.current.dispatch({ type: 'sort_changed', sort: 'status' }); });

      if (result.current.state.kind === 'ready') {
        expect(result.current.state.page).toBe(0);
        expect(result.current.state.sort).toBe('status');
      }
    });
  });

  describe('page invariant', () => {
    it('page_changed updates page without resetting filter state', () => {
      const { result } = renderHook(() => useSessionListViewModel({ onSelectSession }));

      act(() => { result.current.dispatch({ type: 'status_changed', statusFilter: 'complete' }); });
      act(() => { result.current.dispatch({ type: 'page_changed', page: 2 }); });

      if (result.current.state.kind === 'ready') {
        expect(result.current.state.page).toBe(2);
        expect(result.current.state.statusFilter).toBe('complete');
      }
    });
  });
});
