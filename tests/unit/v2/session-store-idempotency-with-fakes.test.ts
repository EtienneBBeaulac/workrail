/**
 * v2 Session Store Idempotency Tests (using in-memory fakes)
 *
 * This test file demonstrates how to use the centralized in-memory fakes
 * instead of real file adapters. This enables:
 * - Faster tests (no I/O)
 * - Simpler setup (no temp directory management)
 * - Focus on business logic validation
 *
 * @enforces dedupe-key-idempotent
 * @enforces dedupe-key-stable
 * @enforces append-plan-atomic
 * @enforces ack-idempotency-key
 * @enforces ack-replay-idempotent
 * @enforces test-fakes-usage
 */

import { describe, it, expect } from 'vitest';
import { InMemorySessionEventLogStore, InMemorySessionLock } from '../../fakes/v2/index.js';
import { ExecutionSessionGateV2 } from '../../../src/v2/usecases/execution-session-gate.js';
import { asSessionId, asEventId } from '../../../src/v2/durable-core/ids/index.js';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';

/**
 * Session store idempotency invariants (using fakes).
 *
 * These tests use in-memory fakes to verify append invariants
 * without requiring filesystem I/O or temporary directories.
 */
describe('Session store idempotency with fakes (all-or-nothing)', () => {
  it('rejects partial idempotency (some events exist, some do not)', async () => {
    // Setup: use in-memory fakes instead of real adapters
    const sessionStore = new InMemorySessionEventLogStore();
    const lockPort = new InMemorySessionLock();
    const gate = new ExecutionSessionGateV2(lockPort, sessionStore);

    const sessionId = asSessionId('sess_partial_test_fake');

    const event1: DomainEventV1 = {
      v: 1,
      eventId: asEventId('evt_1'),
      eventIndex: 0,
      sessionId,
      kind: 'session_created',
      dedupeKey: 'session_created:sess_partial_test_fake',
      data: {},
    };

    const event2: DomainEventV1 = {
      v: 1,
      eventId: asEventId('evt_2'),
      eventIndex: 1,
      sessionId,
      kind: 'run_started',
      dedupeKey: 'run_started:sess_partial_test_fake:run_1',
      scope: { runId: 'run_1' },
      data: {
        workflowId: 'test',
        workflowHash: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
        workflowSourceKind: 'project',
        workflowSourceRef: 'test',
      },
    };

    // First append: events [1, 2]
    const res1 = await gate.withHealthySessionLock(sessionId, (lock) =>
      sessionStore.append(lock, {
        events: [event1, event2],
        snapshotPins: [],
      })
    );
    expect(res1.isOk()).toBe(true);

    const event3: DomainEventV1 = {
      v: 1,
      eventId: asEventId('evt_3'),
      eventIndex: 2,
      sessionId,
      kind: 'observation_recorded',
      dedupeKey: 'observation_recorded:sess_partial_test_fake:git_branch:abc123',
      data: {
        key: 'git_branch',
        value: { type: 'short_string', value: 'main' },
        confidence: 'high',
      },
    };

    // Second append: events [1, 3] (event1 exists, event3 doesn't)
    // This should fail with INVARIANT_VIOLATION
    const res2 = await gate.withHealthySessionLock(sessionId, (lock) =>
      sessionStore.append(lock, {
        events: [event1, event3],
        snapshotPins: [],
      })
    );

    expect(res2.isErr()).toBe(true);
    expect(res2._unsafeUnwrapErr().code).toBe('SESSION_STORE_INVARIANT_VIOLATION');
  });

  it('allows full idempotent replay (all events exist)', async () => {
    const sessionStore = new InMemorySessionEventLogStore();
    const lockPort = new InMemorySessionLock();
    const gate = new ExecutionSessionGateV2(lockPort, sessionStore);

    const sessionId = asSessionId('sess_full_test_fake');

    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: asEventId('evt_1'),
        eventIndex: 0,
        sessionId,
        kind: 'session_created',
        dedupeKey: 'session_created:sess_full_test_fake',
        data: {},
      },
    ];

    // First append
    const res1 = await gate.withHealthySessionLock(sessionId, (lock) =>
      sessionStore.append(lock, { events, snapshotPins: [] })
    );
    expect(res1.isOk()).toBe(true);

    // Second append (full replay of same events) - should succeed (no-op)
    const res2 = await gate.withHealthySessionLock(sessionId, (lock) =>
      sessionStore.append(lock, { events, snapshotPins: [] })
    );
    expect(res2.isOk()).toBe(true);

    // Verify only one event in store
    const loaded = await sessionStore.load(sessionId);
    expect(loaded.isOk()).toBe(true);
    expect(loaded._unsafeUnwrap().events).toHaveLength(1);
  });

  it('enforces event ordering: rejects out-of-sequence eventIndex', async () => {
    const sessionStore = new InMemorySessionEventLogStore();
    const lockPort = new InMemorySessionLock();
    const gate = new ExecutionSessionGateV2(lockPort, sessionStore);

    const sessionId = asSessionId('sess_order_test_fake');

    const event0: DomainEventV1 = {
      v: 1,
      eventId: asEventId('evt_0'),
      eventIndex: 0,
      sessionId,
      kind: 'session_created',
      dedupeKey: 'sk_0',
      data: {},
    };

    // Try to append event with non-contiguous index (skip to index 5)
    const badEvent: DomainEventV1 = {
      v: 1,
      eventId: asEventId('evt_bad'),
      eventIndex: 5,
      sessionId,
      kind: 'run_started',
      dedupeKey: 'sk_bad',
      scope: { runId: 'run_1' },
      data: {
        workflowId: 'test',
        workflowHash: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
        workflowSourceKind: 'project',
        workflowSourceRef: 'test',
      },
    };

    const result = await gate.withHealthySessionLock(sessionId, (lock) =>
      sessionStore.append(lock, { events: [event0, badEvent], snapshotPins: [] })
    );

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error.code).toBe('SESSION_STORE_INVARIANT_VIOLATION');
  });

  it('is idempotent: replaying same dedupeKeys is no-op', async () => {
    const sessionStore = new InMemorySessionEventLogStore();
    const lockPort = new InMemorySessionLock();
    const gate = new ExecutionSessionGateV2(lockPort, sessionStore);

    const sessionId = asSessionId('sess_idem_test_fake');

    const event0: DomainEventV1 = {
      v: 1,
      eventId: asEventId('evt_0'),
      eventIndex: 0,
      sessionId,
      kind: 'session_created',
      dedupeKey: 'sk_0',
      data: {},
    };

    // First append
    const result1 = await gate.withHealthySessionLock(sessionId, (lock) =>
      sessionStore.append(lock, { events: [event0], snapshotPins: [] })
    );
    expect(result1.isOk()).toBe(true);

    // Second append (same dedupeKey) should be no-op
    const result2 = await gate.withHealthySessionLock(sessionId, (lock) =>
      sessionStore.append(lock, { events: [event0], snapshotPins: [] })
    );
    expect(result2.isOk()).toBe(true);

    // Verify store still has only one event
    const loaded = await sessionStore.load(sessionId);
    expect(loaded._unsafeUnwrap().events).toHaveLength(1);
  });
});
