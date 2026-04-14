/**
 * Shared string formatting utilities for the WorkRail Console.
 */

/**
 * Converts a camelCase or snake_case key to spaced uppercase.
 *
 * Examples:
 *   taskComplexity  -> TASK COMPLEXITY
 *   my_key          -> MY KEY
 *   someKey_name    -> SOME KEY NAME
 */
export function camelToSpacedUpper(key: string): string {
  return key
    .replace(/_/g, ' ')          // snake_case -> spaces
    .replace(/([A-Z])/g, ' $1')  // camelCase -> spaces
    .replace(/\s+/g, ' ')        // collapse consecutive spaces (mixed camelCase+snake_case)
    .toUpperCase()
    .trim();
}
