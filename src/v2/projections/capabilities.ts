import type { Result } from 'neverthrow';
import { err, ok } from 'neverthrow';
import type { DomainEventV1 } from '../durable-core/schemas/session/index.js';
import { EVENT_KIND } from '../durable-core/constants.js';
import type { ProjectionError } from './projection-error.js';

/**
 * Closed set: Capability (delegation | web_browsing).
 *
 * Lock: docs/reference/workflow-execution-contract.md (Optional capabilities)
 *
 * Why closed:
 * - Capabilities are workflow-shaping enhancements, not "any tool"
 * - Prevents capability sprawl and keeps Studio UX deterministic
 *
 * Values:
 * - `delegation`: parallel task delegation via subagents
 * - `web_browsing`: external knowledge lookup
 */
export type CapabilityV2 = 'delegation' | 'web_browsing';

/**
 * Closed set: CapabilityStatus (unknown | available | unavailable).
 *
 * Lock: observed status is a deterministic state machine (latest observation wins by eventIndex).
 *
 * Why closed:
 * - Avoids ambiguous states and keeps projections exhaustive
 *
 * Values:
 * - `unknown`: not yet probed/attempted
 * - `available`: observed working (probe or attempted use success)
 * - `unavailable`: observed failing (probe or attempted use failure)
 */
export type CapabilityStatusV2 = 'unknown' | 'available' | 'unavailable';

type CapabilityObservedEventV1 = Extract<DomainEventV1, { kind: 'capability_observed' }>;

export interface CapabilityObservationV2 {
  readonly status: CapabilityStatusV2;
  readonly provenance: CapabilityObservedEventV1['data']['provenance'];
  readonly observedAtEventIndex: number;
}

export interface NodeCapabilitiesViewV2 {
  readonly byCapability: Readonly<Record<CapabilityV2, CapabilityObservationV2 | null>>;
}

export interface CapabilitiesProjectionV2 {
  readonly nodesById: Readonly<Record<string, NodeCapabilitiesViewV2>>;
}

/**
 * Pure projection: derive node capability status ("latest wins by eventIndex").
 *
 * Locked intent:
 * - append-only history, latest by EventIndex is effective
 * - deterministic
 */
export function projectCapabilitiesV2(events: readonly DomainEventV1[]): Result<CapabilitiesProjectionV2, ProjectionError> {
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.eventIndex < events[i - 1]!.eventIndex) {
      return err({ code: 'PROJECTION_INVARIANT_VIOLATION', message: 'Events must be sorted by eventIndex ascending' });
    }
  }

  type MutableNode = { byCapability: Record<CapabilityV2, CapabilityObservationV2 | null> };
  const nodes: Record<string, MutableNode> = {};

  const ensure = (nodeId: string): MutableNode => {
    const existing = nodes[nodeId];
    if (existing) return existing;
    const created: MutableNode = { byCapability: { delegation: null, web_browsing: null } };
    nodes[nodeId] = created;
    return created;
  };

  for (const e of events) {
    if (e.kind !== EVENT_KIND.CAPABILITY_OBSERVED) continue;

    const nodeId = e.scope.nodeId;
    const cap = e.data.capability as CapabilityV2;

    const observation: CapabilityObservationV2 = {
      status: e.data.status as CapabilityStatusV2,
      provenance: e.data.provenance,
      observedAtEventIndex: e.eventIndex,
    };

    // Latest-wins by eventIndex (we scan ascending, so overwrite is deterministic).
    ensure(nodeId).byCapability[cap] = observation;
  }

  return ok({ nodesById: nodes });
}
