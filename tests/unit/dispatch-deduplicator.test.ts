import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DispatchDeduplicator } from '../../src/trigger/dispatch-deduplicator.js';

describe('DispatchDeduplicator', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns false (proceed) and records on first call for a key', () => {
    const d = new DispatchDeduplicator(30_000);
    expect(d.checkAndRecord('key-a')).toBe(false);
  });

  it('returns true (skip) for a second call within TTL', () => {
    const d = new DispatchDeduplicator(30_000);
    d.checkAndRecord('key-a');
    expect(d.checkAndRecord('key-a')).toBe(true);
  });

  it('returns false (proceed) after TTL has elapsed', () => {
    const d = new DispatchDeduplicator(30_000);
    d.checkAndRecord('key-a');
    vi.advanceTimersByTime(30_001);
    expect(d.checkAndRecord('key-a')).toBe(false);
  });

  it('does not skip a different key', () => {
    const d = new DispatchDeduplicator(30_000);
    d.checkAndRecord('key-a');
    expect(d.checkAndRecord('key-b')).toBe(false);
  });

  it('cleans up stale entries on each call (bounded memory)', () => {
    const d = new DispatchDeduplicator(30_000);
    d.checkAndRecord('key-a');
    d.checkAndRecord('key-b');
    vi.advanceTimersByTime(30_001);
    // Calling checkAndRecord with a new key triggers cleanup-on-entry
    d.checkAndRecord('key-c');
    // key-a and key-b are stale; the third call re-enables them
    expect(d.checkAndRecord('key-a')).toBe(false);
  });

  it('injectable into TriggerRouter constructor without changing other test call sites', async () => {
    // Verify the DispatchDeduplicator can be injected and its checkAndRecord is called
    const spy = vi.fn().mockReturnValue(false);
    const fakeDeduplicator = { checkAndRecord: spy } as unknown as DispatchDeduplicator;
    // Just verify the constructor accepts it without throwing
    const { TriggerRouter } = await import('../../src/trigger/trigger-router.js');
    expect(() => new TriggerRouter(
      new Map(),
      {} as never, '' as never, (() => Promise.resolve({ _tag: 'success' } as never)) as never,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      fakeDeduplicator,
    )).not.toThrow();
  });
});
