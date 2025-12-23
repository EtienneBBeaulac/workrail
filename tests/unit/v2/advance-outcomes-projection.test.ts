import { describe, it, expect } from 'vitest';
import { projectAdvanceOutcomesV2 } from '../../../src/v2/projections/advance-outcomes.js';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';

describe('v2 advance outcomes projection', () => {
  it('uses latest-wins by eventIndex per node', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_adv_1',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'advance_recorded',
        dedupeKey: 'advance_recorded:sess_1:node_1:attempt_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          attemptId: 'attempt_1',
          intent: 'ack_pending',
          outcome: {
            kind: 'blocked',
            blockers: {
              blockers: [
                {
                  code: 'MISSING_REQUIRED_OUTPUT',
                  pointer: { kind: 'output_contract', contractRef: 'wr.contracts.example' },
                  message: 'Missing required output',
                },
              ],
            },
          },
        },
      },
      {
        v: 1,
        eventId: 'evt_adv_2',
        eventIndex: 2,
        sessionId: 'sess_1',
        kind: 'advance_recorded',
        dedupeKey: 'advance_recorded:sess_1:node_1:attempt_2',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: {
          attemptId: 'attempt_2',
          intent: 'ack_pending',
          outcome: { kind: 'advanced', toNodeId: 'node_2' },
        },
      },
    ];

    const res = projectAdvanceOutcomesV2(events);
    expect(res.isOk()).toBe(true);
    const projected = res._unsafeUnwrap();
    expect(projected.byNodeId['node_1']!.latestAttemptId).toBe('attempt_2');
    expect(projected.byNodeId['node_1']!.outcome.kind).toBe('advanced');
  });
});
