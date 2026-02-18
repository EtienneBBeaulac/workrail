/**
 * Configuration for Parameter Suggestions
 *
 * Immutable configuration objects for suggestion generation.
 * Avoids magic numbers by making thresholds explicit and documented.
 *
 * @module mcp/validation/suggestion-config
 */

import { similarity, type Similarity } from './suggestion-types.js';

/**
 * Configuration for suggestion generation.
 * All fields are readonly to enforce immutability.
 */
export interface SuggestionConfig {
  /**
   * Minimum similarity score (0-1) required to suggest a match.
   * Lower values are more permissive (more suggestions).
   * 0.6 catches common typos like workflow_id → workflowId (~0.85 similarity).
   */
  readonly similarityThreshold: Similarity;

  /**
   * Maximum number of suggestions to include per error.
   * Limits noise in error responses.
   */
  readonly maxSuggestions: number;

  /**
   * Whether to include a correct template showing expected structure.
   * Useful for complex inputs like state objects.
   */
  readonly includeTemplate: boolean;

  /**
   * Maximum depth for template generation.
   * Prevents unbounded recursion in deeply nested schemas.
   */
  readonly maxTemplateDepth: number;

  /**
   * Whether to include optional fields in the correctTemplate.
   *
   * Set true for error-guidance contexts: agents need to see the FULL valid
   * structure when they've used wrong field names, not just the required-field
   * skeleton. For example, continue_workflow's correctTemplate should show
   * output.notesMarkdown even though output is optional.
   */
  readonly includeOptionalInTemplate: boolean;
}

/**
 * Default configuration optimized for agent self-correction.
 *
 * These values are tuned based on observed agent errors:
 * - 0.6 threshold catches snake_case → camelCase conversions
 * - 3 suggestions avoids overwhelming the agent
 * - Templates help with complex nested objects
 */
export const DEFAULT_SUGGESTION_CONFIG: SuggestionConfig = {
  similarityThreshold: similarity(0.6),
  maxSuggestions: 3,
  includeTemplate: true,
  maxTemplateDepth: 3,
  // Show optional fields in error templates — agents need the full structure
  // to self-correct, not just the required-field skeleton.
  includeOptionalInTemplate: true,
} as const;

/**
 * Minimal configuration for performance-sensitive paths.
 * Only does unknown key detection, no templates.
 */
export const MINIMAL_SUGGESTION_CONFIG: SuggestionConfig = {
  similarityThreshold: similarity(0.7),
  maxSuggestions: 1,
  includeTemplate: false,
  maxTemplateDepth: 1,
  includeOptionalInTemplate: false,
} as const;
