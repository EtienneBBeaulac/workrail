import type { Result } from 'neverthrow';
import { err, ok } from 'neverthrow';
import type { DomainEventV1 } from '../durable-core/schemas/session/index.js';
import { EVENT_KIND } from '../durable-core/constants.js';
import type { ProjectionError } from './projection-error.js';

type AdvanceRecordedEventV1 = Extract<DomainEventV1, { kind: 'advance_recorded' }>;

export interface NodeAdvanceOutcomeV2 {
  readonly nodeId: string;
  readonly latestAttemptId: string;
  readonly outcome: AdvanceRecordedEventV1['data']['outcome'];
  readonly recordedAtEventIndex: number;
}

export interface AdvanceOutcomesProjectionV2 {
  readonly byNodeId: Readonly<Record<string, NodeAdvanceOutcomeV2>>;
}

/**
 * Pure projection: latest advance_recorded outcome per node (latest wins by eventIndex).
 */
export function projectAdvanceOutcomesV2(events: readonly DomainEventV1[]): Result<AdvanceOutcomesProjectionV2, ProjectionError> {
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.eventIndex < events[i - 1]!.eventIndex) {
      return err({ code: 'PROJECTION_INVARIANT_VIOLATION', message: 'Events must be sorted by eventIndex ascending' });
    }
  }

  const byNodeId: Record<string, NodeAdvanceOutcomeV2> = {};

  for (const e of events) {
    if (e.kind !== EVENT_KIND.ADVANCE_RECORDED) continue;
    byNodeId[e.scope.nodeId] = {
      nodeId: e.scope.nodeId,
      latestAttemptId: e.data.attemptId,
      outcome: e.data.outcome,
      recordedAtEventIndex: e.eventIndex,
    };
  }

  return ok({ byNodeId });
}
