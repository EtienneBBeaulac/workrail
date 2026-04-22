/**
 * Test factory for DomainEventV1 objects.
 *
 * WHY: Making timestampMs required in DomainEventEnvelopeV1Schema means every
 * typed DomainEventV1 test fixture must include it. This factory provides a
 * canonical set of defaults so future tests don't need to specify timestampMs
 * (or other boilerplate fields) when the test doesn't care about their values.
 *
 * Usage:
 *   makeTestEvent({ kind: 'run_started', eventIndex: 0, data: { ... } })
 *
 * For tests that need type-narrowed event kinds (e.g., accessing data.snapshotRef
 * on a node_created event), add timestampMs: Date.now() directly to the inline
 * object literal instead of using this factory.
 */

import type { DomainEventV1 } from '../../src/v2/durable-core/schemas/session/index.js';

/**
 * Create a minimal valid DomainEventV1 with sensible defaults.
 *
 * Defaults:
 *   v: 1
 *   eventId: 'evt_test'
 *   eventIndex: 0
 *   sessionId: 'sess_test'
 *   kind: 'session_created'
 *   dedupeKey: 'test:session_created:0'
 *   data: {}
 *   timestampMs: Date.now()
 *
 * The returned object is cast to DomainEventV1 via type assertion because
 * Partial<DomainEventV1> loses discriminant narrowing. This factory is for
 * tests that do not need kind-specific TypeScript narrowing on the result.
 */
export function makeTestEvent(overrides: Record<string, unknown> = {}): DomainEventV1 {
  return {
    v: 1,
    eventId: 'evt_test',
    eventIndex: 0,
    sessionId: 'sess_test',
    kind: 'session_created' as const,
    dedupeKey: 'test:session_created:0',
    data: {},
    timestampMs: Date.now(),
    ...overrides,
  } as DomainEventV1;
}
