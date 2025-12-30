/**
 * Port: HMAC-SHA256 signing primitives (token security).
 *
 * Purpose:
 * - Compute HMAC-SHA256 signatures for token payload bytes
 * - Support signature verification via timing-safe equality
 * - Keep crypto implementation behind an interface for testability and portability
 *
 * Locked invariants (docs/design/v2-core-design-locks.md Section 1.2):
 * - Algorithm: HMAC-SHA256
 * - Key size: 32 bytes (256 bits)
 * - Signature input: canonical bytes (RFC 8785 JCS) of the token payload
 * - No additional prefixes/separators in HMAC input
 *
 * Guarantees:
 * - hmacSha256() is deterministic (same key + message → same signature)
 * - timingSafeEqual() is constant-time with respect to matching prefix
 * - Pure functions (no I/O, no global state)
 *
 * When to use:
 * - Token signing after encoding canonical payload bytes
 * - Token verification before decoding/accepting payload
 * - Never sign/verify without keys sourced from the keyring
 *
 * Example:
 * ```typescript
 * const sig = hmac.hmacSha256(keyBytes, canonicalPayloadBytes);
 * const ok = hmac.timingSafeEqual(sig, expectedSig);
 * ```
 */
export interface HmacSha256PortV2 {
  /**
   * Compute HMAC-SHA256 signature.
   *
   * Deterministic: same key + message → same signature.
   * Returns 32 bytes.
   */
  hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array; // 32 bytes

  /**
   * Compare two byte arrays in a timing-safe way.
   *
   * Returns true only if arrays are equal and same length.
   */
  timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}
