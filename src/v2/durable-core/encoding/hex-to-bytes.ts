import type { Result } from 'neverthrow';
import { ok, err } from 'neverthrow';

export type HexToBytesError = {
  readonly code: 'INVALID_HEX';
  readonly message: string;
};

/**
 * Convert a hex string to bytes.
 * 
 * Shared utility to prevent duplication and ensure consistent hex parsing.
 * 
 * @param hex - Hex string (must have even length, lowercase/uppercase both accepted)
 * @returns Result with Uint8Array on success, or error on invalid hex
 */
export function hexToBytes(hex: string): Result<Uint8Array, HexToBytesError> {
  if (hex.length % 2 !== 0) {
    return err({ code: 'INVALID_HEX', message: 'hex string must have even length' });
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byteHex = hex.slice(i * 2, i * 2 + 2);
    const n = Number.parseInt(byteHex, 16);
    if (Number.isNaN(n)) {
      return err({ code: 'INVALID_HEX', message: `invalid hex byte: ${byteHex}` });
    }
    out[i] = n;
  }
  return ok(out);
}
