/**
 * Pure state-mapping function extracted from usePerfToolCalls so it can be
 * unit-tested without React hook infrastructure.
 *
 * The hook delegates to this function for all state mapping; the hook itself
 * only handles the React Query integration.
 */
import type { PerfToolCallsResponse } from './types';
import type { PerfToolCallsResult } from './hooks';

export interface QuerySnapshot {
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly error: unknown;
  readonly data: PerfToolCallsResponse | null | undefined;
}

/**
 * Maps a React Query snapshot to the discriminated PerfToolCallsResult union.
 * Pure function - no side effects, no React dependency.
 */
export function mapPerfQueryToResult(
  snapshot: QuerySnapshot,
  retry: () => void,
): PerfToolCallsResult {
  if (snapshot.isLoading) return { state: 'loading' };
  if (snapshot.isError) {
    return {
      state: 'error',
      message:
        snapshot.error instanceof Error
          ? snapshot.error.message
          : 'Could not load performance data.',
      retry,
    };
  }
  if (snapshot.data === null) return { state: 'devModeOff' };
  if (snapshot.data === undefined) return { state: 'loading' };
  // Defense-in-depth: guard against future server change from 404-signaling to
  // devMode:false-signaling without a breaking schema change.
  if (snapshot.data.devMode === false) return { state: 'devModeOff' };
  return { state: 'data', data: snapshot.data };
}
