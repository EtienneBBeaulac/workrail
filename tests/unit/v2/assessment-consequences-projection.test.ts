import { describe, it, expect } from 'vitest';
import {
  projectAssessmentConsequencesV2,
  getLatestAssessmentConsequenceForNode,
} from '../../../src/v2/projections/assessment-consequences.js';
import { asSortedEventLog } from '../../../src/v2/durable-core/sorted-event-log.js';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';

function createAssessmentConsequenceAppliedEvent(args: {
  eventIndex: number;
  nodeId: string;
  attemptId: string;
  assessmentId?: string;
  dimensionId?: string;
  level?: string;
  guidance?: string;
}): DomainEventV1 {
  return {
    v: 1,
    eventId: `evt_${args.eventIndex}`,
    eventIndex: args.eventIndex,
    sessionId: 'sess_1',
    kind: 'assessment_consequence_applied',
    dedupeKey: `assessment_consequence_applied:sess_1:${args.nodeId}:${args.attemptId}`,
    scope: { runId: 'run_1', nodeId: args.nodeId },
    data: {
      attemptId: args.attemptId,
      assessmentId: args.assessmentId ?? 'readiness_gate',
      trigger: {
        dimensionId: args.dimensionId ?? 'confidence',
        level: args.level ?? 'low',
      },
      effect: {
        kind: 'require_followup',
        guidance: args.guidance ?? 'Gather more context before proceeding.',
      },
    },
  } as unknown as DomainEventV1;
}

describe('projectAssessmentConsequencesV2', () => {
  it('projects applied assessment consequences by node', () => {
    const sortedRes = asSortedEventLog([
      createAssessmentConsequenceAppliedEvent({
        eventIndex: 0,
        nodeId: 'node_1',
        attemptId: 'attempt_1',
      }),
      createAssessmentConsequenceAppliedEvent({
        eventIndex: 1,
        nodeId: 'node_2',
        attemptId: 'attempt_2',
        guidance: 'Inspect the boundary files before retrying.',
      }),
    ]);

    expect(sortedRes.isOk()).toBe(true);
    const result = projectAssessmentConsequencesV2(sortedRes._unsafeUnwrap());

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.byNodeId['node_1']).toHaveLength(1);
      expect(result.value.byNodeId['node_2']![0]!.effect.guidance).toBe('Inspect the boundary files before retrying.');
    }
  });

  it('returns latest applied consequence for a node', () => {
    const sortedRes = asSortedEventLog([
      createAssessmentConsequenceAppliedEvent({
        eventIndex: 0,
        nodeId: 'node_1',
        attemptId: 'attempt_1',
        assessmentId: 'readiness_gate',
      }),
      createAssessmentConsequenceAppliedEvent({
        eventIndex: 1,
        nodeId: 'node_1',
        attemptId: 'attempt_2',
        assessmentId: 'risk_gate',
        dimensionId: 'scope',
      }),
    ]);

    expect(sortedRes.isOk()).toBe(true);
    const result = projectAssessmentConsequencesV2(sortedRes._unsafeUnwrap());

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const latest = getLatestAssessmentConsequenceForNode(result.value, 'node_1');
      expect(latest?.attemptId).toBe('attempt_2');
      expect(latest?.assessmentId).toBe('risk_gate');
      expect(latest?.trigger.dimensionId).toBe('scope');
    }
  });

  it('rejects unsorted events at the boundary (asSortedEventLog)', () => {
    const sortedRes = asSortedEventLog([
      createAssessmentConsequenceAppliedEvent({
        eventIndex: 2,
        nodeId: 'node_1',
        attemptId: 'attempt_2',
      }),
      createAssessmentConsequenceAppliedEvent({
        eventIndex: 1,
        nodeId: 'node_1',
        attemptId: 'attempt_1',
      }),
    ]);

    expect(sortedRes.isErr()).toBe(true);
    if (sortedRes.isErr()) {
      expect(sortedRes.error.code).toBe('PROJECTION_INVARIANT_VIOLATION');
    }
  });
});
