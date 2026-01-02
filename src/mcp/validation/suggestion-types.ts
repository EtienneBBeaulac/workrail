/**
 * Domain Types for Parameter Suggestions
 *
 * Provides type-safe representations for validation suggestions.
 * Uses branded types and discriminated unions to make illegal states unrepresentable.
 *
 * Philosophy:
 * - Immutability by default
 * - Explicit domain types over primitives
 * - Exhaustiveness via discriminated unions
 *
 * @module mcp/validation/suggestion-types
 */

// -----------------------------------------------------------------------------
// Branded Types
// -----------------------------------------------------------------------------

/**
 * Similarity score: 0 (completely different) to 1 (identical).
 * Branded to prevent accidental mixing with arbitrary numbers.
 */
export type Similarity = number & { readonly __brand: 'Similarity' };

/**
 * Create a Similarity value, clamping to valid range [0, 1].
 */
export function similarity(n: number): Similarity {
  return Math.max(0, Math.min(1, n)) as Similarity;
}

// -----------------------------------------------------------------------------
// Suggestion Discriminated Union
// -----------------------------------------------------------------------------

/**
 * Suggestion for an unknown key that might be a typo.
 */
export interface UnknownKeySuggestion {
  readonly kind: 'unknown_key';
  readonly provided: string;
  readonly didYouMean: string;
  readonly similarity: Similarity;
}

/**
 * Suggestion for a missing required parameter.
 */
export interface MissingRequiredSuggestion {
  readonly kind: 'missing_required';
  readonly param: string;
  readonly example: unknown;
}

/**
 * Suggestion for an invalid enum value.
 */
export interface InvalidEnumSuggestion {
  readonly kind: 'invalid_enum';
  readonly path: string;
  readonly provided: string;
  readonly didYouMean: string | null;
  readonly allowedValues: readonly string[];
}

/**
 * All suggestion kinds as exhaustive discriminated union.
 * Adding a new kind requires handling in all switch/match expressions.
 */
export type ValidationSuggestion =
  | UnknownKeySuggestion
  | MissingRequiredSuggestion
  | InvalidEnumSuggestion;

// -----------------------------------------------------------------------------
// Result Types
// -----------------------------------------------------------------------------

/**
 * Immutable result of suggestion generation.
 */
export interface SuggestionResult {
  readonly suggestions: readonly ValidationSuggestion[];
  readonly correctTemplate: Readonly<Record<string, unknown>> | null;
}

/**
 * Empty suggestion result (no suggestions).
 */
export const EMPTY_SUGGESTION_RESULT: SuggestionResult = {
  suggestions: [],
  correctTemplate: null,
} as const;

// -----------------------------------------------------------------------------
// Type Guards (for exhaustive handling)
// -----------------------------------------------------------------------------

export function isUnknownKeySuggestion(s: ValidationSuggestion): s is UnknownKeySuggestion {
  return s.kind === 'unknown_key';
}

export function isMissingRequiredSuggestion(s: ValidationSuggestion): s is MissingRequiredSuggestion {
  return s.kind === 'missing_required';
}

export function isInvalidEnumSuggestion(s: ValidationSuggestion): s is InvalidEnumSuggestion {
  return s.kind === 'invalid_enum';
}
