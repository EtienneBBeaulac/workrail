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
});
