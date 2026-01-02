/**
 * String Similarity Utilities
 *
 * Pure functions for computing string similarity.
 * Used for "did you mean?" suggestions.
 *
 * Philosophy:
 * - Pure functions (deterministic, no side effects)
 * - Compose small functions
 * - Explicit domain types (Similarity branded type)
 *
 * @module mcp/validation/string-similarity
 */

import { similarity, type Similarity } from './suggestion-types.js';

/**
 * Compute Levenshtein (edit) distance between two strings.
 *
 * This is the minimum number of single-character edits
 * (insertions, deletions, substitutions) to transform a into b.
 *
 * Time complexity: O(n * m) where n, m are string lengths.
 * Space complexity: O(min(n, m)) using optimized single-row approach.
 *
 * @param a - First string
 * @param b - Second string
 * @returns Edit distance (0 = identical, higher = more different)
 */
export function levenshteinDistance(a: string, b: string): number {
  // Ensure a is the shorter string for space optimization
  if (a.length > b.length) {
    [a, b] = [b, a];
  }

  const m = a.length;
  const n = b.length;

  // Handle edge cases
  if (m === 0) return n;
  if (n === 0) return m;

  // Single-row optimization: only keep current and previous row
  let prevRow = new Array<number>(m + 1);
  let currRow = new Array<number>(m + 1);

  // Initialize first row
  for (let i = 0; i <= m; i++) {
    prevRow[i] = i;
  }

  // Fill the matrix row by row
  for (let j = 1; j <= n; j++) {
    currRow[0] = j;

    for (let i = 1; i <= m; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[i] = Math.min(
        prevRow[i] + 1,      // deletion
        currRow[i - 1] + 1,  // insertion
        prevRow[i - 1] + cost // substitution
      );
    }

    // Swap rows
    [prevRow, currRow] = [currRow, prevRow];
  }

  return prevRow[m];
}

/**
 * Compute normalized similarity score between two strings.
 *
 * Returns a value from 0 (completely different) to 1 (identical).
 * Uses Levenshtein distance normalized by max string length.
 *
 * @param a - First string
 * @param b - Second string
 * @returns Similarity score as branded Similarity type
 */
export function computeSimilarity(a: string, b: string): Similarity {
  if (a === b) return similarity(1);
  if (a.length === 0 || b.length === 0) return similarity(0);

  const distance = levenshteinDistance(a, b);
  const maxLength = Math.max(a.length, b.length);

  return similarity(1 - distance / maxLength);
}

/**
 * Compute case-insensitive similarity.
 *
 * Useful for parameter name matching where case might differ
 * (e.g., workflow_id vs workflowId).
 *
 * @param a - First string
 * @param b - Second string
 * @returns Similarity score
 */
export function computeSimilarityIgnoreCase(a: string, b: string): Similarity {
  return computeSimilarity(a.toLowerCase(), b.toLowerCase());
}

/**
 * Match result from findClosestMatch.
 */
export interface ClosestMatch {
  readonly match: string;
  readonly score: Similarity;
}

/**
 * Find the closest matching string from a list of candidates.
 *
 * Returns null if no candidate meets the similarity threshold.
 *
 * @param input - The input string to match
 * @param candidates - List of possible matches
 * @param threshold - Minimum similarity to consider a match
 * @returns The best match and its score, or null if none found
 */
export function findClosestMatch(
  input: string,
  candidates: readonly string[],
  threshold: Similarity
): ClosestMatch | null {
  if (candidates.length === 0) return null;

  let bestMatch: string | null = null;
  let bestScore: Similarity = similarity(0);

  for (const candidate of candidates) {
    const score = computeSimilarityIgnoreCase(input, candidate);
    if (score > bestScore && score >= threshold) {
      bestScore = score;
      bestMatch = candidate;
    }
  }

  if (bestMatch === null) return null;

  return { match: bestMatch, score: bestScore };
}

/**
 * Find all matches above threshold, sorted by similarity descending.
 *
 * @param input - The input string to match
 * @param candidates - List of possible matches
 * @param threshold - Minimum similarity to include
 * @param limit - Maximum number of matches to return
 * @returns Array of matches sorted by similarity (best first)
 */
export function findAllMatches(
  input: string,
  candidates: readonly string[],
  threshold: Similarity,
  limit: number
): readonly ClosestMatch[] {
  const matches: ClosestMatch[] = [];

  for (const candidate of candidates) {
    const score = computeSimilarityIgnoreCase(input, candidate);
    if (score >= threshold) {
      matches.push({ match: candidate, score });
    }
  }

  // Sort by score descending, then by match string for determinism
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.match.localeCompare(b.match);
  });

  return matches.slice(0, limit);
}
