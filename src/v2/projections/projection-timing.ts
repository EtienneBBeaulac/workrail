import type { Result } from 'neverthrow';

/**
 * Structured projection timing observation.
 *
 * Why: projections recompute from the full event log on every call.
 * This hook provides evidence-based data for deciding when a
 * ProjectionCachePort is warranted (Stage 2), without guessing.
 *
 * Usage: wrap any projection function via `withProjectionTiming`.
 */
export interface ProjectionTimingV2 {
  readonly projectionName: string;
  readonly eventCount: number;
  readonly durationMs: number;
}

/**
 * Optional sink for projection timing observations.
 * Defaults to no-op; inject a real sink (structured log, metrics) when needed.
 */
export type ProjectionTimingSink = (timing: ProjectionTimingV2) => void;

/** No-op sink (default — zero overhead when timing is not observed). */
export const noopTimingSink: ProjectionTimingSink = () => {};

/**
 * Higher-order function: wraps a pure projection to emit timing observations.
 *
 * The wrapper is transparent to callers — same signature, same Result type.
 * Timing is best-effort: if the sink throws, the projection result is still returned.
 *
 * @example
 * const timedProjectRunDag = withProjectionTiming('projectRunDagV2', projectRunDagV2, sink);
 * const result = timedProjectRunDag(events);
 */
export function withProjectionTiming<E, T>(
  projectionName: string,
  fn: (events: readonly { readonly eventIndex: number }[]) => Result<T, E>,
  sink: ProjectionTimingSink = noopTimingSink,
): (events: readonly { readonly eventIndex: number }[]) => Result<T, E> {
  return (events) => {
    const start = performance.now();
    const result = fn(events);
    const durationMs = performance.now() - start;

    try {
      sink({
        projectionName,
        eventCount: events.length,
        durationMs: Math.round(durationMs * 100) / 100,
      });
    } catch {
      // Timing is observability, not correctness — never let sink errors affect the projection.
    }

    return result;
  };
}
