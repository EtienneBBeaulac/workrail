import type { Brand } from '../../runtime/brand.js';
import type { SortedEventLog } from './sorted-event-log.js';
import type { DomainEventV1 } from './schemas/session/index.js';
import type { JsonObject } from './canonical/json-types.js';
import { OUTPUT_CHANNEL, PAYLOAD_KIND } from './constants.js';

/**
 * Branded type: SessionIndex
 *
 * A single-pass index over a SortedEventLog that pre-extracts the facts
 * currently scattered across redundant .find()/.some() scans per
 * continue_workflow call.
 *
 * Invariants:
 * - Built exactly once per session load via buildSessionIndex()
 * - All fields are readonly -- the index is never mutated after construction
 * - Two separate instances must be built for the pre-lock and post-lock truths:
 *   - preLockIndex: built from pre-lock truth, used for early-exit guards only
 *   - lockedIndex: built from truthLocked (post-lock), used for dedup checks
 *
 * TOCTOU note: Never use preLockIndex.advanceRecordedByDedupeKey for the
 * advance_recorded dedup check. That check MUST use lockedIndex (built from
 * the post-lock reload). Using pre-lock data would miss concurrent writes
 * that happened between the pre-lock read and lock acquisition.
 *
 * Why naming-only TOCTOU mitigation (not phantom types):
 * The two build sites (preLockIndex and lockedIndex) are co-located in the
 * same function body (handleAdvanceIntent). There is no API boundary at which
 * the wrong type could accidentally be passed. If the index is ever passed
 * across module boundaries, phantom types should be added at that point.
 *
 * Performance intent:
 * - Eliminates handler-level O(n) event scans per continue_workflow call
 * - Also eliminates projection-internal scans when callers pass the index
 *   to validateAdvanceInputs and renderPendingPrompt
 */
export interface SessionIndexData {
  /**
   * The validated, sorted event log this index was built from.
   * Callers can pass this to projections that accept SortedEventLog
   * instead of calling asSortedEventLog() again.
   */
  readonly sortedEvents: SortedEventLog;

  /**
   * run_started events keyed by scope.runId.
   * Used to retrieve workflowHash for the active run without re-scanning.
   */
  readonly runStartedByRunId: ReadonlyMap<string, Extract<DomainEventV1, { kind: 'run_started' }>>;

  /**
   * node_created events keyed by scope.nodeId.
   * NodeIds are 128-bit cryptographically random IDs (see IdFactoryV2.mintNodeId())
   * -- unique within the session by negligible collision probability. The original
   * .find() checked both nodeId AND runId; the index drops the runId predicate
   * since random-ID uniqueness makes it redundant. If this assumption is relaxed,
   * change the key to `runId:nodeId` (tracked in follow-up ticket).
   */
  readonly nodeCreatedByNodeId: ReadonlyMap<string, Extract<DomainEventV1, { kind: 'node_created' }>>;

  /**
   * Set of fromNodeIds that have at least one outgoing edge.
   * Used to determine hasChildren in the blocked/advance outcome paths
   * without re-scanning all edge_created events.
   */
  readonly hasChildEdgeByFromNodeId: ReadonlySet<string>;

  /**
   * advance_recorded events keyed by dedupeKey.
   * Used for idempotency checks.
   *
   * IMPORTANT: When using this field for the advance dedup check, ensure you
   * are using the lockedIndex (built from truthLocked, post-lock), NOT the
   * preLockIndex. See TOCTOU note above.
   */
  readonly advanceRecordedByDedupeKey: ReadonlyMap<string, Extract<DomainEventV1, { kind: 'advance_recorded' }>>;

  /**
   * The eventIndex to use for the next appended event.
   * Computed as last event's eventIndex + 1, or 0 for an empty log.
   */
  readonly nextEventIndex: number;

  /**
   * Set of runIds that have at least one node_output_appended recap/notes event.
   * Used by renderPendingPrompt to skip the hasPriorNotesInRun .some() scan.
   */
  readonly hasPriorNotesByRunId: ReadonlySet<string>;

  /**
   * Latest context per runId, derived from context_set events (latest wins).
   * Used by validateAdvanceInputs to skip the projectRunContextV2 scan.
   * Only populated for context_set events with valid plain-object context.
   */
  readonly runContextByRunId: ReadonlyMap<string, JsonObject>;
}

export type SessionIndex = Brand<SessionIndexData, 'v2.SessionIndex'>;

/**
 * Build a SessionIndex from a SortedEventLog in a single O(n) pass.
 *
 * Returns a bare SessionIndex (not Result<>) because SortedEventLog input
 * guarantees well-formed, known-kind events by construction. Unknown event
 * kinds are silently skipped (forward compatibility -- unknown kinds indicate
 * a schema version this code doesn't know about, not a programming error).
 *
 * Do not call this more than once per session load. Build preLockIndex from
 * the pre-lock truth, and lockedIndex from truthLocked (inside the lock).
 */
export function buildSessionIndex(events: SortedEventLog): SessionIndex {
  const runStartedByRunId = new Map<string, Extract<DomainEventV1, { kind: 'run_started' }>>();
  const nodeCreatedByNodeId = new Map<string, Extract<DomainEventV1, { kind: 'node_created' }>>();
  const hasChildEdgeByFromNodeId = new Set<string>();
  const advanceRecordedByDedupeKey = new Map<string, Extract<DomainEventV1, { kind: 'advance_recorded' }>>();
  const hasPriorNotesByRunId = new Set<string>();
  const runContextByRunId = new Map<string, JsonObject>();

  for (const event of events) {
    switch (event.kind) {
      case 'run_started':
        runStartedByRunId.set(event.scope.runId, event as Extract<DomainEventV1, { kind: 'run_started' }>);
        break;
      case 'node_created':
        nodeCreatedByNodeId.set(event.scope.nodeId, event as Extract<DomainEventV1, { kind: 'node_created' }>);
        break;
      case 'edge_created':
        hasChildEdgeByFromNodeId.add((event as Extract<DomainEventV1, { kind: 'edge_created' }>).data.fromNodeId);
        break;
      case 'advance_recorded':
        advanceRecordedByDedupeKey.set(event.dedupeKey, event as Extract<DomainEventV1, { kind: 'advance_recorded' }>);
        break;
      case 'node_output_appended': {
        // Track runs that have prior recap/notes so renderPendingPrompt
        // can skip its hasPriorNotesInRun .some() scan.
        const outputEvt = event as Extract<DomainEventV1, { kind: 'node_output_appended' }>;
        if (outputEvt.data.outputChannel === OUTPUT_CHANNEL.RECAP &&
            outputEvt.data.payload.payloadKind === PAYLOAD_KIND.NOTES) {
          hasPriorNotesByRunId.add(event.scope.runId);
        }
        break;
      }
      case 'context_set': {
        // Latest context_set wins per runId (same semantics as projectRunContextV2).
        // Skip events with invalid context (non-plain-object).
        const ctx = (event as Extract<DomainEventV1, { kind: 'context_set' }>).data.context;
        if (ctx && typeof ctx === 'object' && !Array.isArray(ctx)) {
          runContextByRunId.set(event.scope.runId, ctx as JsonObject);
        }
        break;
      }
      default:
        // Silently skip unknown event kinds for forward compatibility.
        // Unknown kinds indicate a schema version this code doesn't recognize,
        // not a programming error. Do not assertNever here -- it would throw at
        // runtime for any session written by a newer server version.
        break;
    }
  }

  const lastEvent = events[events.length - 1];
  const nextEventIndex = lastEvent !== undefined ? lastEvent.eventIndex + 1 : 0;

  const data: SessionIndexData = {
    sortedEvents: events,
    runStartedByRunId,
    nodeCreatedByNodeId,
    hasChildEdgeByFromNodeId,
    advanceRecordedByDedupeKey,
    nextEventIndex,
    hasPriorNotesByRunId,
    runContextByRunId,
  };

  return data as SessionIndex;
}
