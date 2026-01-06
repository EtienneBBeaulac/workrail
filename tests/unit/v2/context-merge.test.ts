import { describe, it, expect } from 'vitest';
import { mergeContext } from '../../../src/v2/durable-core/domain/context-merge.js';

describe('mergeContext', () => {
  it('returns stored when no delta', () => {
    const stored = { a: 1, b: 2 };
    const result = mergeContext(stored, undefined);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({ a: 1, b: 2 });
    }
  });

  it('returns delta when no stored', () => {
    const delta = { c: 3, d: 4 };
    const result = mergeContext(undefined, delta);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({ c: 3, d: 4 });
    }
  });

  it('shallow merges with caller keys overriding', () => {
    const stored = { a: 1, b: 2 };
    const delta = { b: 3, c: 4 };
    const result = mergeContext(stored, delta);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({ a: 1, b: 3, c: 4 });
    }
  });

  it('null tombstone deletes key', () => {
    const stored = { a: 1, b: 2 };
    const delta = { b: null };
    const result = mergeContext(stored, delta);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({ a: 1 });
    }
  });

  it('undefined is no-op (key preserved)', () => {
    const stored = { a: 1, b: 2 };
    const delta = { b: undefined };
    const result = mergeContext(stored, delta);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({ a: 1, b: 2 });
    }
  });

  it('arrays are replaced not merged', () => {
    const stored = { arr: [1, 2] };
    const delta = { arr: [3] };
    const result = mergeContext(stored, delta);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({ arr: [3] });
    }
  });

  it('objects are replaced not merged', () => {
    const stored = { obj: { x: 1 } };
    const delta = { obj: { y: 2 } };
    const result = mergeContext(stored, delta);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({ obj: { y: 2 } });
    }
  });

  it('rejects reserved key __proto__', () => {
    const stored = { a: 1 };
    const delta = Object.defineProperty({}, '__proto__', {
      value: 'evil',
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const result = mergeContext(stored, delta as any);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('RESERVED_KEY_REJECTED');
      expect(result.error.key).toBe('__proto__');
    }
  });

  it('rejects reserved key constructor', () => {
    const stored = { a: 1 };
    const delta = { constructor: 'evil' } as any;
    const result = mergeContext(stored, delta);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('RESERVED_KEY_REJECTED');
      expect(result.error.key).toBe('constructor');
    }
  });

  it('rejects reserved key prototype', () => {
    const stored = { a: 1 };
    const delta = { prototype: 'evil' } as any;
    const result = mergeContext(stored, delta);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('RESERVED_KEY_REJECTED');
      expect(result.error.key).toBe('prototype');
    }
  });

  it('handles empty delta', () => {
    const stored = { a: 1 };
    const delta = {};
    const result = mergeContext(stored, delta);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({ a: 1 });
    }
  });

  it('strips null from delta when no stored', () => {
    const delta = { a: 1, b: null };
    const result = mergeContext(undefined, delta);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({ a: 1 });
    }
  });

  it('combined: new key + override + delete + undefined', () => {
    const stored = { a: 1, b: 2, c: 3, d: 4 };
    const delta = { b: 20, c: null, d: undefined, e: 5 };
    const result = mergeContext(stored, delta);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({ a: 1, b: 20, d: 4, e: 5 });
    }
  });

  it('handles multiple tombstones in sequence', () => {
    const stored = { a: 1, b: 2, c: 3 };
    const delta = { a: null, b: null };
    const result = mergeContext(stored, delta);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({ c: 3 });
    }
  });

  it('handles override then tombstone across calls', () => {
    const stored = { a: 1 };
    const delta1 = { a: 2 };
    const result1 = mergeContext(stored, delta1);
    expect(result1.isOk()).toBe(true);
    
    const delta2 = { a: null };
    const result2 = mergeContext(result1.value, delta2);
    expect(result2.isOk()).toBe(true);
    if (result2.isOk()) {
      expect(result2.value).toEqual({});
    }
  });

  it('handles large contexts efficiently', () => {
    const stored = Object.fromEntries([...Array(100)].map((_, i) => [`k${i}`, i]));
    const delta = Object.fromEntries([...Array(50)].map((_, i) => [`k${i}`, i * 2]));
    const result = mergeContext(stored, delta);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(Object.keys(result.value!).length).toBe(100);
      expect(result.value!['k0']).toBe(0); // First 50 overridden to even values
      expect(result.value!['k99']).toBe(99); // Last 50 unchanged
    }
  });
});
