/**
 * Helper to measure UTF-8 byte length (not code units).
 * Uses TextEncoder for runtime neutrality.
 * 
 * Shared utility to prevent duplication across schemas and domain logic.
 */
export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}
