import type { Result } from 'neverthrow';

/**
 * Token HRP (Human-Readable Prefix) - closed set.
 * Constrains bech32m prefixes to valid token types only.
 */
export type TokenHrp = 'st' | 'ack' | 'chk';

/**
 * Bech32m encoding/decoding port for token serialization.
 *
 * Bech32m (BIP 350) provides:
 * - Built-in 6-character checksum (detects up to 4 errors)
 * - Human-readable prefix (HRP) for token type identification
 * - Character set optimized to avoid visual ambiguity: [023456789acdefghjklmnpqrstuvwxyz]
 *
 * Lock: docs/design/v2-core-design-locks.md (Token string encoding)
 */
export interface Bech32mPortV2 {
  /**
   * Encode binary data to bech32m string with HRP.
   * @param hrp - Human-readable prefix (MUST be 'st', 'ack', or 'chk')
   * @param data - Raw bytes to encode
   * @returns Bech32m-encoded string (format: <hrp>1<data>)
   */
  encode(hrp: TokenHrp, data: Uint8Array): string;

  /**
   * Decode bech32m string to binary data.
   * Validates checksum and HRP.
   * @param encoded - Bech32m string
   * @param expectedHrp - Expected HRP (MUST be 'st', 'ack', or 'chk')
   * @returns Decoded bytes, or error if invalid/checksum failed/HRP mismatch
   */
  decode(encoded: string, expectedHrp: TokenHrp): Result<Uint8Array, Bech32mDecodeError>;
}

export interface Bech32mDecodeError {
  readonly code: 'BECH32M_INVALID_FORMAT' | 'BECH32M_CHECKSUM_FAILED' | 'BECH32M_HRP_MISMATCH';
  readonly message: string;
  readonly position?: number; // Estimated error position
}
