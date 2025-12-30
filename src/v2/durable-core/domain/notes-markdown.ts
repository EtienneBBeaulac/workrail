import { TRUNCATION_MARKER, MAX_OUTPUT_NOTES_MARKDOWN_BYTES } from '../constants.js';

/**
 * Branded type for budget-enforced notes markdown.
 *
 * Lock: over-budget recap notes are unrepresentable inside core
 * Design: illegal states unrepresentable, single constructor
 *
 * This branded string ensures that any NotesMarkdownV1 value is guaranteed to:
 * - Not exceed MAX_OUTPUT_NOTES_MARKDOWN_BYTES in UTF-8 bytes
 * - Have been truncated with TRUNCATION_MARKER if content was originally over budget
 * - Maintain valid UTF-8 boundaries (no split multibyte sequences)
 */
export type NotesMarkdownV1 = string & { readonly __brand: 'NotesMarkdownV1' };

/**
 * Trims a Uint8Array to a UTF-8 boundary.
 *
 * Algorithm:
 * - Count continuation bytes at end (10xxxxxx pattern)
 * - Find lead byte, compute expected sequence length
 * - If incomplete, drop the partial sequence
 *
 * This prevents malformed UTF-8 when truncating in the middle of a multibyte character.
 */
function trimToUtf8Boundary(bytes: Uint8Array): Uint8Array {
  const n = bytes.length;
  if (n === 0) return bytes;

  // Count continuation bytes at end (10xxxxxx).
  let cont = 0;
  for (let i = n - 1; i >= 0; i--) {
    const b = bytes[i]!;
    if ((b & 0b1100_0000) === 0b1000_0000) cont++;
    else break;
  }
  if (cont === 0) return bytes;

  const start = n - cont - 1;
  if (start < 0) return new Uint8Array();

  const lead = bytes[start]!;
  const expectedLen =
    (lead & 0b1000_0000) === 0 ? 1 :
    (lead & 0b1110_0000) === 0b1100_0000 ? 2 :
    (lead & 0b1111_0000) === 0b1110_0000 ? 3 :
    (lead & 0b1111_1000) === 0b1111_0000 ? 4 : 0;

  // If the last code point is incomplete (or invalid), drop the lead byte too.
  if (expectedLen === 0 || expectedLen !== cont + 1) {
    return bytes.slice(0, start);
  }
  return bytes;
}

/**
 * Constructs a budget-enforced NotesMarkdownV1.
 *
 * Enforces MAX_OUTPUT_NOTES_MARKDOWN_BYTES (UTF-8 bytes).
 * Appends TRUNCATION_MARKER if truncated.
 *
 * This is the ONLY way to create NotesMarkdownV1 (single enforcement point).
 *
 * @param raw - The input markdown string (may be over budget)
 * @returns NotesMarkdownV1 - A branded string guaranteed to fit within budget
 *
 * Algorithm:
 * 1. Encode input to UTF-8 bytes using TextEncoder
 * 2. If within budget, return as-is
 * 3. If over budget:
 *    a. Check if marker itself exceeds budget (edge case)
 *    b. Truncate content to make room for marker
 *    c. Trim to UTF-8 boundary safely
 *    d. Append marker
 */
export function toNotesMarkdownV1(raw: string): NotesMarkdownV1 {
  const encoder = new TextEncoder();
  const inputBytes = encoder.encode(raw);

  // If within budget, no truncation needed
  if (inputBytes.length <= MAX_OUTPUT_NOTES_MARKDOWN_BYTES) {
    return raw as NotesMarkdownV1;
  }

  // Over budget: compute space for marker
  const markerBytes = encoder.encode(TRUNCATION_MARKER);
  if (markerBytes.length >= MAX_OUTPUT_NOTES_MARKDOWN_BYTES) {
    // Edge case: marker itself is too large; just truncate without marker
    const trimmed = trimToUtf8Boundary(inputBytes.subarray(0, MAX_OUTPUT_NOTES_MARKDOWN_BYTES));
    return new TextDecoder().decode(trimmed) as NotesMarkdownV1;
  }

  // Normal case: reserve space for marker, truncate content, append marker
  const maxContentBytes = MAX_OUTPUT_NOTES_MARKDOWN_BYTES - markerBytes.length;
  const prefix = trimToUtf8Boundary(inputBytes.subarray(0, maxContentBytes));
  return (new TextDecoder().decode(prefix) + TRUNCATION_MARKER) as NotesMarkdownV1;
}
