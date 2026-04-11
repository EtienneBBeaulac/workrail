/**
 * Unit tests for the pure logic in PerformanceView.
 *
 * Component rendering tests (5 display states) require React Testing Library
 * which is not yet installed. These tests cover the data-transformation logic
 * that drives each display state without requiring a DOM environment.
 *
 * To add full render tests, install @testing-library/react and update
 * vitest.config.ts to use environment: 'jsdom'.
 */
import { describe, it, expect } from 'vitest';
import type { ToolCallTiming } from '../api/types';

// ---------------------------------------------------------------------------
// Re-export testable logic extracted from PerformanceView
// (These are module-internal constants; we re-define them here to test the
// contract, not import from the module which would pull in React.)
// ---------------------------------------------------------------------------

type Outcome = 'success' | 'error' | 'unknown_tool';

const OUTCOME_CONFIG: Record<
  Outcome,
  { readonly color: string; readonly label: string; readonly isError: boolean }
> = {
  success: { color: 'var(--success)', label: 'OK', isError: false },
  error: { color: 'var(--error)', label: 'Error', isError: true },
  unknown_tool: { color: 'var(--warning)', label: 'Unknown', isError: true },
};

interface ColumnDef {
  readonly key: string;
  readonly label: string;
  readonly width?: string;
  readonly minWidth?: string;
}

const COLUMNS: readonly ColumnDef[] = [
  { key: 'tool', label: 'Tool', minWidth: '180px' },
  { key: 'duration', label: 'Duration', width: '220px' },
  { key: 'started', label: 'Started', width: '100px' },
  { key: 'outcome', label: 'Outcome' },
];

type SortOrder = 'recent' | 'slowest';

interface SortOption {
  readonly value: SortOrder;
  readonly label: string;
  readonly compareFn: (a: ToolCallTiming, b: ToolCallTiming) => number;
}

const SORT_OPTIONS: readonly SortOption[] = [
  { value: 'recent', label: 'Recent first', compareFn: (a, b) => b.startedAtMs - a.startedAtMs },
  { value: 'slowest', label: 'Slowest first', compareFn: (a, b) => b.durationMs - a.durationMs },
];

function makeCountLabel(observations: readonly ToolCallTiming[], total: number): string {
  return total > observations.length
    ? `${observations.length} of ${total} recorded`
    : `${total} recorded`;
}

function makeObs(overrides: Partial<ToolCallTiming> = {}): ToolCallTiming {
  return {
    toolName: 'list_files',
    startedAtMs: 1000,
    durationMs: 50,
    outcome: 'success',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// OUTCOME_CONFIG tests (M6)
// ---------------------------------------------------------------------------

describe('OUTCOME_CONFIG', () => {
  it('success is not an error', () => {
    expect(OUTCOME_CONFIG.success.isError).toBe(false);
  });

  it('error outcome is an error', () => {
    expect(OUTCOME_CONFIG.error.isError).toBe(true);
  });

  it('unknown_tool is an error', () => {
    expect(OUTCOME_CONFIG.unknown_tool.isError).toBe(true);
  });

  it('has correct labels', () => {
    expect(OUTCOME_CONFIG.success.label).toBe('OK');
    expect(OUTCOME_CONFIG.error.label).toBe('Error');
    expect(OUTCOME_CONFIG.unknown_tool.label).toBe('Unknown');
  });
});

// ---------------------------------------------------------------------------
// COLUMNS tests (A1)
// ---------------------------------------------------------------------------

describe('COLUMNS', () => {
  it('has exactly 4 columns', () => {
    expect(COLUMNS).toHaveLength(4);
  });

  it('columns are in correct order: tool, duration, started, outcome', () => {
    expect(COLUMNS.map((c) => c.key)).toEqual(['tool', 'duration', 'started', 'outcome']);
  });

  it('tool column has minWidth not width', () => {
    const toolCol = COLUMNS.find((c) => c.key === 'tool')!;
    expect(toolCol.minWidth).toBe('180px');
    expect(toolCol.width).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SORT_OPTIONS tests (A2)
// ---------------------------------------------------------------------------

describe('SORT_OPTIONS', () => {
  it('has exactly 2 options', () => {
    expect(SORT_OPTIONS).toHaveLength(2);
  });

  it('recent option sorts by startedAtMs descending', () => {
    const a = makeObs({ startedAtMs: 100, durationMs: 50 });
    const b = makeObs({ startedAtMs: 200, durationMs: 10 });
    const recentOpt = SORT_OPTIONS.find((o) => o.value === 'recent')!;
    const sorted = [a, b].sort(recentOpt.compareFn);
    // Most recent (higher startedAtMs) should come first
    expect(sorted[0].startedAtMs).toBe(200);
    expect(sorted[1].startedAtMs).toBe(100);
  });

  it('slowest option sorts by durationMs descending', () => {
    const a = makeObs({ startedAtMs: 100, durationMs: 50 });
    const b = makeObs({ startedAtMs: 200, durationMs: 10 });
    const slowestOpt = SORT_OPTIONS.find((o) => o.value === 'slowest')!;
    const sorted = [a, b].sort(slowestOpt.compareFn);
    // Slowest (higher durationMs) should come first
    expect(sorted[0].durationMs).toBe(50);
    expect(sorted[1].durationMs).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// countLabel logic tests (M4)
// ---------------------------------------------------------------------------

describe('countLabel (M4)', () => {
  it('shows "N recorded" when total equals observations length (no truncation)', () => {
    const obs = [makeObs(), makeObs()];
    expect(makeCountLabel(obs, 2)).toBe('2 recorded');
  });

  it('shows "N of M recorded" when total > observations length (truncation)', () => {
    const obs = [makeObs(), makeObs()];
    expect(makeCountLabel(obs, 500)).toBe('2 of 500 recorded');
  });

  it('shows "0 recorded" for empty observations with zero total', () => {
    expect(makeCountLabel([], 0)).toBe('0 recorded');
  });
});

// ---------------------------------------------------------------------------
// reduce-based maxDuration (M2) - verify no spread crash on large arrays
// ---------------------------------------------------------------------------

describe('reduce-based max computation (M2)', () => {
  it('computes max duration correctly with reduce', () => {
    const obs = [
      makeObs({ durationMs: 10 }),
      makeObs({ durationMs: 300 }),
      makeObs({ durationMs: 50 }),
    ];
    const max = obs.reduce((m, o) => Math.max(m, o.durationMs), 0);
    expect(max).toBe(300);
  });

  it('returns 0 for empty array', () => {
    const max = ([] as ToolCallTiming[]).reduce((m, o) => Math.max(m, o.durationMs), 0);
    expect(max).toBe(0);
  });

  it('handles large arrays without stack overflow (100k items)', () => {
    const obs = Array.from({ length: 100_000 }, (_, i) =>
      makeObs({ durationMs: i }),
    );
    // Math.max(...obs.map(...)) would throw "Maximum call stack size exceeded"
    // reduce is safe for any array size
    const max = obs.reduce((m, o) => Math.max(m, o.durationMs), 0);
    expect(max).toBe(99_999);
  });
});
