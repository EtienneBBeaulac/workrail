import { describe, it, expect } from 'vitest';
import { projectAssessmentsV2, getLatestAssessmentForNode } from '../../../src/v2/projections/assessments.js';
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

    const result = projectAssessmentsV2(events);
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
    const projection = projectAssessmentsV2([
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
    ]);

    expect(projection.isOk()).toBe(true);
    if (projection.isOk()) {
      const latest = getLatestAssessmentForNode(projection.value, 'node_1');
      expect(latest?.attemptId).toBe('attempt_2');
      expect(latest?.assessmentId).toBe('risk_gate');
      expect(latest?.artifactOutputId).toBe('out_2');
    }
  });

  it('fails on unsorted events', () => {
    const result = projectAssessmentsV2([
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
