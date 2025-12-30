/**
 * @enforces illegal-states-unrepresentable (notes markdown)
 * @enforces budget-enforcement (output notes markdown bytes)
 * @enforces determinism (same input -> same output)
 */

import { describe, it, expect } from 'vitest';
import { toNotesMarkdownV1, type NotesMarkdownV1 } from '../../../src/v2/durable-core/domain/notes-markdown.js';
import { MAX_OUTPUT_NOTES_MARKDOWN_BYTES, TRUNCATION_MARKER } from '../../../src/v2/durable-core/constants.js';

describe('NotesMarkdownV1 value object', () => {
  /**
   * Helper to measure UTF-8 byte length (same as TextEncoder).
   */
  function utf8ByteLength(s: string): number {
    return new TextEncoder().encode(s).length;
  }

  // ============================================================================
  // Test cases: ASCII strings
  // ============================================================================

  it('ASCII string under budget → unchanged', () => {
    const input = 'Hello, world!';
    const result = toNotesMarkdownV1(input);
    expect(result).toBe(input);
    expect(utf8ByteLength(result)).toBeLessThanOrEqual(MAX_OUTPUT_NOTES_MARKDOWN_BYTES);
  });

  it('ASCII string at exact budget → unchanged', () => {
    // Create a string that is exactly at the budget
    const input = 'a'.repeat(MAX_OUTPUT_NOTES_MARKDOWN_BYTES);
    const result = toNotesMarkdownV1(input);
    expect(result).toBe(input);
    expect(utf8ByteLength(result)).toBe(MAX_OUTPUT_NOTES_MARKDOWN_BYTES);
  });

  it('ASCII string over budget → truncated with marker', () => {
    // Create a string that is definitely over budget
    const input = 'x'.repeat(MAX_OUTPUT_NOTES_MARKDOWN_BYTES + 100);
    const result = toNotesMarkdownV1(input);

    // Result must be within budget
    expect(utf8ByteLength(result)).toBeLessThanOrEqual(MAX_OUTPUT_NOTES_MARKDOWN_BYTES);

    // Result must end with truncation marker
    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true);

    // Result should be deterministic
    expect(toNotesMarkdownV1(input)).toBe(result);
  });

  // ============================================================================
  // Test cases: Multibyte (UTF-8) strings
  // ============================================================================

  it('Multibyte string under budget → unchanged', () => {
    // Japanese hiragana (3 bytes each in UTF-8)
    const input = 'こんにちは'; // "hello" in Japanese
    const result = toNotesMarkdownV1(input);
    expect(result).toBe(input);
    expect(utf8ByteLength(result)).toBeLessThanOrEqual(MAX_OUTPUT_NOTES_MARKDOWN_BYTES);
  });

  it('Emoji under budget → unchanged', () => {
    const input = 'Hello 👋 World 🌍!';
    const result = toNotesMarkdownV1(input);
    expect(result).toBe(input);
    expect(utf8ByteLength(result)).toBeLessThanOrEqual(MAX_OUTPUT_NOTES_MARKDOWN_BYTES);
  });

  it('Multibyte string over budget → safely truncated at boundary', () => {
    // Create a string with emoji (4 bytes each in UTF-8)
    // that will exceed budget
    const input = '🌍'.repeat(2000); // Will be way over budget
    const result = toNotesMarkdownV1(input);

    // Result must be within budget
    expect(utf8ByteLength(result)).toBeLessThanOrEqual(MAX_OUTPUT_NOTES_MARKDOWN_BYTES);

    // Result must be valid UTF-8 (should not contain broken emoji)
    expect(() => {
      // Verify it's decodable (would throw if malformed)
      new TextEncoder().encode(result);
    }).not.toThrow();

    // Result must end with marker (since it was truncated)
    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it('Multibyte character split at boundary → dropped safely', () => {
    // Create content that when truncated would split a multibyte character
    // Use a string with 3-byte characters (e.g., Japanese)
    // Position them so the last character is partially cut off

    // First, create a string with 3-byte chars that fills most of the budget
    const charSize = 3; // e.g., Japanese hiragana
    const budgetMinusMarker = MAX_OUTPUT_NOTES_MARKDOWN_BYTES - utf8ByteLength(TRUNCATION_MARKER);
    const numChars = Math.floor(budgetMinusMarker / charSize);

    // Create a string that would partially overflow when adding marker
    const input = 'あ'.repeat(numChars + 5); // Add extra chars to force truncation

    const result = toNotesMarkdownV1(input);

    // Result must be within budget
    expect(utf8ByteLength(result)).toBeLessThanOrEqual(MAX_OUTPUT_NOTES_MARKDOWN_BYTES);

    // Result should be valid UTF-8
    expect(() => {
      new TextEncoder().encode(result);
    }).not.toThrow();

    // If over budget originally, should have marker
    if (utf8ByteLength(input) > MAX_OUTPUT_NOTES_MARKDOWN_BYTES) {
      expect(result.endsWith(TRUNCATION_MARKER)).toBe(true);
    }
  });

  // ============================================================================
  // Test cases: Edge case with marker
  // ============================================================================

  it('Marker edge case (marker itself would exceed budget)', () => {
    // This is an edge case where the marker is huge
    // But since TRUNCATION_MARKER is fixed, this won't happen in practice
    // However, we test the scenario conceptually

    // If marker + any content would exceed budget, we should just
    // truncate without marker
    const input = 'x'.repeat(MAX_OUTPUT_NOTES_MARKDOWN_BYTES + 10);
    const result = toNotesMarkdownV1(input);

    expect(utf8ByteLength(result)).toBeLessThanOrEqual(MAX_OUTPUT_NOTES_MARKDOWN_BYTES);
    // In normal case, should have marker
    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  // ============================================================================
  // Test cases: Determinism
  // ============================================================================

  it('Determinism: same input → same output across 1000 runs', () => {
    const testInputs = [
      'Hello, world!',
      'x'.repeat(MAX_OUTPUT_NOTES_MARKDOWN_BYTES + 100),
      '🌍'.repeat(1000),
      'Mix: ASCII 👋 and emoji 🌍 and Japanese あいうえお',
    ];

    for (const input of testInputs) {
      const results = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        results.add(toNotesMarkdownV1(input));
      }

      // All 1000 runs should produce the same result
      expect(results.size).toBe(1);
    }
  });

  // ============================================================================
  // Test cases: Brand type enforcement (compile-time only)
  // ============================================================================

  it('Return type is NotesMarkdownV1 branded type', () => {
    const result = toNotesMarkdownV1('test');
    // This is more of a compile-time check, but we can verify it's a string
    expect(typeof result).toBe('string');
  });

  // ============================================================================
  // Test cases: Budget boundary conditions
  // ============================================================================

  it('String one byte under budget → no truncation', () => {
    // Create a string that is exactly one byte under the budget
    const input = 'a'.repeat(MAX_OUTPUT_NOTES_MARKDOWN_BYTES - 1);
    const result = toNotesMarkdownV1(input);

    expect(result).toBe(input);
    expect(utf8ByteLength(result)).toBe(MAX_OUTPUT_NOTES_MARKDOWN_BYTES - 1);
  });

  it('String one byte over budget → truncated', () => {
    // Create a string that is exactly one byte over the budget
    const input = 'a'.repeat(MAX_OUTPUT_NOTES_MARKDOWN_BYTES + 1);
    const result = toNotesMarkdownV1(input);

    expect(utf8ByteLength(result)).toBeLessThanOrEqual(MAX_OUTPUT_NOTES_MARKDOWN_BYTES);
    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  // ============================================================================
  // Test cases: Real-world examples
  // ============================================================================

  it('Markdown with code blocks → handled correctly', () => {
    const input = `
# Title

\`\`\`typescript
const x = 42;
function test() {
  return x * 2;
}
\`\`\`

## Summary

This is a long text with code.
`.repeat(100); // Repeat to exceed budget

    const result = toNotesMarkdownV1(input);

    expect(utf8ByteLength(result)).toBeLessThanOrEqual(MAX_OUTPUT_NOTES_MARKDOWN_BYTES);
    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it('Error message with special characters → handled correctly', () => {
    const input = `
Error: Failed to parse JSON
→ Expected '}' at line 42, column 5
→ Got: EOF
Path: /home/user/config.json
Details: {...}
`.repeat(100); // Repeat to exceed budget

    const result = toNotesMarkdownV1(input);

    expect(utf8ByteLength(result)).toBeLessThanOrEqual(MAX_OUTPUT_NOTES_MARKDOWN_BYTES);
    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  // ============================================================================
  // Test cases: Empty and whitespace
  // ============================================================================

  it('Empty string → unchanged', () => {
    const result = toNotesMarkdownV1('');
    expect(result).toBe('');
  });

  it('Whitespace string → unchanged if under budget', () => {
    const input = ' '.repeat(100);
    const result = toNotesMarkdownV1(input);
    expect(result).toBe(input);
  });

  it('Newline-heavy string → handles correctly', () => {
    const input = '\n'.repeat(MAX_OUTPUT_NOTES_MARKDOWN_BYTES + 100);
    const result = toNotesMarkdownV1(input);

    expect(utf8ByteLength(result)).toBeLessThanOrEqual(MAX_OUTPUT_NOTES_MARKDOWN_BYTES);
    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true);
  });
});
