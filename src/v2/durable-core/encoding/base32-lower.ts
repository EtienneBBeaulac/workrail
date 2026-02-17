import type { Result } from 'neverthrow';
import { ok, err } from 'neverthrow';

const BASE32_LOWER_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567' as const;

export type Base32LowerNoPad = string & { readonly __brand: 'v2.Base32LowerNoPad' };

export type Base32DecodeError =
  | { readonly code: 'BASE32_INVALID_CHARACTERS'; readonly message: string; readonly position?: number }
  | { readonly code: 'BASE32_INVALID_LENGTH'; readonly message: string }
  | { readonly code: 'BASE32_NON_CANONICAL'; readonly message: string };

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

/**
 * Decode RFC 4648 base32 (lowercase, no padding) back to bytes.
 *
 * NOTE: Uses BigInt to handle 130-bit inputs safely (26 chars × 5 bits = 130 bits).
 * This matches the encoder's approach to avoid 32-bit truncation.
 *
 * Constraints:
 * - Input chars must be only [a-z2-7]
 * - No '=' padding expected
 * - Deterministic
 *
 * Returns Result with error if input contains invalid characters or non-canonical encoding
 */
export function decodeBase32LowerNoPad(encoded: string): Result<Uint8Array, Base32DecodeError> {
  const lookup = new Map(
    BASE32_LOWER_ALPHABET.split('').map((c, i) => [c, i] as const),
  );

  // Use BigInt to handle 130-bit inputs safely (26 chars * 5 bits)
  // Matches the encoder's approach (src/v2/durable-core/encoding/base32-lower.ts uses BigInt)
  let acc = 0n;
  const totalBits = encoded.length * 5;

  let position = 0;
  for (const char of encoded) {
    const val = lookup.get(char);
    if (val === undefined) {
      return err({
        code: 'BASE32_INVALID_CHARACTERS',
        message: `Invalid base32 character: '${char}'`,
        position,
      });
    }

    acc = (acc << 5n) | BigInt(val);
    position++;
  }

  // Calculate expected byte count and padding bits
  const byteCount = Math.floor(totalBits / 8);
  const paddingBits = totalBits - byteCount * 8;

  // The encoder pads remaining bits with zeros on the RIGHT.
  // So the padding zeros are in the LSB positions of acc.
  // Validate that padding bits are zero (canonical encoding enforcement)
  if (paddingBits > 0) {
    const paddingMask = (1n << BigInt(paddingBits)) - 1n;
    if ((acc & paddingMask) !== 0n) {
      return err({
        code: 'BASE32_NON_CANONICAL',
        message: 'Non-canonical base32 encoding (padding bits non-zero)',
      });
    }
    // Shift right to remove padding
    acc >>= BigInt(paddingBits);
  }

  // Extract bytes from LSB to MSB (reverse order into array)
  const bytes = new Uint8Array(byteCount);
  for (let i = byteCount - 1; i >= 0; i--) {
    bytes[i] = Number(acc & 0xffn);
    acc >>= 8n;
  }

  return ok(bytes);
}
