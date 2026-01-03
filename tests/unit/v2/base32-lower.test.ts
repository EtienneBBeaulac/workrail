import { describe, it, expect } from 'vitest';
import { encodeBase32LowerNoPad } from '../../../src/v2/durable-core/encoding/base32-lower.js';

describe('encodeBase32LowerNoPad', () => {
  it('matches RFC4648 examples (lowercase, no padding)', () => {
    const enc = (s: string) => encodeBase32LowerNoPad(new TextEncoder().encode(s));

    expect(enc('')).toBe('');
    expect(enc('f')).toBe('my');
    expect(enc('fo')).toBe('mzxq');
    expect(enc('foo')).toBe('mzxw6');
    expect(enc('foob')).toBe('mzxw6yq');
    expect(enc('fooba')).toBe('mzxw6ytb');
    expect(enc('foobar')).toBe('mzxw6ytboi');
  });

  it('uses only [a-z2-7] and is deterministic', () => {
    const bytes = new Uint8Array([0, 1, 2, 3, 253, 254, 255]);
    const a = encodeBase32LowerNoPad(bytes);
    const b = encodeBase32LowerNoPad(bytes);

    expect(a).toBe(b);
    expect(a).toMatch(/^[a-z2-7]*$/);
    expect(a).not.toContain('=');
  });

  it('encodes 16-byte (128-bit) inputs correctly (no 32-bit truncation)', () => {
    const bytes = new Uint8Array(Array.from({ length: 16 }, (_, i) => i));
    expect(encodeBase32LowerNoPad(bytes)).toBe('aaaqeayeaudaocajbifqydiob4');
  });
});
