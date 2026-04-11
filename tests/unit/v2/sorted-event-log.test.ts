import { describe, it, expect } from 'vitest';
import { asSortedEventLog } from '../../../src/v2/durable-core/sorted-event-log.js';
import type { SortedEventLog } from '../../../src/v2/durable-core/sorted-event-log.js';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';

function makeEvent(eventIndex: number): DomainEventV1 {
  return {
    v: 1,
    eventId: `evt_${eventIndex}`,
    eventIndex,
    sessionId: 'sess_1',
    kind: 'session_created',
    dedupeKey: `session_created:sess_1:${eventIndex}`,
    data: {},
  } as unknown as DomainEventV1;
}

describe('asSortedEventLog', () => {
  it('accepts an empty array', () => {
    const result = asSortedEventLog([]);
    expect(result.isOk()).toBe(true);
  });

  it('accepts a single-element array', () => {
    const result = asSortedEventLog([makeEvent(0)]);
    expect(result.isOk()).toBe(true);
  });

  it('accepts a correctly sorted array', () => {
    const events = [makeEvent(0), makeEvent(1), makeEvent(2)];
    const result = asSortedEventLog(events);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // The wrapped value preserves the original events
      expect(result.value).toHaveLength(3);
      expect(result.value[0]?.eventIndex).toBe(0);
      expect(result.value[2]?.eventIndex).toBe(2);
    }
  });

  it('rejects an array with duplicate eventIndex values', () => {
    // The tightened check (<=) rejects equal consecutive indices, not just descending.
    const events = [makeEvent(0), makeEvent(1), makeEvent(1), makeEvent(2)];
    const result = asSortedEventLog(events);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('PROJECTION_INVARIANT_VIOLATION');
      expect(result.error.message).toContain('strictly ascending');
    }
  });

  it('rejects an out-of-order array', () => {
    const events = [makeEvent(1), makeEvent(0)];
    const result = asSortedEventLog(events);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('PROJECTION_INVARIANT_VIOLATION');
      expect(result.error.message).toContain('sorted by eventIndex');
    }
  });

  it('rejects a partially out-of-order array', () => {
    const events = [makeEvent(0), makeEvent(2), makeEvent(1), makeEvent(3)];
    const result = asSortedEventLog(events);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('PROJECTION_INVARIANT_VIOLATION');
    }
  });

  it('SortedEventLog is not directly assignable from a raw array (compile-time check)', () => {
    // This test documents the type-level guarantee:
    // a raw DomainEventV1[] cannot be used where SortedEventLog is expected
    // without going through asSortedEventLog().
    //
    // We verify the runtime shape is correct -- the type-level guarantee is
    // enforced by the Brand<T, B> phantom type which TypeScript catches at
    // compile time.
    const events = [makeEvent(0), makeEvent(1)];
    const result = asSortedEventLog(events);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // SortedEventLog extends readonly DomainEventV1[], so array operations work
      const sorted: SortedEventLog = result.value;
      expect(sorted.length).toBe(2);
    }
  });
});
