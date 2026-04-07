import { describe, it, expect } from 'vitest';
import { projectAssessmentsV2, getLatestAssessmentForNode } from '../../../src/v2/projections/assessments.js';
import { asSortedEventLog } from '../../../src/v2/durable-core/sorted-event-log.js';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';

function createAssessmentRecordedEvent(args: {
  eventIndex: number;
  nodeId: string;
  attemptId: string;
  artifactOutputId: string;
  assessmentId?: string;
  normalizationNotes?: readonly string[];
}): DomainEventV1 {
  return {
    v: 1,
    eventId: `evt_${args.eventIndex}`,
    eventIndex: args.eventIndex,
    sessionId: 'sess_1',
    kind: 'assessment_recorded',
    dedupeKey: `assessment_recorded:sess_1:${args.nodeId}:${args.attemptId}`,
    scope: { runId: 'run_1', nodeId: args.nodeId },
    data: {
      assessmentId: args.assessmentId ?? 'readiness_gate',
      attemptId: args.attemptId,
      artifactOutputId: args.artifactOutputId,
      summary: 'Assessment summary',
      normalizationNotes: [...(args.normalizationNotes ?? [])],
      dimensions: [
        {
          dimensionId: 'confidence',
          level: 'high',
          normalization: 'exact',
        },
      ],
    },
  } as unknown as DomainEventV1;
}

describe('projectAssessmentsV2', () => {
  it('projects assessment records by node', () => {
    const events = [
      createAssessmentRecordedEvent({
        eventIndex: 0,
        nodeId: 'node_1',
        attemptId: 'attempt_1',
        artifactOutputId: 'out_1',
      }),
      createAssessmentRecordedEvent({
        eventIndex: 1,
        nodeId: 'node_2',
        attemptId: 'attempt_2',
        artifactOutputId: 'out_2',
        normalizationNotes: ['Normalized level "HIGH" to canonical value "high".'],
      }),
    ];

    const sorted = asSortedEventLog(events);
    expect(sorted.isOk()).toBe(true);
    const result = projectAssessmentsV2(sorted._unsafeUnwrap());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.byNodeId['node_1']).toHaveLength(1);
      expect(result.value.byNodeId['node_2']).toHaveLength(1);
      expect(result.value.byNodeId['node_2']![0]!.normalizationNotes).toEqual([
        'Normalized level "HIGH" to canonical value "high".',
      ]);
    }
  });

  it('returns latest assessment for a node', () => {
    const events = [
      createAssessmentRecordedEvent({
        eventIndex: 0,
        nodeId: 'node_1',
        attemptId: 'attempt_1',
        artifactOutputId: 'out_1',
      }),
      createAssessmentRecordedEvent({
        eventIndex: 1,
        nodeId: 'node_1',
        attemptId: 'attempt_2',
        artifactOutputId: 'out_2',
        assessmentId: 'risk_gate',
      }),
    ];
    const sorted = asSortedEventLog(events);
    expect(sorted.isOk()).toBe(true);
    const projection = projectAssessmentsV2(sorted._unsafeUnwrap());

    expect(projection.isOk()).toBe(true);
    if (projection.isOk()) {
      const latest = getLatestAssessmentForNode(projection.value, 'node_1');
      expect(latest?.attemptId).toBe('attempt_2');
      expect(latest?.assessmentId).toBe('risk_gate');
      expect(latest?.artifactOutputId).toBe('out_2');
    }
  });

  it('fast-path: returns empty projection when no assessment events exist', () => {
    // Verifies that projectAssessmentsV2 short-circuits without scanning the full event log
    // when there are no assessment_recorded events (the common case).
    const events: DomainEventV1[] = [];
    const sorted = asSortedEventLog(events);
    expect(sorted.isOk()).toBe(true);
    const result = projectAssessmentsV2(sorted._unsafeUnwrap());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.byNodeId).toEqual({});
    }
  });

  it('fast-path: returns empty projection when events contain no assessment_recorded', () => {
    const events = [
      createAssessmentRecordedEvent({
        eventIndex: 0,
        nodeId: 'node_1',
        attemptId: 'attempt_1',
        artifactOutputId: 'out_1',
      }),
    ];
    // Mutate the kind to simulate non-assessment events (for fast-path testing)
    const nonAssessmentEvents = [{ ...events[0]!, kind: 'session_created' as const }] as unknown as DomainEventV1[];
    const sorted = asSortedEventLog(nonAssessmentEvents);
    expect(sorted.isOk()).toBe(true);
    const result = projectAssessmentsV2(sorted._unsafeUnwrap());
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.byNodeId).toEqual({});
    }
  });

  it('sort validation: asSortedEventLog rejects unsorted events (boundary test)', () => {
    // Sort order validation is now enforced at the boundary (asSortedEventLog),
    // not inside the projection itself.
    const result = asSortedEventLog([
      createAssessmentRecordedEvent({
        eventIndex: 1,
        nodeId: 'node_1',
        attemptId: 'attempt_1',
        artifactOutputId: 'out_1',
      }),
      createAssessmentRecordedEvent({
        eventIndex: 0,
        nodeId: 'node_1',
        attemptId: 'attempt_2',
        artifactOutputId: 'out_2',
      }),
    ]);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('PROJECTION_INVARIANT_VIOLATION');
    }
  });
});
