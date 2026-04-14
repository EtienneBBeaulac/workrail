/**
 * Pure use-case functions for PerformanceView derived display data.
 *
 * No React imports. Same inputs always produce the same outputs.
 * Extracted from PerformanceView's useMemo chains.
 */
import type { ToolCallTiming } from '../api/types';

// ---------------------------------------------------------------------------
// Sort configuration
// ---------------------------------------------------------------------------

export type SortOrder = 'recent' | 'slowest';

export interface SortOption {
  readonly value: SortOrder;
  readonly label: string;
  readonly compareFn: (a: ToolCallTiming, b: ToolCallTiming) => number;
}

export const SORT_OPTIONS: readonly SortOption[] = [
  { value: 'recent', label: 'Recent first', compareFn: (a, b) => b.startedAtMs - a.startedAtMs },
  { value: 'slowest', label: 'Slowest first', compareFn: (a, b) => b.durationMs - a.durationMs },
];

// ---------------------------------------------------------------------------
// Outcome configuration (single source of truth)
// ---------------------------------------------------------------------------

export type Outcome = 'success' | 'error' | 'unknown_tool';

export const OUTCOME_CONFIG: Record<
  Outcome,
  { readonly color: string; readonly label: string; readonly isError: boolean }
> = {
  success: { color: 'var(--success)', label: 'OK', isError: false },
  error: { color: 'var(--error)', label: 'Error', isError: true },
  unknown_tool: { color: 'var(--warning)', label: 'Unknown', isError: true },
};

// ---------------------------------------------------------------------------
// Derived display data
// ---------------------------------------------------------------------------

/**
 * Returns observations sorted by the given sort order.
 *
 * Uses the compareFn from SORT_OPTIONS. Creates a shallow copy before sorting
 * so the input array is never mutated.
 */
export function sortObservations(
  observations: readonly ToolCallTiming[],
  sortOrder: SortOrder,
): readonly ToolCallTiming[] {
  const option = SORT_OPTIONS.find((o) => o.value === sortOrder)!;
  return [...observations].sort(option.compareFn);
}

/**
 * Returns the maximum durationMs across all observations.
 *
 * Uses reduce to avoid Math.max(...spread) which crashes on large arrays.
 * Returns 0 for an empty array.
 */
export function computeMaxDuration(observations: readonly ToolCallTiming[]): number {
  return observations.reduce((max, o) => Math.max(max, o.durationMs), 0);
}

/**
 * Returns the count of observations whose outcome is classified as an error.
 */
export function computeErrorCount(observations: readonly ToolCallTiming[]): number {
  return observations.filter((o) => OUTCOME_CONFIG[o.outcome].isError).length;
}

/**
 * Returns the average durationMs rounded to the nearest integer, or null
 * if the observations array is empty.
 */
export function computeAvgMs(observations: readonly ToolCallTiming[]): number | null {
  if (observations.length === 0) return null;
  return Math.round(
    observations.reduce((sum, o) => sum + o.durationMs, 0) / observations.length,
  );
}

/**
 * Returns the most recent startedAtMs across all observations, or null if
 * the array is empty.
 *
 * Uses reduce to avoid Math.max(...spread) which crashes on large arrays.
 */
export function computeLastCallMs(observations: readonly ToolCallTiming[]): number | null {
  if (observations.length === 0) return null;
  return observations.reduce((max, o) => Math.max(max, o.startedAtMs), 0);
}

/**
 * Returns the bar width in pixels for a timing row, capped at 120px.
 *
 * Returns 0 when maxDuration is 0 to avoid division by zero.
 */
export function computeBarWidth(durationMs: number, maxDuration: number): number {
  return maxDuration > 0 ? Math.round((durationMs / maxDuration) * 120) : 0;
}

/**
 * Returns a human-readable count label for the observations ring buffer.
 */
export function computeCountLabel(count: number): string {
  return `${count} recorded`;
}
