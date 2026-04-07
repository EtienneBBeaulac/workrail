import type { Result } from 'neverthrow';
import { ok } from 'neverthrow';
import type { DomainEventV1 } from '../durable-core/schemas/session/index.js';
import type { SortedEventLog } from '../durable-core/sorted-event-log.js';
import { EVENT_KIND } from '../durable-core/constants.js';
import type { ProjectionError } from './projection-error.js';

type AssessmentRecordedEventV1 = Extract<DomainEventV1, { kind: 'assessment_recorded' }>;

export interface RecordedAssessmentViewV2 {
  readonly assessmentId: string;
  readonly attemptId: string;
  readonly artifactOutputId: string;
  readonly summary?: string;
  readonly normalizationNotes: readonly string[];
  readonly dimensions: AssessmentRecordedEventV1['data']['dimensions'];
  readonly recordedAtEventIndex: number;
}

export interface AssessmentsProjectionV2 {
  readonly byNodeId: Readonly<Record<string, readonly RecordedAssessmentViewV2[]>>;
}

export function projectAssessmentsV2(events: SortedEventLog): Result<AssessmentsProjectionV2, ProjectionError> {
  // Sort order is guaranteed by the SortedEventLog brand (validated once at boundary via asSortedEventLog).

  // Fast-path: skip the full scan when no assessment events exist (the common case).
  if (!events.some((e) => e.kind === EVENT_KIND.ASSESSMENT_RECORDED)) {
    return ok({ byNodeId: {} });
  }

  const byNodeId: Record<string, RecordedAssessmentViewV2[]> = {};

  for (const event of events) {
    if (event.kind !== EVENT_KIND.ASSESSMENT_RECORDED) continue;
    const nodeId = event.scope.nodeId;
    if (!byNodeId[nodeId]) byNodeId[nodeId] = [];
    byNodeId[nodeId]!.push({
      assessmentId: event.data.assessmentId,
      attemptId: event.data.attemptId,
      artifactOutputId: event.data.artifactOutputId,
      summary: event.data.summary,
      normalizationNotes: event.data.normalizationNotes,
      dimensions: event.data.dimensions,
      recordedAtEventIndex: event.eventIndex,
    });
  }

  return ok({ byNodeId });
}

export function getLatestAssessmentForNode(
  projection: AssessmentsProjectionV2,
  nodeId: string,
): RecordedAssessmentViewV2 | undefined {
  const assessments = projection.byNodeId[nodeId];
  return assessments && assessments.length > 0 ? assessments[assessments.length - 1] : undefined;
}
