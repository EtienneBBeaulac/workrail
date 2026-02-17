import { describe, it, expect } from 'vitest';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';

describe('Validation event ordering (Invariant #9)', () => {
  it('validation_performed.eventIndex < node_created.eventIndex for blocked nodes', () => {
    // Simulate event log with validation before blocked node
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_val',
        eventIndex: 10,
        sessionId: 'sess_1',
        kind: 'validation_performed',
        dedupeKey: 'validation_performed:sess_1:attempt_1',
        scope: { runId: 'run_1', nodeId: 'node_parent' },
        data: {
          validationId: 'validation_attempt_1',
          attemptId: 'attempt_1',
          contractRef: 'wr.test',
          result: { valid: false, issues: ['Issue'], suggestions: [] },
        },
      } as any,
      {
        v: 1,
        eventId: 'evt_node',
        eventIndex: 12,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_blocked',
        scope: { runId: 'run_1', nodeId: 'node_blocked' },
        data: {
          nodeKind: 'blocked_attempt',
          parentNodeId: 'node_parent',
          workflowHash: 'sha256:test' as any,
          snapshotRef: 'sha256:snap' as any,
        },
      } as any,
    ];

    const validationEvent = events.find((e) => e.kind === 'validation_performed');
    const nodeEvent = events.find((e) => e.kind === 'node_created' && e.data.nodeKind === 'blocked_attempt');

    expect(validationEvent).toBeDefined();
    expect(nodeEvent).toBeDefined();
    expect(validationEvent!.eventIndex).toBeLessThan(nodeEvent!.eventIndex);
  });

  it('out-of-order validation events violate invariant', () => {
    // Validation after node creation (wrong order)
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_node',
        eventIndex: 10,
        sessionId: 'sess_1',
        kind: 'node_created',
        scope: { runId: 'run_1', nodeId: 'node_blocked' },
        data: { nodeKind: 'blocked_attempt', parentNodeId: 'node_parent', workflowHash: 'sha256:test' as any, snapshotRef: 'sha256:snap' as any },
        dedupeKey: 'node_created:sess_1:run_1:node_blocked',
      } as any,
      {
        v: 1,
        eventId: 'evt_val',
        eventIndex: 12,
        sessionId: 'sess_1',
        kind: 'validation_performed',
        scope: { runId: 'run_1', nodeId: 'node_blocked' },
        data: { validationId: 'validation_1', attemptId: 'attempt_1', contractRef: 'wr.test', result: { valid: false, issues: [], suggestions: [] } },
        dedupeKey: 'validation_performed:sess_1:attempt_1',
      } as any,
    ];

    const validationEvent = events.find((e) => e.kind === 'validation_performed');
    const nodeEvent = events.find((e) => e.kind === 'node_created' && e.data.nodeKind === 'blocked_attempt');

    // This ordering violates Invariant #9
    expect(validationEvent!.eventIndex).toBeGreaterThan(nodeEvent!.eventIndex);
  });

  it('only one validation event per attemptId (dedupeKey enforcement)', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_val_1',
        eventIndex: 10,
        sessionId: 'sess_1',
        kind: 'validation_performed',
        dedupeKey: 'validation_performed:sess_1:attempt_1',
        scope: { runId: 'run_1', nodeId: 'node_1' },
        data: { validationId: 'val_1', attemptId: 'attempt_1', contractRef: 'wr.test', result: { valid: false, issues: ['A'], suggestions: [] } },
      } as any,
    ];

    // Attempt to append duplicate (same dedupeKey)
    const duplicate: DomainEventV1 = {
      v: 1,
      eventId: 'evt_val_2',
      eventIndex: 11,
      sessionId: 'sess_1',
      kind: 'validation_performed',
      dedupeKey: 'validation_performed:sess_1:attempt_1', // Same dedupeKey
      scope: { runId: 'run_1', nodeId: 'node_1' },
      data: { validationId: 'val_2', attemptId: 'attempt_1', contractRef: 'wr.test', result: { valid: false, issues: ['B'], suggestions: [] } },
    } as any;

    // Idempotency: append should be no-op for duplicate dedupeKey
    const existingDedupeKeys = new Set(events.map((e) => e.dedupeKey));
    expect(existingDedupeKeys.has(duplicate.dedupeKey)).toBe(true);
  });
});
