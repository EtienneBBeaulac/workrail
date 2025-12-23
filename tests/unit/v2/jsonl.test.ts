import { describe, it, expect } from 'vitest';
import { toJsonlLineBytes } from '../../../src/v2/durable-core/canonical/jsonl.js';
import type { JsonValue } from '../../../src/v2/durable-core/canonical/json-types.js';

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe('v2 JSONL encoding (Slice 2)', () => {
  it('encodes canonical JSON followed by newline', () => {
    const value: JsonValue = { b: 2, a: 1 };
    const res = toJsonlLineBytes(value);
    expect(res.isOk()).toBe(true);
    expect(decodeUtf8(res._unsafeUnwrap())).toBe('{"a":1,"b":2}\n');
  });
});
