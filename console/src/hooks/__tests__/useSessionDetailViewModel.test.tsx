/**
 * Integration tests for useSessionDetailViewModel.
 *
 * Tests state transitions and the node selection toggle.
 */
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSessionDetailViewModel } from '../useSessionDetailViewModel';
import type { ConsoleSessionDetail } from '../../api/types';

// ---------------------------------------------------------------------------
// Fake data
// ---------------------------------------------------------------------------

const FAKE_SESSION: ConsoleSessionDetail = {
  sessionId: 'sess-001',
  sessionTitle: 'Fix auth bug',
  health: 'healthy',
  runs: [
    {
      runId: 'run-001',
      workflowId: 'wf-coding',
      workflowName: 'Coding Task',
      workflowHash: null,
      preferredTipNodeId: null,
      status: 'complete',
      hasUnresolvedCriticalGaps: false,
      executionTraceSummary: null,
      skippedSteps: [],
      nodes: [{ nodeId: 'node-001', nodeKind: 'step', parentNodeId: null, createdAtEventIndex: 0, isPreferredTip: true, isTip: true, stepLabel: null, hasRecap: false, hasFailedValidations: false, hasGaps: false, hasArtifacts: false }],
      edges: [],
      tipNodeIds: ['node-001'],
    },
  ],
};

// ---------------------------------------------------------------------------
// Mock repository
// ---------------------------------------------------------------------------

vi.mock('../useSessionDetailRepository', () => ({
  useSessionDetailRepository: vi.fn(() => ({
    data: FAKE_SESSION,
    isLoading: false,
    error: null,
  })),
}));

import { useSessionDetailRepository } from '../useSessionDetailRepository';
const mockUseRepo = vi.mocked(useSessionDetailRepository);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useSessionDetailViewModel', () => {
  beforeEach(() => {
    mockUseRepo.mockReturnValue({ data: FAKE_SESSION, isLoading: false, error: null });
  });

  describe('state transitions', () => {
    it('returns loading when repository is loading', () => {
      mockUseRepo.mockReturnValue({ data: undefined, isLoading: true, error: null });
      const { result } = renderHook(() => useSessionDetailViewModel('sess-001'));
      expect(result.current.state.kind).toBe('loading');
    });

    it('returns error when repository has an error', () => {
      mockUseRepo.mockReturnValue({ data: undefined, isLoading: false, error: new Error('not found') });
      const { result } = renderHook(() => useSessionDetailViewModel('sess-001'));
      expect(result.current.state.kind).toBe('error');
    });

    it('returns ready when data is available', () => {
      const { result } = renderHook(() => useSessionDetailViewModel('sess-001'));
      expect(result.current.state.kind).toBe('ready');
      if (result.current.state.kind === 'ready') {
        expect(result.current.state.sessionId).toBe('sess-001');
        expect(result.current.state.data).toEqual(FAKE_SESSION);
      }
    });
  });

  describe('node selection', () => {
    it('selectedNode is null initially', () => {
      const { result } = renderHook(() => useSessionDetailViewModel('sess-001'));
      if (result.current.state.kind === 'ready') {
        expect(result.current.state.selectedNode).toBeNull();
      }
    });

    it('onSelectNode sets the selected node', () => {
      const { result } = renderHook(() => useSessionDetailViewModel('sess-001'));
      act(() => { result.current.onSelectNode('run-001', 'node-001'); });
      if (result.current.state.kind === 'ready') {
        expect(result.current.state.selectedNode).toEqual({ runId: 'run-001', nodeId: 'node-001' });
      }
    });

    it('onSelectNode toggles off when same node is selected again', () => {
      const { result } = renderHook(() => useSessionDetailViewModel('sess-001'));
      act(() => { result.current.onSelectNode('run-001', 'node-001'); });
      act(() => { result.current.onSelectNode('run-001', 'node-001'); });
      if (result.current.state.kind === 'ready') {
        expect(result.current.state.selectedNode).toBeNull();
      }
    });

    it('onCloseNode clears the selected node', () => {
      const { result } = renderHook(() => useSessionDetailViewModel('sess-001'));
      act(() => { result.current.onSelectNode('run-001', 'node-001'); });
      act(() => { result.current.onCloseNode(); });
      if (result.current.state.kind === 'ready') {
        expect(result.current.state.selectedNode).toBeNull();
      }
    });

    it('selectedRun is populated when a node is selected', () => {
      const { result } = renderHook(() => useSessionDetailViewModel('sess-001'));
      act(() => { result.current.onSelectNode('run-001', 'node-001'); });
      if (result.current.state.kind === 'ready') {
        expect(result.current.state.selectedRun?.runId).toBe('run-001');
      }
    });

    it('selectedRun is null when no node is selected', () => {
      const { result } = renderHook(() => useSessionDetailViewModel('sess-001'));
      if (result.current.state.kind === 'ready') {
        expect(result.current.state.selectedRun).toBeNull();
      }
    });
  });
});
