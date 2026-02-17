import { describe, expect, it } from 'vitest';
import { DomainEventV1Schema } from '../../../src/v2/durable-core/schemas/session/index.js';
import { buildAckAdvanceAppendPlanV1 } from '../../../src/v2/durable-core/domain/ack-advance-append-plan.js';

describe('ack-advance-append-plan', () => {
  it('advanced path remains compatible (explicit outcome)', () => {
    const res = buildAckAdvanceAppendPlanV1({
      sessionId: 'sess_01jh_test',
      runId: 'run_01jh_test',
      fromNodeId: 'node_01jh_from',
      workflowHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' as any,
      attemptId: 'att_01jh_test',
      nextEventIndex: 10,
      outcome: { kind: 'advanced', toNodeId: 'node_01jh_to' },
      toNodeId: 'node_01jh_to',
      toNodeKind: 'step',
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

  it('blocked_attempt path creates node + edge with nodeKind=blocked_attempt', () => {
    const res = buildAckAdvanceAppendPlanV1({
      sessionId: 'sess_01jh_test',
      runId: 'run_01jh_test',
      fromNodeId: 'node_01jh_from',
      workflowHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' as any,
      attemptId: 'att_01jh_test',
      nextEventIndex: 10,
      outcome: { kind: 'advanced', toNodeId: 'node_01jh_blocked' },
      toNodeId: 'node_01jh_blocked',
      toNodeKind: 'blocked_attempt',
      snapshotRef: 'sha256:2222222222222222222222222222222222222222222222222222222222222222' as any,
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

    // blocked_attempt node has correct nodeKind
    const nodeCreated = plan.events.find((e) => e.kind === 'node_created') as any;
    expect(nodeCreated.data.nodeKind).toBe('blocked_attempt');
    expect(plan.snapshotPins.length).toBe(1);
  });

  it('extraEventsToAppend are assigned sessionId + sequential eventIndex', () => {
    const res = buildAckAdvanceAppendPlanV1({
      sessionId: 'sess_01jh_test',
      runId: 'run_01jh_test',
      fromNodeId: 'node_01jh_from',
      workflowHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' as any,
      attemptId: 'att_01jh_test',
      nextEventIndex: 10,
      outcome: { kind: 'advanced', toNodeId: 'node_01jh_to' },
      toNodeId: 'node_01jh_to',
      toNodeKind: 'step',
      snapshotRef: 'sha256:3333333333333333333333333333333333333333333333333333333333333333' as any,
      causeKind: 'intentional_fork',
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
    // advance_recorded, gap_recorded (extra), node_created, edge_created
    expect(plan.events.map((e) => e.kind)).toEqual(['advance_recorded', 'gap_recorded', 'node_created', 'edge_created']);
    expect(plan.events[0]!.eventIndex).toBe(10);
    expect(plan.events[1]!.eventIndex).toBe(11);
    expect(plan.events[1]!.sessionId).toBe('sess_01jh_test');
    for (const e of plan.events) expect(() => DomainEventV1Schema.parse(e)).not.toThrow();
  });
});
