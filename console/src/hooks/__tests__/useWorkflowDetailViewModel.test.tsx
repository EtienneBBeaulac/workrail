/**
 * Integration tests for useWorkflowDetailViewModel.
 *
 * Tests state transitions, adjacent workflow navigation, and
 * the getAdjacentWorkflows use case integration.
 */
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useWorkflowDetailViewModel } from '../useWorkflowDetailViewModel';
import type { ConsoleWorkflowSummary, ConsoleWorkflowDetail } from '../../api/types';

// ---------------------------------------------------------------------------
// Fake data
// ---------------------------------------------------------------------------

function makeWorkflowSummary(id: string): ConsoleWorkflowSummary {
  return {
    id,
    name: `Workflow ${id}`,
    description: "",
    version: '1.0.0',
    tags: ['coding'],
    source: { kind: 'bundled', displayName: 'WorkRail' },
    stepCount: 3,
  };
}

const WF_A = makeWorkflowSummary('wf-a');
const WF_B = makeWorkflowSummary('wf-b');
const WF_C = makeWorkflowSummary('wf-c');
const WORKFLOW_LIST = [WF_A, WF_B, WF_C];

const WORKFLOW_DETAIL: ConsoleWorkflowDetail = {
  id: 'wf-b',
  name: 'Workflow wf-b',
  description: 'A test workflow',
  version: '1.0.0',
  tags: ['coding'],
  source: { kind: 'bundled', displayName: 'WorkRail' },
  stepCount: 3,
};

// ---------------------------------------------------------------------------
// Mock repositories
// ---------------------------------------------------------------------------

vi.mock('../useWorkflowDetailRepository', () => ({
  useWorkflowDetailRepository: vi.fn(() => ({
    kind: 'loading',
    refetch: vi.fn(),
  })),
}));

vi.mock('../useWorkflowsRepository', () => ({
  useWorkflowsRepository: vi.fn(() => ({
    workflows: WORKFLOW_LIST,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  })),
}));

import { useWorkflowDetailRepository } from '../useWorkflowDetailRepository';
import { useWorkflowsRepository } from '../useWorkflowsRepository';
const mockUseDetailRepo = vi.mocked(useWorkflowDetailRepository);
const mockUseListRepo = vi.mocked(useWorkflowsRepository);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParams(workflowId: string | null = 'wf-b') {
  return {
    workflowId,
    activeTag: null,
    onBack: vi.fn(),
    onNavigateToWorkflow: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useWorkflowDetailViewModel', () => {
  beforeEach(() => {
    mockUseDetailRepo.mockReturnValue({ kind: 'loading' });
    mockUseListRepo.mockReturnValue({ workflows: WORKFLOW_LIST, isLoading: false, error: null, refetch: vi.fn() });
  });

  describe('state transitions', () => {
    it('returns loading when detail repository is loading', () => {
      const { result } = renderHook(() => useWorkflowDetailViewModel(makeParams()));
      expect(result.current.state.kind).toBe('loading');
    });

    it('returns not_found when detail returns 404', () => {
      mockUseDetailRepo.mockReturnValue({ kind: 'not_found' });
      const { result } = renderHook(() => useWorkflowDetailViewModel(makeParams()));
      expect(result.current.state.kind).toBe('not_found');
    });

    it('returns error when detail fetch fails', () => {
      mockUseDetailRepo.mockReturnValue({ kind: 'error', message: 'Network error', refetch: vi.fn() });
      const { result } = renderHook(() => useWorkflowDetailViewModel(makeParams()));
      expect(result.current.state.kind).toBe('error');
    });

    it('returns ready with workflow data when fetch succeeds', () => {
      mockUseDetailRepo.mockReturnValue({ kind: 'ready', detail: WORKFLOW_DETAIL, refetch: vi.fn() });
      const { result } = renderHook(() => useWorkflowDetailViewModel(makeParams('wf-b')));
      expect(result.current.state.kind).toBe('ready');
      if (result.current.state.kind === 'ready') {
        expect(result.current.state.name).toBe('Workflow wf-b');
      }
    });
  });

  describe('adjacent navigation (getAdjacentWorkflows use case)', () => {
    beforeEach(() => {
      mockUseDetailRepo.mockReturnValue({ kind: 'ready', detail: WORKFLOW_DETAIL, refetch: vi.fn() });
    });

    it('middle workflow has both onPrev and onNext', () => {
      const { result } = renderHook(() => useWorkflowDetailViewModel(makeParams('wf-b')));
      if (result.current.state.kind === 'ready') {
        expect(result.current.state.onPrev).not.toBeNull();
        expect(result.current.state.onNext).not.toBeNull();
      }
    });

    it('first workflow has null onPrev', () => {
      const detailA = { ...WORKFLOW_DETAIL, id: 'wf-a', name: 'Workflow wf-a' };
      mockUseDetailRepo.mockReturnValue({ kind: 'ready', detail: detailA, refetch: vi.fn() });
      const { result } = renderHook(() => useWorkflowDetailViewModel(makeParams('wf-a')));
      if (result.current.state.kind === 'ready') {
        expect(result.current.state.onPrev).toBeNull();
        expect(result.current.state.onNext).not.toBeNull();
      }
    });

    it('last workflow has null onNext', () => {
      const detailC = { ...WORKFLOW_DETAIL, id: 'wf-c', name: 'Workflow wf-c' };
      mockUseDetailRepo.mockReturnValue({ kind: 'ready', detail: detailC, refetch: vi.fn() });
      const { result } = renderHook(() => useWorkflowDetailViewModel(makeParams('wf-c')));
      if (result.current.state.kind === 'ready') {
        expect(result.current.state.onPrev).not.toBeNull();
        expect(result.current.state.onNext).toBeNull();
      }
    });

    it('onPrev calls onNavigateToWorkflow with the previous workflow id', () => {
      const onNavigate = vi.fn();
      const { result } = renderHook(() =>
        useWorkflowDetailViewModel({ ...makeParams('wf-b'), onNavigateToWorkflow: onNavigate })
      );
      if (result.current.state.kind === 'ready') {
        result.current.state.onPrev?.();
        expect(onNavigate).toHaveBeenCalledWith('wf-a');
      }
    });

    it('onNext calls onNavigateToWorkflow with the next workflow id', () => {
      const onNavigate = vi.fn();
      const { result } = renderHook(() =>
        useWorkflowDetailViewModel({ ...makeParams('wf-b'), onNavigateToWorkflow: onNavigate })
      );
      if (result.current.state.kind === 'ready') {
        result.current.state.onNext?.();
        expect(onNavigate).toHaveBeenCalledWith('wf-c');
      }
    });
  });

  describe('loading state with optimistic cache', () => {
    it('loading state includes cached partial from workflow list', () => {
      // Detail is still loading, but workflow list is available
      const { result } = renderHook(() => useWorkflowDetailViewModel(makeParams('wf-b')));
      if (result.current.state.kind === 'loading') {
        expect(result.current.state.cached).toEqual(WF_B);
      }
    });
  });
});
