import { err, ok, type Result } from 'neverthrow';
import type { DomainEventV1 } from '../schemas/session/index.js';
import { EVENT_KIND } from '../constants.js';
import type { RecordedAssessmentV1 } from './assessment-record.js';

type EventToAppendV1 = Omit<DomainEventV1, 'eventIndex' | 'sessionId'>;

export type AssessmentRecordedEventError =
  | { readonly code: 'ASSESSMENT_EVENT_INVARIANT_VIOLATION'; readonly message: string };

export function buildAssessmentRecordedEvent(args: {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly artifactOutputId: string;
  readonly scope: { readonly runId: string; readonly nodeId: string };
  readonly assessment: RecordedAssessmentV1;
  readonly minted: { readonly eventId: string };
}): Result<EventToAppendV1, AssessmentRecordedEventError> {
  if (!args.sessionId) return err({ code: 'ASSESSMENT_EVENT_INVARIANT_VIOLATION', message: 'sessionId is required' });
  if (!args.attemptId) return err({ code: 'ASSESSMENT_EVENT_INVARIANT_VIOLATION', message: 'attemptId is required' });
  if (!args.artifactOutputId) return err({ code: 'ASSESSMENT_EVENT_INVARIANT_VIOLATION', message: 'artifactOutputId is required' });
  if (!args.scope.runId || !args.scope.nodeId) {
    return err({ code: 'ASSESSMENT_EVENT_INVARIANT_VIOLATION', message: 'scope.runId and scope.nodeId are required' });
  }
  if (!args.minted.eventId) return err({ code: 'ASSESSMENT_EVENT_INVARIANT_VIOLATION', message: 'minted.eventId is required' });

  return ok({
    v: 1,
    eventId: args.minted.eventId,
    kind: EVENT_KIND.ASSESSMENT_RECORDED,
    dedupeKey: `assessment_recorded:${args.sessionId}:${args.scope.nodeId}:${args.attemptId}` as DomainEventV1['dedupeKey'],
    scope: { runId: args.scope.runId, nodeId: args.scope.nodeId },
    data: {
      assessmentId: args.assessment.assessmentId,
      attemptId: args.attemptId,
      artifactOutputId: args.artifactOutputId,
      summary: args.assessment.summary,
      normalizationNotes: [...args.assessment.normalizationNotes],
      dimensions: args.assessment.dimensions.map((dimension) => ({
        dimensionId: dimension.dimensionId,
        level: dimension.level,
        normalization: dimension.normalization,
        ...(dimension.rationale ? { rationale: dimension.rationale } : {}),
      })),
    },
  } as EventToAppendV1);
}
