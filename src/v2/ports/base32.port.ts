import type { Result } from 'neverthrow';

export type Base32DecodeError =
  | { readonly code: 'BASE32_INVALID_CHARACTERS'; readonly message: string; readonly position?: number }
  | { readonly code: 'BASE32_INVALID_LENGTH'; readonly message: string }
  | { readonly code: 'BASE32_NON_CANONICAL'; readonly message: string };

/**
 * Port: Base32 encoding/decoding with RFC 4648 (lowercase, no padding).
 *
 * Purpose:
 * - Encode 16-byte IDs to 26-character base32 strings
 * - Decode base32 strings back to bytes with validation
 * - Ensure canonical encoding (no padding, lowercase only)
 *
 * Locked invariants:
 * - Alphabet: [a-z2-7] (32 characters, RFC 4648 lowercase)
 * - No padding characters (unpadded variant)
 * - 16 bytes → 26 characters (5 bits per char, 130 bits / 5 = 26)
 * - Decoding must validate canonical form
 *
 * Guarantees:
 * - encode() is deterministic for same input
 * - decode(encode(bytes)) === bytes (roundtrip identity)
 * - decode() rejects non-canonical input
 *
 * When to use:
 * - Encoding IDs for token binary payload
 * - Decoding IDs from binary payload
 * - Validating external ID format
 *
 * Example:
 * ```typescript
 * const encoded = base32.encode(new Uint8Array(16));  // 26 chars
 * const decoded = base32.decode(encoded).unwrap();    // 16 bytes
 * ```
 */
export interface Base32PortV2 {
  /**
   * Encode bytes to RFC 4648 base32 (lowercase, no padding).
   *
   * @param bytes - Binary data to encode
   * @returns Base32-encoded string (alphabet: [a-z2-7])
   */
  encode(bytes: Uint8Array): string;

  /**
   * Decode RFC 4648 base32 string to bytes.
   *
   * Validates:
   * - Only valid base32 characters ([a-z2-7])
   * - Canonical encoding (no uppercase, no padding)
   *
   * @param encoded - Base32 string to decode
   * @returns Decoded bytes or error
   */
  decode(encoded: string): Result<Uint8Array, Base32DecodeError>;
}
