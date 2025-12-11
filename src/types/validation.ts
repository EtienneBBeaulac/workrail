/**
 * Validation Types for Workflow Step Output Validation
 * 
 * Domain types that match spec/workflow.schema.json validation definitions.
 * These are used in workflow definitions and by the validation engine.
 */

import { Condition } from '../utils/condition-evaluator';

// =============================================================================
// VALIDATION RULE TYPES
// =============================================================================

/**
 * Validation rule for step output validation.
 * Matches spec/workflow.schema.json#/$defs/validationRule
 */
export interface ValidationRule {
  readonly type: 'contains' | 'regex' | 'length' | 'schema';
  readonly message: string;
  readonly value?: string;       // for 'contains' type
  readonly pattern?: string;     // for 'regex' type
  readonly flags?: string;       // for 'regex' type
  readonly min?: number;         // for 'length' type
  readonly max?: number;         // for 'length' type
  readonly schema?: Readonly<Record<string, unknown>>; // for 'schema' type
  readonly condition?: Condition; // for context-aware validation
}

/**
 * Logical composition of validation rules.
 * Matches spec/workflow.schema.json#/$defs/validationComposition
 */
export interface ValidationComposition {
  readonly and?: readonly ValidationCriteria[];
  readonly or?: readonly ValidationCriteria[];
  readonly not?: ValidationCriteria;
}

/**
 * Validation criteria - either a single rule or a logical composition.
 * Matches spec/workflow.schema.json#/$defs/validationCriteria
 */
export type ValidationCriteria = ValidationRule | ValidationComposition;

// =============================================================================
// VALIDATION RESULT TYPES
// =============================================================================

/**
 * Result of a validation operation.
 */
export interface ValidationResult {
  readonly valid: boolean;
  readonly issues: readonly string[];
  readonly suggestions: readonly string[];
  readonly warnings?: readonly string[];
  readonly info?: readonly string[];
}

// =============================================================================
// TYPE GUARDS
// =============================================================================

/**
 * Type guard to check if criteria is a single rule.
 */
export function isValidationRule(criteria: ValidationCriteria): criteria is ValidationRule {
  return 'type' in criteria && 'message' in criteria;
}

/**
 * Type guard to check if criteria is a composition.
 */
export function isValidationComposition(criteria: ValidationCriteria): criteria is ValidationComposition {
  return 'and' in criteria || 'or' in criteria || 'not' in criteria;
}
