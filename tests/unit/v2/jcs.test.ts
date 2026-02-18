/**
 * v2 JCS Canonicalization Tests
 *
 * @enforces jcs-rfc-8785
 * @enforces hash-format-sha256-hex
 */
import { describe, it, expect } from 'vitest';
import { toCanonicalBytes } from '../../../src/v2/durable-core/canonical/jcs.js';
import type { JsonValue } from '../../../src/v2/durable-core/canonical/json-types.js';

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe('v2 JCS canonicalization (Slice 1)', () => {
  it('sorts object keys recursively and emits compact JSON', () => {
    const value: JsonValue = {
      b: 2,
      a: { d: 4, c: 3 },
    };

    const res = toCanonicalBytes(value);
    expect(res.isOk()).toBe(true);
    expect(decodeUtf8(res._unsafeUnwrap())).toBe('{"a":{"c":3,"d":4},"b":2}');
  });

  it('normalizes -0 to 0', () => {
    const value: JsonValue = { n: -0 };
    const res = toCanonicalBytes(value);
    expect(res.isOk()).toBe(true);
    expect(decodeUtf8(res._unsafeUnwrap())).toBe('{"n":0}');
  });

  it('rejects non-finite numbers', () => {
    const value: JsonValue = { n: Number.POSITIVE_INFINITY };
    const res = toCanonicalBytes(value);
    expect(res.isErr()).toBe(true);
  });

  // undefined handling (matching JSON.stringify behavior)
  // These scenarios occur when TypeScript objects with optional fields are cast as JsonValue.

  it('skips undefined values in objects (matching JSON.stringify)', () => {
    const value = { a: 1, b: undefined, c: 3 } as unknown as JsonValue;
    const res = toCanonicalBytes(value);
    expect(res.isOk()).toBe(true);
    // b is omitted entirely, matching JSON.stringify({ a: 1, b: undefined, c: 3 }) → '{"a":1,"c":3}'
    expect(decodeUtf8(res._unsafeUnwrap())).toBe('{"a":1,"c":3}');
  });

  it('renders undefined in arrays as null (matching JSON.stringify)', () => {
    const value = [1, undefined, 3] as unknown as JsonValue;
    const res = toCanonicalBytes(value);
    expect(res.isOk()).toBe(true);
    // undefined array elements become null, matching JSON.stringify([1, undefined, 3]) → '[1,null,3]'
    expect(decodeUtf8(res._unsafeUnwrap())).toBe('[1,null,3]');
  });

  it('handles nested objects with undefined fields', () => {
    const value = {
      a: { x: 1, y: undefined },
      b: undefined,
      c: [{ p: undefined, q: 2 }],
    } as unknown as JsonValue;
    const res = toCanonicalBytes(value);
    expect(res.isOk()).toBe(true);
    expect(decodeUtf8(res._unsafeUnwrap())).toBe('{"a":{"x":1},"c":[{"q":2}]}');
  });

  it('handles object where all values are undefined', () => {
    const value = { a: undefined, b: undefined } as unknown as JsonValue;
    const res = toCanonicalBytes(value);
    expect(res.isOk()).toBe(true);
    expect(decodeUtf8(res._unsafeUnwrap())).toBe('{}');
  });
});
