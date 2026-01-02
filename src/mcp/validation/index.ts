/**
 * Validation Module
 *
 * Public exports for MCP input validation and suggestion generation.
 *
 * @module mcp/validation
 */

// Domain types
export type {
  Similarity,
  ValidationSuggestion,
  UnknownKeySuggestion,
  MissingRequiredSuggestion,
  InvalidEnumSuggestion,
  SuggestionResult,
} from './suggestion-types.js';

export {
  similarity,
  EMPTY_SUGGESTION_RESULT,
  isUnknownKeySuggestion,
  isMissingRequiredSuggestion,
  isInvalidEnumSuggestion,
} from './suggestion-types.js';

// Configuration
export type { SuggestionConfig } from './suggestion-config.js';
export { DEFAULT_SUGGESTION_CONFIG, MINIMAL_SUGGESTION_CONFIG } from './suggestion-config.js';

// String similarity (exposed for testing)
export {
  levenshteinDistance,
  computeSimilarity,
  computeSimilarityIgnoreCase,
  findClosestMatch,
  findAllMatches,
  type ClosestMatch,
} from './string-similarity.js';

// Schema introspection (exposed for testing)
export {
  extractExpectedKeys,
  extractRequiredKeys,
  findUnknownKeys,
  findMissingRequiredKeys,
  generateExampleValue,
  generateTemplate,
  extractEnumValues,
} from './schema-introspection.js';

// Suggestion generator (main API)
export {
  generateSuggestions,
  formatSuggestionDetails,
  hasSuggestions,
} from './suggestion-generator.js';
