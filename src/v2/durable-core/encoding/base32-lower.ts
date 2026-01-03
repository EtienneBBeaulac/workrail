const BASE32_LOWER_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567' as const;

export type Base32LowerNoPad = string & { readonly __brand: 'v2.Base32LowerNoPad' };

/**
 * Encode bytes to RFC 4648 base32 without padding, lowercase alphabet.
 *
 * Constraints:
 * - Output chars are only [a-z2-7] (lowercase)
 * - No '=' padding
 * - Deterministic
 */
export function encodeBase32LowerNoPad(bytes: Uint8Array): Base32LowerNoPad {
  let out = '';

  // NOTE: must not use 32-bit bitwise ops here.
  // IDs are typically 16 bytes (128-bit) and JS bitwise ops truncate to 32-bit.
  let buffer = 0n;
  let bits = 0;

  for (const b of bytes) {
    buffer = (buffer << 8n) | BigInt(b);
    bits += 8;

    while (bits >= 5) {
      const shift = BigInt(bits - 5);
      const index = Number((buffer >> shift) & 31n);
      out += BASE32_LOWER_ALPHABET[index] as string;
      bits -= 5;

      // Keep buffer bounded to remaining bits.
      if (bits === 0) {
        buffer = 0n;
      } else {
        buffer = buffer & ((1n << BigInt(bits)) - 1n);
      }
    }
  }

  if (bits > 0) {
    // Pad remaining bits with zeros on the right.
    const index = Number((buffer << BigInt(5 - bits)) & 31n);
    out += BASE32_LOWER_ALPHABET[index] as string;
  }

  return out as Base32LowerNoPad;
}
