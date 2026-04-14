/**
 * Integration tests for useWorkspaceViewModel.
 *
 * Uses renderHook with vi.mock to inject fake repository data.
 * Tests state transitions, derived state correctness, and side effects.
 *
 * Pattern: fake repository data → renderHook → assert WorkspaceViewState.
 * No mocking of internal implementation details -- only the repository boundary.
 */
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useWorkspaceViewModel } from '../useWorkspaceViewModel';

// ---------------------------------------------------------------------------
// Fake repository data
// ---------------------------------------------------------------------------

const FAKE_REPO_LOADING = {
  sessions: undefined,
  worktreeRepos: [],
  isLoading: true,
  error: null,
  refetch: vi.fn(),
  worktreesFetching: false,
  liveCount: 0,
  blockedCount: 0,
};

const FAKE_REPO_ERROR = {
  sessions: undefined,
  worktreeRepos: [],
  isLoading: false,
  error: new Error('Network failure'),
  refetch: vi.fn(),
  worktreesFetching: false,
  liveCount: 0,
  blockedCount: 0,
};

const FAKE_REPO_READY = {
  sessions: [
    {
      sessionId: 'sess-001',
      sessionTitle: 'Fix auth bug',
      workflowId: 'wf-coding',
      workflowName: 'Coding Task',
      workflowHash: null,
      runId: null,
      status: 'in_progress' as const,
      health: 'healthy' as const,
      nodeCount: 3,
      edgeCount: 2,
      tipCount: 1,
      hasUnresolvedGaps: false,
      recapSnippet: null,
      gitBranch: 'feature/auth-fix',
      repoRoot: '/repos/myapp',
      lastModifiedMs: Date.now() - 1000,
    },
  ],
  worktreeRepos: [
    {
      repoName: 'myapp',
      repoRoot: '/repos/myapp',
      worktrees: [
        {
          path: '/repos/myapp',
          name: 'feature/auth-fix',
          branch: 'feature/auth-fix',
          headHash: 'abc123',
          headMessage: 'fix: auth',
          headTimestampMs: Date.now() - 1000,
          changedCount: 2,
          changedFiles: [],
          aheadCount: 0,
          unpushedCommits: [],
          isMerged: false,
          activeSessionCount: 1,
          enrichment: null,
        },
      ],
    },
  ],
  isLoading: false,
  error: null,
  refetch: vi.fn(),
  worktreesFetching: false,
  liveCount: 1,
  blockedCount: 0,
};

// ---------------------------------------------------------------------------
// Mock repository + navigation
// ---------------------------------------------------------------------------

vi.mock('../useWorkspaceRepository', () => ({
  useWorkspaceRepository: vi.fn(() => FAKE_REPO_LOADING),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));

import { useWorkspaceRepository } from '../useWorkspaceRepository';
const mockUseRepo = vi.mocked(useWorkspaceRepository);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useWorkspaceViewModel', () => {
  beforeEach(() => {
    mockUseRepo.mockReturnValue(FAKE_REPO_LOADING);
  });

  describe('state transitions', () => {
    it('returns loading state when repository is loading', () => {
      mockUseRepo.mockReturnValue(FAKE_REPO_LOADING);
      const { result } = renderHook(() => useWorkspaceViewModel());
      expect(result.current.state.kind).toBe('loading');
    });

    it('returns error state when repository has an error', () => {
      mockUseRepo.mockReturnValue(FAKE_REPO_ERROR);
      const { result } = renderHook(() => useWorkspaceViewModel());
      expect(result.current.state.kind).toBe('error');
      if (result.current.state.kind === 'error') {
        expect(result.current.state.message).toBe('Network failure');
      }
    });

    it('returns ready state with derived data when repository has sessions', () => {
      mockUseRepo.mockReturnValue(FAKE_REPO_READY);
      const { result } = renderHook(() => useWorkspaceViewModel());
      expect(result.current.state.kind).toBe('ready');
    });

    it('ready state includes liveCount and blockedCount from repository', () => {
      mockUseRepo.mockReturnValue({ ...FAKE_REPO_READY, liveCount: 2, blockedCount: 1 });
      const { result } = renderHook(() => useWorkspaceViewModel());
      if (result.current.state.kind === 'ready') {
        expect(result.current.state.liveCount).toBe(2);
        expect(result.current.state.blockedCount).toBe(1);
      }
    });

    it('ready state has hasAnySessions true when sessions exist', () => {
      mockUseRepo.mockReturnValue(FAKE_REPO_READY);
      const { result } = renderHook(() => useWorkspaceViewModel());
      if (result.current.state.kind === 'ready') {
        expect(result.current.state.hasAnySessions).toBe(true);
      }
    });

    it('ready state has hasAnySessions false when sessions list is empty', () => {
      mockUseRepo.mockReturnValue({ ...FAKE_REPO_READY, sessions: [] });
      const { result } = renderHook(() => useWorkspaceViewModel());
      if (result.current.state.kind === 'ready') {
        expect(result.current.state.hasAnySessions).toBe(false);
      }
    });
  });

  describe('scope interaction', () => {
    it('initial scope is active', () => {
      mockUseRepo.mockReturnValue(FAKE_REPO_READY);
      const { result } = renderHook(() => useWorkspaceViewModel());
      if (result.current.state.kind === 'ready') {
        expect(result.current.state.scope).toBe('active');
      }
    });

    it('scope_changed event updates scope', () => {
      mockUseRepo.mockReturnValue(FAKE_REPO_READY);
      const { result } = renderHook(() => useWorkspaceViewModel());

      act(() => {
        result.current.dispatch({ type: 'scope_changed', scope: 'all' });
      });

      if (result.current.state.kind === 'ready') {
        expect(result.current.state.scope).toBe('all');
      }
    });

    it('scope_changed resets focusedIndex to -1', () => {
      mockUseRepo.mockReturnValue(FAKE_REPO_READY);
      const { result } = renderHook(() => useWorkspaceViewModel());

      // First focus an item
      act(() => {
        result.current.dispatch({ type: 'focus_moved', index: 0 });
      });
      if (result.current.state.kind === 'ready') {
        expect(result.current.state.focusedIndex).toBe(0);
      }

      // Then change scope -- focus should reset
      act(() => {
        result.current.dispatch({ type: 'scope_changed', scope: 'all' });
      });
      if (result.current.state.kind === 'ready') {
        expect(result.current.state.focusedIndex).toBe(-1);
      }
    });
  });

  describe('archive panel', () => {
    it('archive is null initially', () => {
      mockUseRepo.mockReturnValue(FAKE_REPO_READY);
      const { result } = renderHook(() => useWorkspaceViewModel());
      if (result.current.state.kind === 'ready') {
        expect(result.current.state.archive).toBeNull();
      }
    });

    it('archive_opened event sets archive state', () => {
      mockUseRepo.mockReturnValue(FAKE_REPO_READY);
      const { result } = renderHook(() => useWorkspaceViewModel());

      act(() => {
        result.current.dispatch({ type: 'archive_opened', repoName: 'myapp' });
      });

      if (result.current.state.kind === 'ready') {
        expect(result.current.state.archive).toEqual({ repoName: 'myapp' });
      }
    });

    it('archive_closed event clears archive state', () => {
      mockUseRepo.mockReturnValue(FAKE_REPO_READY);
      const { result } = renderHook(() => useWorkspaceViewModel());

      act(() => {
        result.current.dispatch({ type: 'archive_opened', repoName: 'myapp' });
        result.current.dispatch({ type: 'archive_closed' });
      });

      if (result.current.state.kind === 'ready') {
        expect(result.current.state.archive).toBeNull();
      }
    });
  });

  describe('disabled prop', () => {
    it('returns correct state regardless of disabled prop', () => {
      mockUseRepo.mockReturnValue(FAKE_REPO_READY);
      const { result } = renderHook(() => useWorkspaceViewModel(true));
      expect(result.current.state.kind).toBe('ready');
    });
  });
});
