import { singleton } from 'tsyringe';
import { 
  EnhancedContext, 
  OptimizedLoopContext, 
  LoopPhaseReference, 
  LoopStep,
  isLoopStep
} from '../../types/workflow-types';
import { ILoopContextOptimizer } from '../../types/loop-context-optimizer';
import { ContextOptimizer } from './context-optimizer';

/**
 * Service for optimizing loop context to reduce payload size
 * Implements progressive disclosure pattern for loop iterations
 */
@singleton()
export class LoopContextOptimizer implements ILoopContextOptimizer {
  /**
   * Optimizes loop context for subsequent iterations
   * Removes full loop step data and replaces with minimal reference
   */
  public optimizeLoopContext(context: EnhancedContext, iteration: number): OptimizedLoopContext {
    if (!context._currentLoop) {
      throw new Error('Cannot optimize context without active loop');
    }

    const { loopId, loopStep } = context._currentLoop;
    const isFirstIteration = iteration === 0;

    // Create optimized context with minimal loop data
    const optimizedContext: OptimizedLoopContext = {
      ...context,
      _currentLoop: {
        loopId,
        loopType: loopStep.loop.type,
        iteration,
        isFirstIteration
      }
    };

    // For subsequent iterations, add phase reference
    if (!isFirstIteration && optimizedContext._currentLoop) {
      optimizedContext._currentLoop.phaseReference = this.createPhaseReference(loopStep);
      
      // Strip unnecessary data for subsequent iterations
      return this.stripLoopMetadata(optimizedContext as EnhancedContext);
    }

    return optimizedContext;
  }

  /**
   * Creates a phase reference for the loop
   * Contains minimal information needed to understand loop context
   */
  public createPhaseReference(loopStep: LoopStep): LoopPhaseReference {
    const reference: LoopPhaseReference = {
      loopId: loopStep.id,
      phaseTitle: loopStep.title,
      totalSteps: Array.isArray(loopStep.body) ? loopStep.body.length : 1
    };

    // Include loop-level function definitions if present
    if (loopStep.functionDefinitions && loopStep.functionDefinitions.length > 0) {
      reference.functionDefinitions = loopStep.functionDefinitions;
    }

    return reference;
  }

  /**
   * Checks if the loop has any items to process
   * Helps avoid sending phase overview for empty loops
   */
  public hasLoopItems(context: EnhancedContext, loopStep: LoopStep): boolean {
    const { loop } = loopStep;

    switch (loop.type) {
      case 'forEach':
        if (loop.items) {
          const items = context[loop.items];
          return Array.isArray(items) && items.length > 0;
        }
        return false;

      case 'for':
        const count = typeof loop.count === 'number' 
          ? loop.count 
          : (loop.count ? context[loop.count] : 0);
        return count > 0;

      case 'while':
      case 'until':
        // Can't determine if while/until loops are empty without evaluation
        // Return true to be safe
        return true;

      default:
        return false;
    }
  }

  /**
   * Strips unnecessary metadata from context for subsequent iterations
   * Keeps only essential data needed for step execution
   */
  public stripLoopMetadata(context: EnhancedContext): OptimizedLoopContext {
    // First convert to optimized context if needed
    let optimizedContext: OptimizedLoopContext;
    
    if ('loopType' in (context._currentLoop || {})) {
      optimizedContext = context as unknown as OptimizedLoopContext;
    } else if (context._currentLoop) {
      // Convert from EnhancedContext to OptimizedLoopContext
      const { loopId, loopStep } = context._currentLoop;
      const iteration = context._loopState?.[loopId]?.iteration || 0;
      
      optimizedContext = {
        ...context,
        _currentLoop: {
          loopId,
          loopType: loopStep.loop.type,
          iteration,
          isFirstIteration: iteration === 0
        }
      };
    } else {
      // No loop context, just return as-is
      return context as unknown as OptimizedLoopContext;
    }

    // Create a shallow copy to avoid mutations
    const strippedContext = { ...optimizedContext };

    // Remove large arrays from forEach context (keep only current item)
    if (strippedContext._currentLoop?.loopType === 'forEach') {
      // Find and minimize array data
      const loopState = strippedContext._loopState;
      if (loopState) {
        Object.keys(loopState).forEach(loopId => {
          const state = loopState[loopId];
          if (state.items && Array.isArray(state.items)) {
            // Keep only current item index, not full array
            const currentIndex = state.index || 0;
            if (currentIndex < state.items.length) {
              // Store just the current item reference
              state.items = [state.items[currentIndex]];
              state.index = 0; // Reset index since we only have one item
            }
          }
        });
      }
    }

    // Remove any large context variables that aren't needed
    // This is a conservative approach - only remove known large data
    const keysToCheck = Object.keys(strippedContext);
    keysToCheck.forEach(key => {
      // Skip internal properties
      if (key.startsWith('_')) return;

      const value = strippedContext[key];
      // Remove large arrays except the one being iterated
      if (Array.isArray(value) && value.length > 10) {
        // Check if this is the array being iterated
        const currentLoop = strippedContext._currentLoop;
        if (currentLoop?.loopType === 'forEach') {
          const loopState = strippedContext._loopState?.[currentLoop.loopId];
          if (loopState?.items === value) {
            // This is the array being iterated, keep it minimal
            return;
          }
        }
        // Remove other large arrays
        delete strippedContext[key];
      }
    });

    return strippedContext;
  }
}