/**
 * UTF-8 byte measurement port.
 *
 * Lock: durable-core must not use Node-only Buffer.byteLength
 * Design: v2-core-design-locks.md §17 (runtime neutrality)
 *
 * This port provides runtime-neutral UTF-8 byte measurement.
 */

/**
 * Measures UTF-8 byte length of a string.
 *
 * Design decision (locked):
 * - Synchronous (UTF-8 encoding is CPU-bound, no I/O)
 * - Returns number directly (always succeeds for valid JS strings)
 * - Implementation uses TextEncoder (available in all modern runtimes)
 */
export interface Utf8PortV2 {
  utf8ByteLength(s: string): number;
}
