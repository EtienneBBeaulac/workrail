import type { Result } from 'neverthrow';
import { ok, err } from 'neverthrow';
import type { Brand } from '../../runtime/brand.js';
import type { DomainEventV1 } from './schemas/session/index.js';
import type { ProjectionError } from '../projections/projection-error.js';

/**
 * Branded type: SortedEventLog
 *
 * Invariant: events are sorted by eventIndex ascending (store guarantee).
 *
 * Footgun prevented:
 * - Prevents passing an unsorted DomainEventV1[] directly to projections
 * - Makes the "validate at boundary, trust inside" contract explicit in the type system
 *
 * How to construct:
 * - Use `asSortedEventLog()` which validates sort order once at the boundary
 * - Projections that accept SortedEventLog trust the brand and skip re-validation
 *
 * Why not return SortedEventLog from the store directly:
 * - The LoadedSessionTruthV2 port type is shared across multiple consumers
 * - Threading SortedEventLog through the port would be a larger refactor (tracked separately)
 * - The current approach validates once per call site after load(), which is sufficient
 *
 * Performance intent:
 * - Removes 4 independent O(n) sort checks per continue_workflow call
 * - projectAssessmentsV2 gains a .some() fast-path (the common no-assessment path)
 */
export type SortedEventLog = Brand<readonly DomainEventV1[], 'v2.SortedEventLog'>;

/**
 * Construct a SortedEventLog from a raw event array.
 *
 * Validates that events are sorted by eventIndex ascending.
 * Returns err(PROJECTION_INVARIANT_VIOLATION) if the invariant is not met.
 *
 * Call this once after loading events from the store, then pass the result
 * to projections that require SortedEventLog.
 */
export function asSortedEventLog(
  events: readonly DomainEventV1[]
): Result<SortedEventLog, ProjectionError> {
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.eventIndex < events[i - 1]!.eventIndex) {
      return err({
        code: 'PROJECTION_INVARIANT_VIOLATION',
        message: 'Events must be sorted by eventIndex ascending',
      });
    }
  }
  return ok(events as SortedEventLog);
}
