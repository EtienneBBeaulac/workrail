import { err, ok, type Result } from 'neverthrow';
import type { DomainEventV1 } from '../schemas/session/index.js';
import { EVENT_KIND } from '../constants.js';

type EventToAppendV1 = Omit<DomainEventV1, 'eventIndex' | 'sessionId'>;

export type AssessmentConsequenceEventError =
  | { readonly code: 'ASSESSMENT_CONSEQUENCE_EVENT_INVARIANT_VIOLATION'; readonly message: string };

export function buildAssessmentConsequenceAppliedEvent(args: {
  readonly sessionId: string;
  readonly attemptId: string;
  readonly scope: { readonly runId: string; readonly nodeId: string };
  readonly assessmentId: string;
  readonly dimensionId: string;
  readonly level: string;
  readonly guidance: string;
  readonly minted: { readonly eventId: string };
}): Result<EventToAppendV1, AssessmentConsequenceEventError> {
  if (!args.sessionId) return err({ code: 'ASSESSMENT_CONSEQUENCE_EVENT_INVARIANT_VIOLATION', message: 'sessionId is required' });
  if (!args.attemptId) return err({ code: 'ASSESSMENT_CONSEQUENCE_EVENT_INVARIANT_VIOLATION', message: 'attemptId is required' });
  if (!args.scope.runId || !args.scope.nodeId) {
    return err({ code: 'ASSESSMENT_CONSEQUENCE_EVENT_INVARIANT_VIOLATION', message: 'scope.runId and scope.nodeId are required' });
  }
  if (!args.assessmentId || !args.dimensionId || !args.level || !args.guidance) {
    return err({ code: 'ASSESSMENT_CONSEQUENCE_EVENT_INVARIANT_VIOLATION', message: 'assessment consequence fields are required' });
  }

  return ok({
    v: 1,
    eventId: args.minted.eventId,
    kind: EVENT_KIND.ASSESSMENT_CONSEQUENCE_APPLIED,
    dedupeKey: `assessment_consequence_applied:${args.sessionId}:${args.scope.nodeId}:${args.attemptId}` as DomainEventV1['dedupeKey'],
    scope: { runId: args.scope.runId, nodeId: args.scope.nodeId },
    data: {
      attemptId: args.attemptId,
      assessmentId: args.assessmentId,
      trigger: {
        dimensionId: args.dimensionId,
        level: args.level,
      },
      effect: {
        kind: 'require_followup',
        guidance: args.guidance,
      },
    },
  } as EventToAppendV1);
}
