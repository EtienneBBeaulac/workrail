import { EnhancedContext } from '../../types/workflow-types';

type ConditionContext = Record<string, any>;

/**
 * Optimizes context operations to minimize performance overhead.
 * 
 * This is a utility class with only static methods - no instance state.
 * No DI registration needed since it's never instantiated.
 */
export class ContextOptimizer {
  /**
   * Creates a shallow enhanced context with minimal copying
   * Only copies top-level properties that are being modified
   */
  static createEnhancedContext(
    base: ConditionContext,
    enhancements: Partial<EnhancedContext>
  ): EnhancedContext {
    // Optimize by only copying what's needed
    // If no enhancements have existing values, we can use Object.assign
    const hasOverlap = Object.keys(enhancements).some(key => key in base);
    
    if (!hasOverlap) {
      // Fast path: no overlap, just assign
      return Object.assign({}, base, enhancements) as EnhancedContext;
    }
    
    // Slower path: merge with spread
    return { ...base, ...enhancements } as EnhancedContext;
  }

  /**
   * Efficiently merges loop state without deep cloning
   */
  static mergeLoopState(
    context: EnhancedContext,
    loopId: string,
    loopState: any
  ): EnhancedContext {
    // Use prototype chain if no existing _loopState
    if (!context._loopState) {
      return ContextOptimizer.createEnhancedContext(context, {
        _loopState: { [loopId]: loopState }
      });
    }
    
    // If _loopState exists, only clone if necessary
    if (context._loopState[loopId] === loopState) {
      return context; // No change needed
    }
    
    // Shallow clone only the _loopState object
    return ContextOptimizer.createEnhancedContext(context, {
      _loopState: { ...context._loopState, [loopId]: loopState }
    });
  }

  /**
   * Efficiently adds warnings without deep cloning
   */
  static addWarnings(
    context: EnhancedContext,
    category: string,
    key: string,
    warnings: string[]
  ): EnhancedContext {
    if (warnings.length === 0) {
      return context; // No warnings to add
    }

    // Build the warnings structure efficiently
    const existingWarnings = context._warnings || {};
    const categoryWarnings = existingWarnings[category as keyof typeof existingWarnings] || {};
    
    return ContextOptimizer.createEnhancedContext(context, {
      _warnings: {
        ...existingWarnings,
        [category]: {
          ...categoryWarnings,
          [key]: warnings
        }
      }
    });
  }

  /**
   * Checks if a property exists in the context or its prototype chain
   */
  static hasProperty(context: ConditionContext, property: string): boolean {
    return property in context;
  }

  /**
   * Gets a property value from context or its prototype chain
   */
  static getProperty(context: ConditionContext, property: string): any {
    return context[property];
  }

  /**
   * Measures the actual size of context data (excluding prototype chain)
   */
  static getOwnPropertiesSize(context: ConditionContext): number {
    // Only count own properties, not inherited ones
    const ownProps = Object.getOwnPropertyNames(context);
    let size = 0;
    
    for (const prop of ownProps) {
      const value = context[prop];
      if (typeof value === 'string') {
        size += value.length;
      } else {
        // Rough estimate for other types
        size += JSON.stringify(value).length;
      }
    }
    
    return size;
  }
} 