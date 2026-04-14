/**
 * Integration tests for usePerformanceViewModel.
 *
 * Tests state transitions and sort order interaction.
 */
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { usePerformanceViewModel } from '../usePerformanceViewModel';
import type { ToolCallTiming } from '../../api/types';

// ---------------------------------------------------------------------------
// Fake data
// ---------------------------------------------------------------------------

function makeTiming(toolName: string, durationMs: number, outcome: ToolCallTiming['outcome'] = 'success'): ToolCallTiming {
  return {
    toolName,
    startedAtMs: Date.now() - durationMs,
    durationMs,
    outcome,
  };
}

const OBSERVATIONS: ToolCallTiming[] = [
  makeTiming('list_workflows', 120),
  makeTiming('start_workflow', 350),
  makeTiming('continue_workflow', 80, 'error'),
];

// ---------------------------------------------------------------------------
// Mock repository
// ---------------------------------------------------------------------------

vi.mock('../usePerformanceRepository', () => ({
  usePerformanceRepository: vi.fn(() => ({
    kind: 'loading',
  })),
}));

import { usePerformanceRepository } from '../usePerformanceRepository';
const mockUseRepo = vi.mocked(usePerformanceRepository);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('usePerformanceViewModel', () => {
  beforeEach(() => {
    mockUseRepo.mockReturnValue({ kind: 'loading' });
  });

  describe('state transitions', () => {
    it('returns loading when repository is loading', () => {
      const { result } = renderHook(() => usePerformanceViewModel());
      expect(result.current.state.kind).toBe('loading');
    });

    it('returns devModeOff when dev mode is off', () => {
      mockUseRepo.mockReturnValue({ kind: 'devModeOff' });
      const { result } = renderHook(() => usePerformanceViewModel());
      expect(result.current.state.kind).toBe('devModeOff');
    });

    it('returns error when repository has an error', () => {
      mockUseRepo.mockReturnValue({ kind: 'error', message: 'fetch failed', retry: vi.fn() });
      const { result } = renderHook(() => usePerformanceViewModel());
      expect(result.current.state.kind).toBe('error');
      if (result.current.state.kind === 'error') {
        expect(result.current.state.message).toBe('fetch failed');
      }
    });

    it('returns ready with derived stats when observations are available', () => {
      mockUseRepo.mockReturnValue({ kind: 'ready', observations: OBSERVATIONS });
      const { result } = renderHook(() => usePerformanceViewModel());
      expect(result.current.state.kind).toBe('ready');
      if (result.current.state.kind === 'ready') {
        expect(result.current.state.sorted).toHaveLength(3);
        expect(result.current.state.errorCount).toBe(1);
        expect(result.current.state.maxDuration).toBe(350);
      }
    });
  });

  describe('sort order', () => {
    it('initial sort order is recent', () => {
      mockUseRepo.mockReturnValue({ kind: 'ready', observations: OBSERVATIONS });
      const { result } = renderHook(() => usePerformanceViewModel());
      if (result.current.state.kind === 'ready') {
        expect(result.current.state.sortOrder).toBe('recent');
      }
    });

    it('onSortChange updates the sort order and re-sorts observations', () => {
      mockUseRepo.mockReturnValue({ kind: 'ready', observations: OBSERVATIONS });
      const { result } = renderHook(() => usePerformanceViewModel());

      act(() => {
        if (result.current.state.kind === 'ready') {
          result.current.state.onSortChange('slowest');
        }
      });

      if (result.current.state.kind === 'ready') {
        expect(result.current.state.sortOrder).toBe('slowest');
        // Sorted by slowest: start_workflow (350ms) should be first
        expect(result.current.state.sorted[0]?.toolName).toBe('start_workflow');
      }
    });
  });
});
