/**
 * ViewModel hook for PerformanceView.
 *
 * Orchestrates the repository layer and use cases into a single
 * PerformanceViewState discriminated union for the UI to render.
 *
 * Owns:
 * - Repository data (via usePerformanceRepository)
 * - UI interaction state: sortOrder (via useState -- single simple toggle)
 * - Derived display data (via performance-use-cases, wrapped in useMemo)
 *
 * Does NOT own:
 * - JSX, styling, or formatting beyond the data contract
 */
import { useState, useMemo } from 'react';
import { usePerformanceRepository } from './usePerformanceRepository';
import {
  sortObservations,
  computeMaxDuration,
  computeErrorCount,
  computeAvgMs,
  computeLastCallMs,
  computeCountLabel,
  SORT_OPTIONS,
  OUTCOME_CONFIG,
  type SortOrder,
  type SortOption,
  type Outcome,
} from '../views/performance-use-cases';
import type { ToolCallTiming } from '../api/types';

// Re-export types the presenter needs so it imports from one place.
export type { SortOrder, SortOption, Outcome };
export { SORT_OPTIONS, OUTCOME_CONFIG };

// ---------------------------------------------------------------------------
// View state
// ---------------------------------------------------------------------------

export type PerformanceViewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'devModeOff' }
  | { readonly kind: 'error'; readonly message: string; readonly retry: () => void }
  | {
      readonly kind: 'ready';
      /** Sorted observations ready for rendering. */
      readonly sorted: readonly ToolCallTiming[];
      /** Maximum durationMs in the sorted list; used to scale the duration bar. */
      readonly maxDuration: number;
      /** Count of error-outcome observations. */
      readonly errorCount: number;
      /** Average durationMs rounded to nearest integer, or null when list is empty. */
      readonly avgMs: number | null;
      /** Most recent startedAtMs, or null when list is empty. */
      readonly lastCallMs: number | null;
      /** Human-readable count label (e.g. "42 recorded"). */
      readonly countLabel: string;
      /** Active sort order. */
      readonly sortOrder: SortOrder;
      /** Setter for sort order -- passed through so the presenter can dispatch changes. */
      readonly onSortChange: (order: SortOrder) => void;
    };

// ---------------------------------------------------------------------------
// Hook result
// ---------------------------------------------------------------------------

export interface UsePerformanceViewModelResult {
  readonly state: PerformanceViewState;
}

// ---------------------------------------------------------------------------
// ViewModel hook
// ---------------------------------------------------------------------------

export function usePerformanceViewModel(): UsePerformanceViewModelResult {
  const repo = usePerformanceRepository();
  const [sortOrder, setSortOrder] = useState<SortOrder>('recent');

  const state = useMemo((): PerformanceViewState => {
    if (repo.kind === 'loading') return { kind: 'loading' };
    if (repo.kind === 'devModeOff') return { kind: 'devModeOff' };
    if (repo.kind === 'error') {
      return { kind: 'error', message: repo.message, retry: repo.retry };
    }

    const { observations } = repo;
    const sorted = sortObservations(observations, sortOrder);
    const maxDuration = computeMaxDuration(sorted);
    const errorCount = computeErrorCount(observations);
    const avgMs = computeAvgMs(observations);
    const lastCallMs = computeLastCallMs(observations);
    const countLabel = computeCountLabel(observations.length);

    return {
      kind: 'ready',
      sorted,
      maxDuration,
      errorCount,
      avgMs,
      lastCallMs,
      countLabel,
      sortOrder,
      onSortChange: setSortOrder,
    };
  // setSortOrder is stable (from useState), safe to omit from deps.
  // repo.retry is a new function each render but stable enough for a callback ref.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, sortOrder]);

  return { state };
}
