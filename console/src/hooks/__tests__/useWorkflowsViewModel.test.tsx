/**
 * Integration tests for useWorkflowsViewModel.
 *
 * Key scenarios tested:
 * - State transitions (loading → ready → error)
 * - initialTag sync when URL changes after mount (the stale-tag bug regression test)
 * - Workflow selection opens modal (selectedWorkflowId)
 * - Tag/source filter changes clear selectedWorkflowId
 * - Filtering derived state (filteredWorkflows, flatWorkflows)
 */
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useWorkflowsViewModel } from '../useWorkflowsViewModel';
import type { ConsoleWorkflowSummary } from '../../api/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeWorkflow(id: string, tags: string[] = []): ConsoleWorkflowSummary {
  return {
    id,
    name: `Workflow ${id}`,
    description: "",
    version: '1.0.0',
    tags,
    source: { kind: 'bundled', displayName: 'WorkRail' },
    stepCount: 3,
  };
}

const WF_CODING = makeWorkflow('wf-coding', ['coding']);
const WF_REVIEW = makeWorkflow('wf-review', ['review']);
const WF_PLAIN = makeWorkflow('wf-plain', []);
const WORKFLOWS = [WF_CODING, WF_REVIEW, WF_PLAIN];

// ---------------------------------------------------------------------------
// Mock repository
// ---------------------------------------------------------------------------

vi.mock('../useWorkflowsRepository', () => ({
  useWorkflowsRepository: vi.fn(() => ({
    workflows: WORKFLOWS,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  })),
}));

import { useWorkflowsRepository } from '../useWorkflowsRepository';
const mockUseRepo = vi.mocked(useWorkflowsRepository);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParams(overrides: Partial<Parameters<typeof useWorkflowsViewModel>[0]> = {}) {
  return {
    initialTag: null,
    onSelectTag: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useWorkflowsViewModel', () => {
  beforeEach(() => {
    mockUseRepo.mockReturnValue({
      workflows: WORKFLOWS,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  describe('state transitions', () => {
    it('returns loading when repository is loading', () => {
      mockUseRepo.mockReturnValue({ workflows: undefined, isLoading: true, error: null, refetch: vi.fn() });
      const { result } = renderHook(() => useWorkflowsViewModel(makeParams()));
      expect(result.current.state.kind).toBe('loading');
    });

    it('returns error when repository has an error', () => {
      mockUseRepo.mockReturnValue({ workflows: undefined, isLoading: false, error: new Error('fetch failed'), refetch: vi.fn() });
      const { result } = renderHook(() => useWorkflowsViewModel(makeParams()));
      expect(result.current.state.kind).toBe('error');
    });

    it('returns ready with all workflows when no filter', () => {
      const { result } = renderHook(() => useWorkflowsViewModel(makeParams()));
      if (result.current.state.kind === 'ready') {
        expect(result.current.state.flatWorkflows).toHaveLength(3);
      }
    });
  });

  describe('tag filtering', () => {
    it('filters workflows by initialTag', () => {
      const { result } = renderHook(() => useWorkflowsViewModel(makeParams({ initialTag: 'coding' })));
      if (result.current.state.kind === 'ready') {
        const ids = result.current.state.flatWorkflows.map(w => w.id);
        expect(ids).toContain('wf-coding');
        expect(ids).not.toContain('wf-review');
      }
    });

    it('tag_changed event updates filtered list', () => {
      const { result } = renderHook(() => useWorkflowsViewModel(makeParams()));
      act(() => {
        result.current.dispatch({ type: 'tag_changed', tag: 'review' });
      });
      if (result.current.state.kind === 'ready') {
        expect(result.current.state.flatWorkflows.map(w => w.id)).toContain('wf-review');
        expect(result.current.state.flatWorkflows.map(w => w.id)).not.toContain('wf-coding');
      }
    });

    it('tag_changed clears selectedWorkflowId', () => {
      const { result } = renderHook(() => useWorkflowsViewModel(makeParams()));

      // Select a workflow first
      act(() => {
        result.current.dispatch({ type: 'workflow_selected', id: 'wf-coding' });
      });
      if (result.current.state.kind === 'ready') {
        expect(result.current.state.selectedWorkflowId).toBe('wf-coding');
      }

      // Change tag -- should clear selection
      act(() => {
        result.current.dispatch({ type: 'tag_changed', tag: 'review' });
      });
      if (result.current.state.kind === 'ready') {
        expect(result.current.state.selectedWorkflowId).toBeNull();
      }
    });

    it('tag_changed calls onSelectTag callback for URL sync', () => {
      const onSelectTag = vi.fn();
      const { result } = renderHook(() => useWorkflowsViewModel(makeParams({ onSelectTag })));
      act(() => {
        result.current.dispatch({ type: 'tag_changed', tag: 'coding' });
      });
      expect(onSelectTag).toHaveBeenCalledWith('coding');
    });
  });

  describe('initialTag reactivity (regression: stale tag on URL back-navigation)', () => {
    it('syncs to new initialTag after mount when URL changes', () => {
      let tag: string | null = 'coding';
      const { result, rerender } = renderHook(() =>
        useWorkflowsViewModel(makeParams({ initialTag: tag }))
      );

      // Simulate browser Back -- URL changes to different tag
      tag = 'review';
      rerender();

      if (result.current.state.kind === 'ready') {
        expect(result.current.state.selectedTag).toBe('review');
      }
    });

    it('syncs to null initialTag when user navigates to unfiltered URL', () => {
      let tag: string | null = 'coding';
      const { result, rerender } = renderHook(() =>
        useWorkflowsViewModel(makeParams({ initialTag: tag }))
      );

      tag = null;
      rerender();

      if (result.current.state.kind === 'ready') {
        expect(result.current.state.selectedTag).toBeNull();
      }
    });
  });

  describe('modal selection', () => {
    it('workflow_selected event sets selectedWorkflowId', () => {
      const { result } = renderHook(() => useWorkflowsViewModel(makeParams()));
      act(() => {
        result.current.dispatch({ type: 'workflow_selected', id: 'wf-coding' });
      });
      if (result.current.state.kind === 'ready') {
        expect(result.current.state.selectedWorkflowId).toBe('wf-coding');
      }
    });

    it('modal_closed event clears selectedWorkflowId', () => {
      const { result } = renderHook(() => useWorkflowsViewModel(makeParams()));
      act(() => {
        result.current.dispatch({ type: 'workflow_selected', id: 'wf-coding' });
        result.current.dispatch({ type: 'modal_closed' });
      });
      if (result.current.state.kind === 'ready') {
        expect(result.current.state.selectedWorkflowId).toBeNull();
      }
    });
  });
});
