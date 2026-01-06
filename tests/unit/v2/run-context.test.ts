import { describe, it, expect } from 'vitest';
import { projectRunContextV2 } from '../../../src/v2/projections/run-context.js';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';

describe('projectRunContextV2', () => {
  it('returns empty projection for no context_set events', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_0',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'session_created',
        dedupeKey: 'session_created:sess_1',
        data: {},
      } as DomainEventV1,
    ];

    const result = projectRunContextV2(events);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.byRunId).toEqual({});
    }
  });

  it('projects latest context_set per runId', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_0',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'context_set',
        dedupeKey: 'context_set:sess_1:run_1:ctx_1',
        scope: { runId: 'run_1' },
        data: {
          contextId: 'ctx_1',
          context: { ticketId: 'AUTH-123', complexity: 'Standard' },
          source: 'initial',
        },
      } as DomainEventV1,
      {
        v: 1,
        eventId: 'evt_1',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'context_set',
        dedupeKey: 'context_set:sess_1:run_1:ctx_2',
        scope: { runId: 'run_1' },
        data: {
          contextId: 'ctx_2',
          context: { ticketId: 'AUTH-123', complexity: 'Standard', featureFlag: true },
          source: 'agent_delta',
        },
      } as DomainEventV1,
    ];

    const result = projectRunContextV2(events);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.byRunId['run_1']).toEqual({
        runId: 'run_1',
        context: { ticketId: 'AUTH-123', complexity: 'Standard', featureFlag: true },
        contextId: 'ctx_2',
        source: 'agent_delta',
        setAtEventIndex: 1,
      });
    }
  });

  it('handles multiple runs independently', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_0',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'context_set',
        dedupeKey: 'context_set:sess_1:run_1:ctx_1',
        scope: { runId: 'run_1' },
        data: {
          contextId: 'ctx_1',
          context: { a: 1 },
          source: 'initial',
        },
      } as DomainEventV1,
      {
        v: 1,
        eventId: 'evt_1',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'context_set',
        dedupeKey: 'context_set:sess_1:run_2:ctx_2',
        scope: { runId: 'run_2' },
        data: {
          contextId: 'ctx_2',
          context: { b: 2 },
          source: 'initial',
        },
      } as DomainEventV1,
    ];

    const result = projectRunContextV2(events);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.byRunId['run_1']?.context).toEqual({ a: 1 });
      expect(result.value.byRunId['run_2']?.context).toEqual({ b: 2 });
    }
  });

  it('rejects unsorted events', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_1',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'context_set',
        scope: { runId: 'run_1' },
        data: { contextId: 'ctx_1', context: {}, source: 'initial' },
        dedupeKey: 'context_set:sess_1:run_1:ctx_1',
      } as DomainEventV1,
      {
        v: 1,
        eventId: 'evt_0',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'session_created',
        dedupeKey: 'session_created:sess_1',
        data: {},
      } as DomainEventV1,
    ];

    const result = projectRunContextV2(events);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('PROJECTION_INVARIANT_VIOLATION');
      expect(result.error.message).toContain('sorted by eventIndex');
    }
  });

  it('rejects invalid context type (null)', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_0',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'context_set',
        dedupeKey: 'context_set:sess_1:run_1:ctx_1',
        scope: { runId: 'run_1' },
        data: {
          contextId: 'ctx_1',
          context: null as any,
          source: 'initial',
        },
      } as DomainEventV1,
    ];

    const result = projectRunContextV2(events);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('PROJECTION_CORRUPTION_DETECTED');
      expect(result.error.message).toContain('invalid context type');
    }
  });

  it('rejects invalid context type (array)', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_0',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'context_set',
        dedupeKey: 'context_set:sess_1:run_1:ctx_1',
        scope: { runId: 'run_1' },
        data: {
          contextId: 'ctx_1',
          context: [] as any,
          source: 'initial',
        },
      } as DomainEventV1,
    ];

    const result = projectRunContextV2(events);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('PROJECTION_CORRUPTION_DETECTED');
    }
  });
});
