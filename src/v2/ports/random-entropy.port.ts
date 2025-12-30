/**
 * Random entropy port for cryptographically secure random bytes.
 *
 * Lock: durable-core must not use Node crypto directly
 * Design: v2-core-design-locks.md §17 (runtime neutrality)
 *
 * Purpose:
 * - Generate cryptographically secure random bytes for keys, IDs, etc.
 * - Abstracted for runtime neutrality and deterministic testing
 *
 * Guarantees:
 * - Synchronous (randomness is CPU-bound, no I/O)
 * - Cryptographically secure (not Math.random())
 * - Returns exactly the requested byte count
 *
 * When to use:
 * - Keyring key generation
 * - ULID/UUID generation for IDs
 * - Any security-critical randomness
 *
 * @example
 * const bytes = entropy.generateBytes(32);  // 32-byte key
 */
export interface RandomEntropyPortV2 {
  /**
   * Generate cryptographically secure random bytes.
   *
   * @param count - Number of bytes to generate (must be positive)
   * @returns Uint8Array of exactly `count` random bytes
   */
  generateBytes(count: number): Uint8Array;
}
