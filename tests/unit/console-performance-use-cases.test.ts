/**
 * Unit tests for performance-use-cases.ts pure functions.
 *
 * Pure function tests -- no DOM, no React, no mocks.
 * Pattern follows console-workflows-use-cases.test.ts.
 *
 * Covers:
 *   - sortObservations: recent-first and slowest-first ordering
 *   - computeMaxDuration: safe max via reduce
 *   - computeErrorCount: counts error and unknown_tool outcomes
 *   - computeAvgMs: average, rounding, null on empty
 *   - computeLastCallMs: most recent startedAtMs, null on empty
 *   - computeBarWidth: proportion capped at 120px, zero-guard
 *   - computeCountLabel: string formatting
 */
import { describe, it, expect } from 'vitest';
import {
  sortObservations,
  computeMaxDuration,
  computeErrorCount,
  computeAvgMs,
  computeLastCallMs,
  computeBarWidth,
  computeCountLabel,
} from '../../console/src/views/performance-use-cases';
import type { ToolCallTiming } from '../../console/src/api/types';

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

function makeObs(overrides: Partial<ToolCallTiming> = {}): ToolCallTiming {
  return {
    toolName: 'test_tool',
    startedAtMs: 1000,
    durationMs: 100,
    outcome: 'success',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// sortObservations
// ---------------------------------------------------------------------------

describe('sortObservations', () => {
  it('returns empty array for empty input', () => {
    expect(sortObservations([], 'recent')).toEqual([]);
    expect(sortObservations([], 'slowest')).toEqual([]);
  });

  it('sorts recent-first by startedAtMs descending', () => {
    const obs = [
      makeObs({ startedAtMs: 1000 }),
      makeObs({ startedAtMs: 3000 }),
      makeObs({ startedAtMs: 2000 }),
    ];
    const result = sortObservations(obs, 'recent');
    expect(result[0]!.startedAtMs).toBe(3000);
    expect(result[1]!.startedAtMs).toBe(2000);
    expect(result[2]!.startedAtMs).toBe(1000);
  });

  it('sorts slowest-first by durationMs descending', () => {
    const obs = [
      makeObs({ durationMs: 50 }),
      makeObs({ durationMs: 200 }),
      makeObs({ durationMs: 100 }),
    ];
    const result = sortObservations(obs, 'slowest');
    expect(result[0]!.durationMs).toBe(200);
    expect(result[1]!.durationMs).toBe(100);
    expect(result[2]!.durationMs).toBe(50);
  });

  it('does not mutate the input array', () => {
    const obs = [
      makeObs({ startedAtMs: 1000 }),
      makeObs({ startedAtMs: 3000 }),
    ];
    const originalFirst = obs[0]!.startedAtMs;
    sortObservations(obs, 'recent');
    expect(obs[0]!.startedAtMs).toBe(originalFirst);
  });
});

// ---------------------------------------------------------------------------
// computeMaxDuration
// ---------------------------------------------------------------------------

describe('computeMaxDuration', () => {
  it('returns 0 for empty array', () => {
    expect(computeMaxDuration([])).toBe(0);
  });

  it('returns the single value for a one-element array', () => {
    expect(computeMaxDuration([makeObs({ durationMs: 42 })])).toBe(42);
  });

  it('returns the maximum durationMs across multiple observations', () => {
    const obs = [
      makeObs({ durationMs: 100 }),
      makeObs({ durationMs: 500 }),
      makeObs({ durationMs: 250 }),
    ];
    expect(computeMaxDuration(obs)).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// computeErrorCount
// ---------------------------------------------------------------------------

describe('computeErrorCount', () => {
  it('returns 0 for empty array', () => {
    expect(computeErrorCount([])).toBe(0);
  });

  it('returns 0 when all observations are success', () => {
    const obs = [makeObs({ outcome: 'success' }), makeObs({ outcome: 'success' })];
    expect(computeErrorCount(obs)).toBe(0);
  });

  it('counts error outcomes', () => {
    const obs = [
      makeObs({ outcome: 'success' }),
      makeObs({ outcome: 'error' }),
      makeObs({ outcome: 'error' }),
    ];
    expect(computeErrorCount(obs)).toBe(2);
  });

  it('counts unknown_tool as an error', () => {
    const obs = [
      makeObs({ outcome: 'success' }),
      makeObs({ outcome: 'unknown_tool' }),
    ];
    expect(computeErrorCount(obs)).toBe(1);
  });

  it('counts mixed error and unknown_tool together', () => {
    const obs = [
      makeObs({ outcome: 'error' }),
      makeObs({ outcome: 'unknown_tool' }),
      makeObs({ outcome: 'success' }),
    ];
    expect(computeErrorCount(obs)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// computeAvgMs
// ---------------------------------------------------------------------------

describe('computeAvgMs', () => {
  it('returns null for empty array', () => {
    expect(computeAvgMs([])).toBeNull();
  });

  it('returns the single value for one element', () => {
    expect(computeAvgMs([makeObs({ durationMs: 100 })])).toBe(100);
  });

  it('returns the arithmetic mean rounded to nearest integer', () => {
    const obs = [
      makeObs({ durationMs: 100 }),
      makeObs({ durationMs: 200 }),
    ];
    expect(computeAvgMs(obs)).toBe(150);
  });

  it('rounds fractional result to nearest integer', () => {
    const obs = [
      makeObs({ durationMs: 100 }),
      makeObs({ durationMs: 101 }),
      makeObs({ durationMs: 102 }),
    ];
    // (100 + 101 + 102) / 3 = 101
    expect(computeAvgMs(obs)).toBe(101);
  });

  it('rounds 0.5 up', () => {
    const obs = [makeObs({ durationMs: 1 }), makeObs({ durationMs: 2 })];
    // (1 + 2) / 2 = 1.5 -> rounds to 2
    expect(computeAvgMs(obs)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// computeLastCallMs
// ---------------------------------------------------------------------------

describe('computeLastCallMs', () => {
  it('returns null for empty array', () => {
    expect(computeLastCallMs([])).toBeNull();
  });

  it('returns the single startedAtMs for one element', () => {
    expect(computeLastCallMs([makeObs({ startedAtMs: 5000 })])).toBe(5000);
  });

  it('returns the maximum startedAtMs', () => {
    const obs = [
      makeObs({ startedAtMs: 1000 }),
      makeObs({ startedAtMs: 9000 }),
      makeObs({ startedAtMs: 3000 }),
    ];
    expect(computeLastCallMs(obs)).toBe(9000);
  });
});

// ---------------------------------------------------------------------------
// computeBarWidth
// ---------------------------------------------------------------------------

describe('computeBarWidth', () => {
  it('returns 0 when maxDuration is 0 (zero-guard)', () => {
    expect(computeBarWidth(100, 0)).toBe(0);
  });

  it('returns 120 when duration equals maxDuration (full bar)', () => {
    expect(computeBarWidth(500, 500)).toBe(120);
  });

  it('returns 60 when duration is half of maxDuration', () => {
    expect(computeBarWidth(250, 500)).toBe(60);
  });

  it('rounds to nearest integer', () => {
    // 1/3 of 120 = 40
    expect(computeBarWidth(1, 3)).toBe(40);
  });

  it('returns 0 for a 0ms duration', () => {
    expect(computeBarWidth(0, 500)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeCountLabel
// ---------------------------------------------------------------------------

describe('computeCountLabel', () => {
  it('formats zero as "0 recorded"', () => {
    expect(computeCountLabel(0)).toBe('0 recorded');
  });

  it('formats a positive count', () => {
    expect(computeCountLabel(42)).toBe('42 recorded');
  });

  it('formats 1 correctly (no special singular/plural)', () => {
    expect(computeCountLabel(1)).toBe('1 recorded');
  });
});
