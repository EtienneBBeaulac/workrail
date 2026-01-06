import { describe, expect, it } from 'vitest';
import { DomainEventV1Schema } from '../../../src/v2/durable-core/schemas/session/index.js';
import { buildAckAdvanceAppendPlanV1 } from '../../../src/v2/durable-core/domain/ack-advance-append-plan.js';

describe('ack-advance-append-plan', () => {
  it('advanced path remains compatible (outcome omitted)', () => {
    const res = buildAckAdvanceAppendPlanV1({
      sessionId: 'sess_01jh_test',
      runId: 'run_01jh_test',
      fromNodeId: 'node_01jh_from',
      workflowHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' as any,
      attemptId: 'att_01jh_test',
      nextEventIndex: 10,
      toNodeId: 'node_01jh_to',
      snapshotRef: 'sha256:1111111111111111111111111111111111111111111111111111111111111111' as any,
      causeKind: 'intentional_fork',
      minted: {
        advanceRecordedEventId: 'evt_01jh_adv',
        nodeCreatedEventId: 'evt_01jh_node',
        edgeCreatedEventId: 'evt_01jh_edge',
        outputEventIds: [],
      },
      outputsToAppend: [],
    });

    expect(res.isOk()).toBe(true);

    const plan = res._unsafeUnwrap();
    expect(plan.events.map((e) => e.kind)).toEqual(['advance_recorded', 'node_created', 'edge_created']);
    for (const e of plan.events) expect(() => DomainEventV1Schema.parse(e)).not.toThrow();
    expect(plan.snapshotPins.length).toBe(1);
  });

  it('blocked path emits advance_recorded only (plus extras) and no snapshotPins', () => {
    const res = buildAckAdvanceAppendPlanV1({
      sessionId: 'sess_01jh_test',
      runId: 'run_01jh_test',
      fromNodeId: 'node_01jh_from',
      workflowHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' as any,
      attemptId: 'att_01jh_test',
      nextEventIndex: 10,
      outcome: {
        kind: 'blocked',
        blockers: {
          blockers: [
            {
              code: 'MISSING_REQUIRED_OUTPUT',
              pointer: { kind: 'output_contract', contractRef: 'wr.validationCriteria' },
              message: 'Missing required output.',
            },
          ],
        },
      },
      minted: { advanceRecordedEventId: 'evt_01jh_adv' },
    });

    expect(res.isOk()).toBe(true);

    const plan = res._unsafeUnwrap();
    expect(plan.events.length).toBe(1);
    expect(plan.events[0]!.kind).toBe('advance_recorded');
    expect(() => DomainEventV1Schema.parse(plan.events[0]!)).not.toThrow();
    expect(plan.snapshotPins.length).toBe(0);
  });

  it('extraEventsToAppend are assigned sessionId + sequential eventIndex', () => {
    const res = buildAckAdvanceAppendPlanV1({
      sessionId: 'sess_01jh_test',
      runId: 'run_01jh_test',
      fromNodeId: 'node_01jh_from',
      workflowHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' as any,
      attemptId: 'att_01jh_test',
      nextEventIndex: 10,
      outcome: {
        kind: 'blocked',
        blockers: {
          blockers: [
            {
              code: 'INVARIANT_VIOLATION',
              pointer: { kind: 'context_key', key: 'slices' },
              message: 'Missing required context key.',
            },
          ],
        },
      },
      extraEventsToAppend: [
        {
          v: 1,
          eventId: 'evt_01jh_gap',
          kind: 'gap_recorded',
          dedupeKey: 'gap_recorded:sess_01jh_test:gap_01jh_test',
          scope: { runId: 'run_01jh_test', nodeId: 'node_01jh_from' },
          data: {
            gapId: 'gap_01jh_test',
            severity: 'critical',
            reason: { category: 'contract_violation', detail: 'missing_required_output' },
            summary: 'Missing required output; continuing in never-stop mode.',
            resolution: { kind: 'unresolved' },
          },
        },
      ],
      minted: { advanceRecordedEventId: 'evt_01jh_adv' },
    });

    expect(res.isOk()).toBe(true);

    const plan = res._unsafeUnwrap();
    expect(plan.events.map((e) => e.kind)).toEqual(['advance_recorded', 'gap_recorded']);
    expect(plan.events[0]!.eventIndex).toBe(10);
    expect(plan.events[1]!.eventIndex).toBe(11);
    expect(plan.events[1]!.sessionId).toBe('sess_01jh_test');
    for (const e of plan.events) expect(() => DomainEventV1Schema.parse(e)).not.toThrow();
  });
});
