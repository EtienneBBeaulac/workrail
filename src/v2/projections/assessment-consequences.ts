import type { Result } from 'neverthrow';
import { err, ok } from 'neverthrow';
import type { DomainEventV1 } from '../durable-core/schemas/session/index.js';
import { EVENT_KIND } from '../durable-core/constants.js';
import type { ProjectionError } from './projection-error.js';

type AssessmentConsequenceAppliedEventV1 = Extract<DomainEventV1, { kind: 'assessment_consequence_applied' }>;

export interface AppliedAssessmentConsequenceViewV2 {
  readonly assessmentId: string;
  readonly attemptId: string;
  readonly trigger: AssessmentConsequenceAppliedEventV1['data']['trigger'];
  readonly effect: AssessmentConsequenceAppliedEventV1['data']['effect'];
  readonly recordedAtEventIndex: number;
}

export interface AssessmentConsequencesProjectionV2 {
  readonly byNodeId: Readonly<Record<string, readonly AppliedAssessmentConsequenceViewV2[]>>;
}

export function projectAssessmentConsequencesV2(
  events: readonly DomainEventV1[],
): Result<AssessmentConsequencesProjectionV2, ProjectionError> {
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.eventIndex < events[i - 1]!.eventIndex) {
      return err({ code: 'PROJECTION_INVARIANT_VIOLATION', message: 'Events must be sorted by eventIndex ascending' });
    }
  }

  const byNodeId: Record<string, AppliedAssessmentConsequenceViewV2[]> = {};

  for (const event of events) {
    if (event.kind !== EVENT_KIND.ASSESSMENT_CONSEQUENCE_APPLIED) continue;
    const nodeId = event.scope.nodeId;
    if (!byNodeId[nodeId]) byNodeId[nodeId] = [];
    byNodeId[nodeId]!.push({
      assessmentId: event.data.assessmentId,
      attemptId: event.data.attemptId,
      trigger: event.data.trigger,
      effect: event.data.effect,
      recordedAtEventIndex: event.eventIndex,
    });
  }

  return ok({ byNodeId });
}

export function getLatestAssessmentConsequenceForNode(
  projection: AssessmentConsequencesProjectionV2,
  nodeId: string,
): AppliedAssessmentConsequenceViewV2 | undefined {
  const consequences = projection.byNodeId[nodeId];
  return consequences && consequences.length > 0 ? consequences[consequences.length - 1] : undefined;
}
