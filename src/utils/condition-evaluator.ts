/**
 * Safe condition evaluator for workflow step runCondition expressions.
 * Supports a limited set of operators to prevent code injection.
 */

export interface ConditionContext {
  [key: string]: any;
}

export interface Condition {
  var?: string;
  equals?: any;
  not_equals?: any;
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  // String matching operators
  contains?: string;
  startsWith?: string;
  endsWith?: string;
  matches?: string; // regex pattern
  // Logical operators
  and?: Condition[];
  or?: Condition[];
  not?: Condition;
}

/**
 * Performs lenient equality comparison between two values.
 * - Case-insensitive string comparison (after trimming whitespace)
 * - Type coercion for compatible types (string numbers to numbers)
 * - Treats null and undefined as equivalent
 */
function lenientEquals(a: any, b: any): boolean {
  // Handle null/undefined equivalence
  if (a == null && b == null) {
    return true;
  }
  if (a == null || b == null) {
    return false;
  }

  // If both are strings, do case-insensitive trimmed comparison
  if (typeof a === 'string' && typeof b === 'string') {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }

  // Type coercion for string-number conversions
  if ((typeof a === 'string' && typeof b === 'number') || 
      (typeof a === 'number' && typeof b === 'string')) {
    const numA = Number(a);
    const numB = Number(b);
    if (!isNaN(numA) && !isNaN(numB)) {
      return numA === numB;
    }
  }

  // Boolean coercion for string boolean values
  if (typeof a === 'string' && typeof b === 'boolean') {
    const lowerA = a.trim().toLowerCase();
    return (b === true && (lowerA === 'true' || lowerA === '1' || lowerA === 'yes')) ||
           (b === false && (lowerA === 'false' || lowerA === '0' || lowerA === 'no'));
  }
  if (typeof b === 'string' && typeof a === 'boolean') {
    return lenientEquals(b, a);
  }

  // Fall back to strict equality for other types
  return a === b;
}

/**
 * Normalizes a value to a string for string operations.
 */
function normalizeToString(value: any): string {
  if (value == null) {
    return '';
  }
  return String(value).trim();
}

/**
 * Evaluates a condition expression against a context.
 * Returns true if the condition passes, false otherwise.
 * If condition is null/undefined, returns true (step is eligible).
 * If evaluation fails, returns false (step is skipped for safety).
 */
export function evaluateCondition(
  condition: Condition | null | undefined,
  context: ConditionContext = {}
): boolean {
  // No condition means step is always eligible
  if (!condition || typeof condition !== 'object') {
    return true;
  }

  // Empty object means no condition, so step is eligible
  if (Object.keys(condition).length === 0) {
    return true;
  }

  try {
    return evaluateConditionUnsafe(condition, context);
  } catch (error) {
    // Log error in production, but return false for safety
    console.warn('Condition evaluation failed:', error);
    return false;
  }
}

function evaluateConditionUnsafe(condition: Condition, context: ConditionContext): boolean {
  // Variable reference
  if (condition.var !== undefined) {
    const value = context[condition.var];
    
    // Comparison operators (using lenient comparison)
    if ('equals' in condition) {
      return lenientEquals(value, condition.equals);
    }
    if ('not_equals' in condition) {
      return !lenientEquals(value, condition.not_equals);
    }
    if (condition.gt !== undefined) {
      return typeof value === 'number' && value > condition.gt;
    }
    if (condition.gte !== undefined) {
      return typeof value === 'number' && value >= condition.gte;
    }
    if (condition.lt !== undefined) {
      return typeof value === 'number' && value < condition.lt;
    }
    if (condition.lte !== undefined) {
      return typeof value === 'number' && value <= condition.lte;
    }
    
    // String matching operators
    if (condition.contains !== undefined) {
      const valueStr = normalizeToString(value).toLowerCase();
      const searchStr = normalizeToString(condition.contains).toLowerCase();
      return valueStr.includes(searchStr);
    }
    if (condition.startsWith !== undefined) {
      const valueStr = normalizeToString(value).toLowerCase();
      const searchStr = normalizeToString(condition.startsWith).toLowerCase();
      return valueStr.startsWith(searchStr);
    }
    if (condition.endsWith !== undefined) {
      const valueStr = normalizeToString(value).toLowerCase();
      const searchStr = normalizeToString(condition.endsWith).toLowerCase();
      return valueStr.endsWith(searchStr);
    }
    if (condition.matches !== undefined) {
      const valueStr = normalizeToString(value);
      try {
        const regex = new RegExp(condition.matches, 'i'); // Case-insensitive by default
        return regex.test(valueStr);
      } catch (error) {
        // Invalid regex - return false for safety
        console.warn('Invalid regex pattern in condition:', condition.matches);
        return false;
      }
    }
    
    // If only var is specified, check for truthiness
    return !!value;
  }

  // Logical operators
  if (condition.and !== undefined) {
    if (!Array.isArray(condition.and)) {
      throw new Error('and operator requires an array');
    }
    return condition.and.every(subCondition => evaluateConditionUnsafe(subCondition, context));
  }

  if (condition.or !== undefined) {
    if (!Array.isArray(condition.or)) {
      throw new Error('or operator requires an array');
    }
    return condition.or.some(subCondition => evaluateConditionUnsafe(subCondition, context));
  }

  if (condition.not !== undefined) {
    return !evaluateConditionUnsafe(condition.not, context);
  }

  // Unknown condition format
  throw new Error('Invalid condition format');
}

/**
 * Validates that a condition uses only supported operators.
 * Throws an error if unsupported operators are found.
 */
export function validateCondition(condition: any): void {
  if (!condition || typeof condition !== 'object') {
    return;
  }

  const supportedKeys = [
    'var', 'equals', 'not_equals', 'gt', 'gte', 'lt', 'lte', 
    'contains', 'startsWith', 'endsWith', 'matches',
    'and', 'or', 'not'
  ];

  const conditionKeys = Object.keys(condition);
  const unsupportedKeys = conditionKeys.filter(key => !supportedKeys.includes(key));

  if (unsupportedKeys.length > 0) {
    throw new Error(`Unsupported condition operators: ${unsupportedKeys.join(', ')}`);
  }

  // Recursively validate nested conditions
  if (condition.and && Array.isArray(condition.and)) {
    condition.and.forEach(validateCondition);
  }
  if (condition.or && Array.isArray(condition.or)) {
    condition.or.forEach(validateCondition);
  }
  if (condition.not) {
    validateCondition(condition.not);
  }
} 