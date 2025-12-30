import { describe, it, expect } from 'vitest';

/**
 * Schema load safety smoke tests.
 *
 * @enforces schema-modules-load-safe
 *
 * Purpose: prevent schema refactors from causing module-load-time errors.
 * Critical for discriminatedUnion safety (wrapping branches breaks load).
 *
 * These tests ensure that:
 * 1. Schema modules can be imported without throwing
 * 2. Schema constructors can be called without throwing
 * 3. No accidental wrapping of discriminatedUnion branches in effects
 */
describe('v2 schema load safety', () => {
  it('DomainEventV1Schema can be accessed without throwing', async () => {
    const { DomainEventV1Schema } = await import('src/v2/durable-core/schemas/session/events.js');
    expect(DomainEventV1Schema).toBeDefined();
  });

  it('session schemas module loads without throwing', async () => {
    const sessionSchemas = await import('src/v2/durable-core/schemas/session/index.js');
    expect(sessionSchemas).toBeDefined();
  });

  it('utf8BoundedString helper loads without throwing', async () => {
    const { utf8BoundedString } = await import('src/v2/durable-core/schemas/lib/utf8-bounded-string.js');
    expect(utf8BoundedString).toBeDefined();
    expect(typeof utf8BoundedString).toBe('function');
  });

  it('utf8BoundedString returns a Zod schema', async () => {
    const { utf8BoundedString } = await import('src/v2/durable-core/schemas/lib/utf8-bounded-string.js');
    const schema = utf8BoundedString({ maxBytes: 100, label: 'test' });
    expect(schema).toBeDefined();
    expect(schema.parse).toBeDefined();
  });

  it('utf8BoundedString schema validates ASCII strings correctly', async () => {
    const { utf8BoundedString } = await import('src/v2/durable-core/schemas/lib/utf8-bounded-string.js');
    const schema = utf8BoundedString({ maxBytes: 100, label: 'test' });

    // Should pass: ASCII is 1 byte per character
    expect(() => schema.parse('hello world')).not.toThrow();
    expect(() => schema.parse('x'.repeat(100))).not.toThrow();

    // Should fail: exceeds 100 bytes
    expect(() => schema.parse('x'.repeat(101))).toThrow();
  });

  it('utf8BoundedString schema validates multibyte UTF-8 strings correctly', async () => {
    const { utf8BoundedString } = await import('src/v2/durable-core/schemas/lib/utf8-bounded-string.js');
    const schema = utf8BoundedString({ maxBytes: 10, label: 'test' });

    // Emoji is 4 bytes in UTF-8
    const emoji = '😀'; // 4 bytes
    expect(() => schema.parse(emoji)).not.toThrow();
    expect(() => schema.parse(emoji + emoji)).not.toThrow(); // 8 bytes
    expect(() => schema.parse(emoji + emoji + 'xx')).not.toThrow(); // 10 bytes (exactly at limit)
    // 12 bytes exceeds 10, so this should fail
    expect(() => schema.parse(emoji + emoji + 'xxx')).toThrow(); // 11 bytes
  });

  it('DomainEventV1Schema can parse valid events', async () => {
    const { DomainEventV1Schema } = await import('src/v2/durable-core/schemas/session/events.js');

    const validEvent = {
      v: 1,
      kind: 'session_created',
      eventId: 'test-event-1',
      eventIndex: 0,
      sessionId: 'test-session',
      dedupeKey: 'test-dedupe-1',
      data: {},
    };

    expect(() => DomainEventV1Schema.parse(validEvent)).not.toThrow();
  });

  it('ExecutionSnapshotFileV1Schema can be accessed', async () => {
    const { ExecutionSnapshotFileV1Schema } = await import('src/v2/durable-core/schemas/execution-snapshot/index.js');
    expect(ExecutionSnapshotFileV1Schema).toBeDefined();
  });
});
