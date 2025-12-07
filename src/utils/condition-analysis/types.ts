/**
 * Type definitions for condition analysis system.
 * 
 * This module defines the domain models for diagnosing why conditions fail
 * and providing actionable guidance to agents.
 * 
 * IMPORTANT: Diagnosis must match evaluateCondition() behavior, which uses
 * lenient comparison (case-insensitive, type-coercive).
 */

import { Condition } from '../condition-evaluator';

// =============================================================================
// DIAGNOSIS TYPES
// =============================================================================

/**
 * Diagnosis of why a condition failed.
 * Discriminated union for exhaustive pattern matching.
 * 
 * IMPORTANT: This diagnosis is based on LENIENT comparison behavior:
 * - Strings are compared case-insensitively ("Large" equals "large")
 * - Numbers and numeric strings are equivalent ("10" equals 10)
 * - Boolean strings are coerced ("yes"/"true"/"1" equals true)
 * 
 * Therefore, there is NO "case-mismatch" diagnosis - case differences are allowed.
 */
export type ConditionDiagnosis =
  | MatchDiagnosis
  | MissingVariableDiagnosis
  | WrongValueDiagnosis
  | WrongTypeDiagnosis
  | AndCompositionDiagnosis
  | OrCompositionDiagnosis
  | NotCompositionDiagnosis
  | EvaluationErrorDiagnosis;

/**
 * Condition matched (shouldn't occur in failure diagnosis).
 */
export interface MatchDiagnosis {
  readonly type: 'match';
}

/**
 * Variable is missing from context (undefined or null).
 */
export interface MissingVariableDiagnosis {
  readonly type: 'missing-variable';
  readonly variable: string;
  readonly expectedValues: string[];  // Human-readable expected values
  readonly operator: ConditionOperator;
}

/**
 * Variable has wrong value (after lenient comparison).
 * 
 * NOTE: This only triggers if lenient comparison fails.
 * Case-only differences won't appear here (they pass lenient comparison).
 */
export interface WrongValueDiagnosis {
  readonly type: 'wrong-value';
  readonly variable: string;
  readonly expected: any;
  readonly current: any;
  readonly operator: ConditionOperator;
  readonly hint?: string;  // Optional explanation of lenient behavior
}

/**
 * Variable has wrong type for operator.
 * Example: gt operator expects number, got string that can't be coerced
 */
export interface WrongTypeDiagnosis {
  readonly type: 'wrong-type';
  readonly variable: string;
  readonly expectedType: 'number' | 'string' | 'boolean';
  readonly currentType: string;
  readonly operator: ConditionOperator;
}

/**
 * AND composition where some sub-conditions failed.
 * All must pass, but some didn't.
 */
export interface AndCompositionDiagnosis {
  readonly type: 'and-composition';
  readonly failures: ConditionDiagnosis[];
  readonly totalConditions: number;
  readonly description: string;
}

/**
 * OR composition where all options failed.
 * At least one must pass, but none did.
 */
export interface OrCompositionDiagnosis {
  readonly type: 'or-composition';
  readonly failures: ConditionDiagnosis[];
  readonly totalOptions: number;
  readonly description: string;
}

/**
 * NOT composition where negated condition was true.
 */
export interface NotCompositionDiagnosis {
  readonly type: 'not-composition';
  readonly negatedDiagnosis: ConditionDiagnosis;
  readonly description: string;
}

/**
 * Condition evaluation threw an error (invalid regex, etc.).
 */
export interface EvaluationErrorDiagnosis {
  readonly type: 'evaluation-error';
  readonly error: string;
  readonly condition: Condition;
}

/**
 * Supported condition operators.
 */
export type ConditionOperator = 
  | 'equals' 
  | 'not_equals' 
  | 'gt' 
  | 'gte' 
  | 'lt' 
  | 'lte'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'matches'
  | 'truthy';  // Just { var: 'x' } with no operator

// =============================================================================
// BLOCKED STEP INFO
// =============================================================================

/**
 * Information about a workflow step that's blocked by unmet conditions.
 * Contains everything needed to explain and fix the blockage.
 */
export interface BlockedStepInfo {
  readonly stepId: string;
  readonly stepTitle: string;
  readonly condition: Condition;
  readonly diagnosis: ConditionDiagnosis;
  readonly relevantContext: Record<string, any>;
}
