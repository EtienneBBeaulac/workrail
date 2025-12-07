/**
 * Condition diagnosis functions.
 * 
 * Pure functions that analyze condition failures and return detailed diagnoses.
 * All functions are side-effect free: Condition + Context → Diagnosis
 * 
 * CRITICAL: These functions use lenientEquals() to match evaluateCondition() behavior.
 * This means:
 * - String comparisons are case-insensitive
 * - Type coercion happens (string "10" equals number 10)
 * - Boolean coercion happens ("yes"/"true" equals true)
 * 
 * We diagnose ACTUAL failures, not what would fail under strict comparison.
 */

import { Condition, ConditionContext, lenientEquals } from '../condition-evaluator';
import {
  ConditionDiagnosis,
  ConditionOperator,
  MissingVariableDiagnosis,
  WrongValueDiagnosis,
  WrongTypeDiagnosis,
  AndCompositionDiagnosis,
  OrCompositionDiagnosis,
  NotCompositionDiagnosis
} from './types';

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Diagnose why a condition failed.
 * 
 * Pure function that analyzes a condition and context to determine
 * exactly why the condition didn't pass.
 * 
 * Uses lenient comparison logic (same as evaluateCondition) to ensure
 * diagnosis matches actual evaluation behavior.
 * 
 * @param condition - The condition that failed
 * @param context - Current execution context
 * @returns Detailed diagnosis of the failure
 * 
 * @example
 * // Missing variable
 * diagnoseConditionFailure({ var: 'mode', equals: 'active' }, {})
 * // → { type: 'missing-variable', variable: 'mode', expectedValues: ['active'], operator: 'equals' }
 * 
 * @example
 * // Wrong value (lenient comparison failed)
 * diagnoseConditionFailure({ var: 'status', equals: 'ready' }, { status: 'pending' })
 * // → { type: 'wrong-value', variable: 'status', expected: 'ready', current: 'pending', operator: 'equals' }
 */
export function diagnoseConditionFailure(
  condition: Condition,
  context: ConditionContext
): ConditionDiagnosis {
  // Simple variable conditions
  if (condition.var !== undefined) {
    return diagnoseSimpleCondition(condition, context);
  }
  
  // Logical AND
  if (condition.and !== undefined) {
    return diagnoseAndCondition(condition.and, context);
  }
  
  // Logical OR
  if (condition.or !== undefined) {
    return diagnoseOrCondition(condition.or, context);
  }
  
  // Logical NOT
  if (condition.not !== undefined) {
    return diagnoseNotCondition(condition.not, context);
  }
  
  // Shouldn't reach here with valid condition
  return { type: 'match' };
}

// =============================================================================
// SIMPLE CONDITION DIAGNOSIS
// =============================================================================

function diagnoseSimpleCondition(
  condition: Condition,
  context: ConditionContext
): ConditionDiagnosis {
  const varName = condition.var!;
  const currentValue = context[varName];
  
  // CASE 1: Variable is missing (undefined or null)
  if (currentValue === undefined || currentValue === null) {
    return diagnoseMissingVariable(condition, varName);
  }
  
  // CASE 2: Has 'equals' operator
  if ('equals' in condition) {
    return diagnoseEqualsCondition(condition, varName, currentValue);
  }
  
  // CASE 3: Has 'not_equals' operator
  if ('not_equals' in condition) {
    return diagnoseNotEqualsCondition(condition, varName, currentValue);
  }
  
  // CASE 4: Numeric comparison operators
  if (hasNumericOperator(condition)) {
    return diagnoseNumericCondition(condition, varName, currentValue);
  }
  
  // CASE 5: String operators
  if (hasStringOperator(condition)) {
    return diagnoseStringCondition(condition, varName, currentValue);
  }
  
  // CASE 6: Truthy check (just { var: 'x' })
  return {
    type: 'wrong-value',
    variable: varName,
    expected: 'truthy value (non-zero, non-empty, non-false)',
    current: currentValue,
    operator: 'truthy'
  };
}

function diagnoseMissingVariable(
  condition: Condition,
  varName: string
): MissingVariableDiagnosis {
  const operator = getOperatorFromCondition(condition);
  const expectedValues = extractExpectedValues(condition);
  
  return {
    type: 'missing-variable',
    variable: varName,
    expectedValues,
    operator
  };
}

function diagnoseEqualsCondition(
  condition: Condition,
  varName: string,
  currentValue: any
): ConditionDiagnosis {
  const expected = condition.equals;
  
  // Use SAME lenient comparison as evaluateCondition
  if (lenientEquals(currentValue, expected)) {
    // Shouldn't happen - condition should have passed
    return { type: 'match' };
  }
  
  // Failed lenient comparison - truly wrong value
  return {
    type: 'wrong-value',
    variable: varName,
    expected,
    current: currentValue,
    operator: 'equals',
    hint: 'Comparison is case-insensitive and type-coercive'
  };
}

function diagnoseNotEqualsCondition(
  condition: Condition,
  varName: string,
  currentValue: any
): ConditionDiagnosis {
  const notExpected = condition.not_equals;
  
  // Use SAME lenient comparison as evaluateCondition
  if (lenientEquals(currentValue, notExpected)) {
    // Value equals what it shouldn't (lenient comparison)
    return {
      type: 'wrong-value',
      variable: varName,
      expected: `anything except "${notExpected}"`,
      current: currentValue,
      operator: 'not_equals',
      hint: 'Comparison is case-insensitive and type-coercive'
    };
  }
  
  // This shouldn't happen if condition failed
  return { type: 'match' };
}

function diagnoseNumericCondition(
  condition: Condition,
  varName: string,
  currentValue: any
): ConditionDiagnosis {
  // Check if value is numeric
  if (typeof currentValue !== 'number') {
    const operator = getNumericOperator(condition);
    return {
      type: 'wrong-type',
      variable: varName,
      expectedType: 'number',
      currentType: typeof currentValue,
      operator: operator!
    };
  }
  
  // Value is numeric but comparison failed
  const operator = getNumericOperator(condition)!;
  const threshold = getNumericThreshold(condition, operator);
  
  return {
    type: 'wrong-value',
    variable: varName,
    expected: formatNumericExpectation(operator, threshold),
    current: currentValue,
    operator
  };
}

function diagnoseStringCondition(
  condition: Condition,
  varName: string,
  currentValue: any
): ConditionDiagnosis {
  const operator = getStringOperator(condition)!;
  const expected = getStringValue(condition, operator);
  
  // String operators use case-insensitive comparison
  return {
    type: 'wrong-value',
    variable: varName,
    expected: formatStringExpectation(operator, expected),
    current: currentValue,
    operator,
    hint: 'String matching is case-insensitive'
  };
}

// =============================================================================
// COMPOSITION DIAGNOSIS
// =============================================================================

function diagnoseAndCondition(
  conditions: Condition[],
  context: ConditionContext
): AndCompositionDiagnosis {
  const diagnoses = conditions.map(c => diagnoseConditionFailure(c, context));
  const failures = diagnoses.filter(d => d.type !== 'match');
  
  return {
    type: 'and-composition',
    failures,
    totalConditions: conditions.length,
    description: `All ${conditions.length} conditions must be true, but ${failures.length} failed`
  };
}

function diagnoseOrCondition(
  conditions: Condition[],
  context: ConditionContext
): OrCompositionDiagnosis {
  const diagnoses = conditions.map(c => diagnoseConditionFailure(c, context));
  const failures = diagnoses.filter(d => d.type !== 'match');
  
  return {
    type: 'or-composition',
    failures,
    totalOptions: conditions.length,
    description: `At least one of ${conditions.length} conditions must be true, but all ${failures.length} failed`
  };
}

function diagnoseNotCondition(
  condition: Condition,
  context: ConditionContext
): NotCompositionDiagnosis {
  // NOT failed means the negated condition was TRUE
  // We diagnose the negated condition to show what needs to change
  const negatedDiagnosis = diagnoseConditionFailure(condition, context);
  
  return {
    type: 'not-composition',
    negatedDiagnosis,
    description: 'Negated condition should be false, but it is true'
  };
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function hasNumericOperator(condition: Condition): boolean {
  return 'gt' in condition || 'gte' in condition || 'lt' in condition || 'lte' in condition;
}

function hasStringOperator(condition: Condition): boolean {
  return 'contains' in condition || 'startsWith' in condition || 'endsWith' in condition || 'matches' in condition;
}

function getNumericOperator(condition: Condition): ConditionOperator | null {
  if ('gt' in condition) return 'gt';
  if ('gte' in condition) return 'gte';
  if ('lt' in condition) return 'lt';
  if ('lte' in condition) return 'lte';
  return null;
}

function getNumericThreshold(condition: Condition, operator: ConditionOperator): number {
  switch (operator) {
    case 'gt': return condition.gt!;
    case 'gte': return condition.gte!;
    case 'lt': return condition.lt!;
    case 'lte': return condition.lte!;
    default: return 0;
  }
}

function getStringOperator(condition: Condition): ConditionOperator | null {
  if ('contains' in condition) return 'contains';
  if ('startsWith' in condition) return 'startsWith';
  if ('endsWith' in condition) return 'endsWith';
  if ('matches' in condition) return 'matches';
  return null;
}

function getStringValue(condition: Condition, operator: ConditionOperator): string {
  switch (operator) {
    case 'contains': return condition.contains!;
    case 'startsWith': return condition.startsWith!;
    case 'endsWith': return condition.endsWith!;
    case 'matches': return condition.matches!;
    default: return '';
  }
}

function getOperatorFromCondition(condition: Condition): ConditionOperator {
  if ('equals' in condition) return 'equals';
  if ('not_equals' in condition) return 'not_equals';
  if ('gt' in condition) return 'gt';
  if ('gte' in condition) return 'gte';
  if ('lt' in condition) return 'lt';
  if ('lte' in condition) return 'lte';
  if ('contains' in condition) return 'contains';
  if ('startsWith' in condition) return 'startsWith';
  if ('endsWith' in condition) return 'endsWith';
  if ('matches' in condition) return 'matches';
  return 'truthy';
}

function extractExpectedValues(condition: Condition): string[] {
  if ('equals' in condition) {
    return [formatExpectedValue(condition.equals)];
  }
  if ('not_equals' in condition) {
    return [`anything except ${formatExpectedValue(condition.not_equals)}`];
  }
  if ('gt' in condition) {
    return [`greater than ${condition.gt}`];
  }
  if ('gte' in condition) {
    return [`greater than or equal to ${condition.gte}`];
  }
  if ('lt' in condition) {
    return [`less than ${condition.lt}`];
  }
  if ('lte' in condition) {
    return [`less than or equal to ${condition.lte}`];
  }
  if ('contains' in condition) {
    return [`containing "${condition.contains}"`];
  }
  if ('startsWith' in condition) {
    return [`starting with "${condition.startsWith}"`];
  }
  if ('endsWith' in condition) {
    return [`ending with "${condition.endsWith}"`];
  }
  if ('matches' in condition) {
    return [`matching pattern "${condition.matches}"`];
  }
  return ['truthy value'];
}

function formatExpectedValue(value: any): string {
  if (typeof value === 'string') return `"${value}"`;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'boolean') return String(value);
  return String(value);
}

function formatNumericExpectation(operator: ConditionOperator, threshold: number): string {
  switch (operator) {
    case 'gt': return `> ${threshold}`;
    case 'gte': return `>= ${threshold}`;
    case 'lt': return `< ${threshold}`;
    case 'lte': return `<= ${threshold}`;
    default: return String(threshold);
  }
}

function formatStringExpectation(operator: ConditionOperator, value: string): string {
  switch (operator) {
    case 'contains': return `containing "${value}"`;
    case 'startsWith': return `starting with "${value}"`;
    case 'endsWith': return `ending with "${value}"`;
    case 'matches': return `matching pattern "${value}"`;
    default: return `"${value}"`;
  }
}
