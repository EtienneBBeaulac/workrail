/**
 * Utility for calculating the size of JavaScript objects in bytes
 */

const MAX_CONTEXT_SIZE = 256 * 1024; // 256KB
const WARNING_THRESHOLD = 0.8; // 80%

/**
 * Calculate the approximate size of an object in bytes
 * @param obj The object to measure
 * @returns Size in bytes
 */
export function calculateObjectSize(obj: any): number {
  const seen = new WeakSet();
  
  function sizeOf(value: any): number {
    // Handle primitives
    if (value === null) return 4;
    if (value === undefined) return 0;
    
    switch (typeof value) {
      case 'boolean':
        return 4;
      case 'number':
        return 8;
      case 'string':
        return value.length * 2; // Unicode chars can be 2 bytes
      case 'bigint':
        return value.toString().length * 2;
      case 'symbol':
        return value.toString().length * 2;
      case 'function':
        return 0; // Don't count function size
      case 'object':
        // Prevent circular reference infinite loops
        if (seen.has(value)) return 0;
        seen.add(value);
        
        let size = 0;
        
        // Handle arrays
        if (Array.isArray(value)) {
          size += 4; // Array overhead
          for (const item of value) {
            size += sizeOf(item);
          }
        }
        // Handle regular objects
        else {
          size += 4; // Object overhead
          for (const key in value) {
            if (value.hasOwnProperty(key)) {
              size += key.length * 2; // Key size
              size += sizeOf(value[key]); // Value size
            }
          }
        }
        
        return size;
      default:
        return 0;
    }
  }
  
  return sizeOf(obj);
}

/**
 * Check if context size is within limits and add warnings if needed
 * @param context The context object to check
 * @returns The context with size tracking and warnings
 */
export function checkContextSize(context: any): {
  context: any;
  sizeBytes: number;
  isWarning: boolean;
  isError: boolean;
} {
  const sizeBytes = calculateObjectSize(context);
  const warningThreshold = MAX_CONTEXT_SIZE * WARNING_THRESHOLD;
  
  const result = {
    context: { ...context },
    sizeBytes,
    isWarning: sizeBytes >= warningThreshold,
    isError: sizeBytes >= MAX_CONTEXT_SIZE
  };
  
  // Add size to context
  result.context._contextSize = sizeBytes;
  
  // Add warning if needed
  if (result.isWarning && !result.isError) {
    if (!result.context._warnings) {
      result.context._warnings = {};
    }
    if (!result.context._warnings.contextSize) {
      result.context._warnings.contextSize = [];
    }
    result.context._warnings.contextSize.push(
      `Context size (${Math.round(sizeBytes / 1024)}KB) exceeds 80% of maximum (256KB)`
    );
  }
  
  return result;
}

export const CONTEXT_SIZE_LIMITS = {
  MAX_SIZE: MAX_CONTEXT_SIZE,
  WARNING_THRESHOLD: WARNING_THRESHOLD,
  WARNING_SIZE: MAX_CONTEXT_SIZE * WARNING_THRESHOLD
}; 