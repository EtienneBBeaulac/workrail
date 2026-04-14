/**
 * Repository hook for performance tool call data.
 *
 * Wraps usePerfToolCalls() from the API layer and returns clean domain types.
 * Callers receive PerformanceRepoData -- they never see raw React Query objects
 * or the PerfToolCallsResult discriminated union from the API.
 *
 * Loading detection: delegates to the existing usePerfToolCalls hook which
 * already handles the isLoading / isError / devModeOff / data states correctly.
 */
import type { ToolCallTiming } from '../api/types';
import { usePerfToolCalls } from '../api/hooks';

// ---------------------------------------------------------------------------
// Domain type returned by this repository
// ---------------------------------------------------------------------------

export type PerformanceRepoData =
  | { readonly kind: 'loading' }
  | { readonly kind: 'devModeOff' }
  | { readonly kind: 'error'; readonly message: string; readonly retry: () => void }
  | { readonly kind: 'ready'; readonly observations: readonly ToolCallTiming[] };

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Returns clean performance domain data from the API layer.
 *
 * This hook is the repository layer: it owns the data-fetching boundary.
 * All React Query details are encapsulated in usePerfToolCalls and never
 * leak to callers.
 */
export function usePerformanceRepository(): PerformanceRepoData {
  const result = usePerfToolCalls();

  switch (result.state) {
    case 'loading':
      return { kind: 'loading' };
    case 'devModeOff':
      return { kind: 'devModeOff' };
    case 'error':
      return { kind: 'error', message: result.message, retry: result.retry };
    case 'data':
      return { kind: 'ready', observations: result.data.observations };
  }
}
