/**
 * Calculate UTF-8 byte length of a string.
 * 
 * Used across schemas and domain logic for byte-budget enforcement.
 * Centralized to avoid copy-paste drift.
 */
export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}
