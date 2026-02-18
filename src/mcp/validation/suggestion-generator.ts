/**
 * Suggestion Generator
 *
 * Orchestrates schema introspection and string similarity to generate
 * helpful suggestions for invalid input.
 *
 * Philosophy:
 * - Pure functions (deterministic, no side effects)
 * - Compose small functions
 * - Control flow from data state
 *
 * @module mcp/validation/suggestion-generator
 */

import { z } from 'zod';
import type { SuggestionConfig } from './suggestion-config.js';
import type {
  SuggestionResult,
  ValidationSuggestion,
  UnknownKeySuggestion,
  MissingRequiredSuggestion,
} from './suggestion-types.js';
import { EMPTY_SUGGESTION_RESULT } from './suggestion-types.js';
import { findClosestMatch } from './string-similarity.js';
import {
  extractExpectedKeys,
  findUnknownKeys,
  findMissingRequiredKeys,
  generateTemplate,
  generateExampleValue,
} from './schema-introspection.js';

// Re-export ZodIssue type for callers
export type { ZodIssue } from 'zod';

/**
 * Generate unknown key suggestions by matching against expected keys.
 *
 * @param unknownKeys - Keys provided that aren't in the schema
 * @param expectedKeys - Keys expected by the schema
 * @param config - Suggestion configuration
 * @returns Array of unknown key suggestions
 */
function generateUnknownKeySuggestions(
  unknownKeys: readonly string[],
  expectedKeys: readonly string[],
  config: SuggestionConfig
): readonly UnknownKeySuggestion[] {
  const suggestions: UnknownKeySuggestion[] = [];

  for (const unknownKey of unknownKeys) {
    const match = findClosestMatch(unknownKey, expectedKeys, config.similarityThreshold);
    if (match) {
      suggestions.push({
        kind: 'unknown_key',
        provided: unknownKey,
        didYouMean: match.match,
        similarity: match.score,
      });
    }
  }

  // Sort by similarity descending for consistent output
  suggestions.sort((a, b) => b.similarity - a.similarity);

  return suggestions.slice(0, config.maxSuggestions);
}

/**
 * Generate missing required parameter suggestions.
 *
 * @param missingKeys - Required keys that weren't provided
 * @param schema - The Zod schema (for generating examples)
 * @param config - Suggestion configuration
 * @returns Array of missing required suggestions
 */
function generateMissingRequiredSuggestions(
  missingKeys: readonly string[],
  schema: z.ZodType,
  config: SuggestionConfig
): readonly MissingRequiredSuggestion[] {
  if (!(schema instanceof z.ZodObject)) {
    return [];
  }

  const shape = schema._def.shape();
  const suggestions: MissingRequiredSuggestion[] = [];

  for (const key of missingKeys) {
    const field = shape[key] as z.ZodType | undefined;
    if (field) {
      suggestions.push({
        kind: 'missing_required',
        param: key,
        example: generateExampleValue(field, 0, config.maxTemplateDepth),
      });
    }
  }

  // Sort alphabetically for consistent output
  suggestions.sort((a, b) => a.param.localeCompare(b.param));

  return suggestions.slice(0, config.maxSuggestions);
}

/**
 * Generate all suggestions for invalid input.
 *
 * This is the main entry point that combines all suggestion types.
 *
 * @param args - The invalid input arguments
 * @param schema - The expected Zod schema
 * @param config - Suggestion configuration
 * @returns Immutable suggestion result
 */
export function generateSuggestions(
  args: unknown,
  schema: z.ZodType,
  config: SuggestionConfig
): SuggestionResult {
  const suggestions: ValidationSuggestion[] = [];

  // Get expected keys for matching
  const expectedKeys = extractExpectedKeys(schema);

  // Find and suggest corrections for unknown keys
  const unknownKeys = findUnknownKeys(args, schema);
  const unknownKeySuggestions = generateUnknownKeySuggestions(
    unknownKeys,
    expectedKeys,
    config
  );
  suggestions.push(...unknownKeySuggestions);

  // Find and suggest missing required keys
  const missingKeys = findMissingRequiredKeys(args, schema);
  const missingRequiredSuggestions = generateMissingRequiredSuggestions(
    missingKeys,
    schema,
    config
  );
  suggestions.push(...missingRequiredSuggestions);

  // Return empty result if no suggestions
  if (suggestions.length === 0 && !config.includeTemplate) {
    return EMPTY_SUGGESTION_RESULT;
  }

  // Generate template if configured
  const correctTemplate = config.includeTemplate
    ? generateTemplate(schema, config.maxTemplateDepth)
    : null;

  return {
    suggestions,
    correctTemplate,
  };
}

/**
 * Format suggestion result for inclusion in error details.
 *
 * Creates a plain object suitable for JSON serialization.
 *
 * @param result - The suggestion result to format
 * @returns Object to spread into error details (may be empty)
 */
export function formatSuggestionDetails(
  result: SuggestionResult
): Record<string, unknown> {
  const details: Record<string, unknown> = {};

  if (result.suggestions.length > 0) {
    details.suggestions = result.suggestions.map(s => {
      switch (s.kind) {
        case 'unknown_key':
          return {
            kind: s.kind,
            provided: s.provided,
            didYouMean: s.didYouMean,
            similarity: Math.round(s.similarity * 100) / 100, // Round for readability
          };
        case 'missing_required':
          return {
            kind: s.kind,
            param: s.param,
            example: s.example,
          };
        case 'invalid_enum':
          return {
            kind: s.kind,
            path: s.path,
            provided: s.provided,
            didYouMean: s.didYouMean,
            allowedValues: s.allowedValues,
          };
      }
    });
  }

  if (result.correctTemplate !== null) {
    details.correctTemplate = result.correctTemplate;
  }

  return details;
}

/**
 * Check if a suggestion result has any meaningful content.
 *
 * @param result - The suggestion result to check
 * @returns True if there are suggestions or a template
 */
export function hasSuggestions(result: SuggestionResult): boolean {
  return result.suggestions.length > 0 || result.correctTemplate !== null;
}

/**
 * Patch a correctTemplate to restore optional fields that were provided with
 * the wrong type.
 *
 * The default template omits all optional fields to keep it concise. But when
 * an agent provides an optional field with the wrong type (e.g., context: "string"
 * instead of context: {}), that field is absent from the template. Agents
 * misread the absence as "this field should be removed," causing valid context
 * to be silently dropped on retry.
 *
 * This function adds back those fields as correctly-typed examples, guiding the
 * agent to fix the format rather than drop the field.
 *
 * @param correctTemplate - Base template from generateSuggestions (null = no-op)
 * @param args - The raw input the agent provided
 * @param zodErrors - Zod validation issues from schema.safeParse()
 * @param schema - The Zod schema being validated against
 * @param maxDepth - Max depth for example generation (matches suggestion config)
 * @returns Patched template, or the original if no patching was needed
 */
export function patchTemplateForFailedOptionals(
  correctTemplate: Readonly<Record<string, unknown>> | null,
  args: unknown,
  zodErrors: readonly z.ZodIssue[],
  schema: z.ZodType,
  maxDepth: number,
): Readonly<Record<string, unknown>> | null {
  if (correctTemplate === null) return null;
  if (!(schema instanceof z.ZodObject)) return correctTemplate;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return correctTemplate;

  const argsObj = args as Record<string, unknown>;
  const shape = schema._def.shape() as Record<string, z.ZodType>;
  const patched: Record<string, unknown> = { ...correctTemplate };
  let changed = false;

  for (const error of zodErrors) {
    if (error.path.length !== 1) continue; // Only top-level fields
    const field = error.path[0] as string;

    // Only patch when: (1) agent provided the field, (2) it's in the schema,
    // (3) it's not already in the template (was skipped as optional)
    if (!(field in argsObj)) continue;
    if (!(field in shape)) continue;
    if (field in patched) continue;

    const fieldSchema = shape[field];
    // Only restore optional fields — required fields are never skipped
    if (!(fieldSchema instanceof z.ZodOptional)) continue;

    // Show the correct type for this field so the agent knows how to fix it
    patched[field] = generateExampleValue(fieldSchema._def.innerType, 0, maxDepth);
    changed = true;
  }

  return changed ? Object.freeze(patched) : correctTemplate;
}
