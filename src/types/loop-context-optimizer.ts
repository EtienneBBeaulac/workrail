import { EnhancedContext, OptimizedLoopContext, LoopPhaseReference, LoopStep } from './workflow-types';

/**
 * Interface for the loop context optimization service
 * Handles progressive disclosure and context minimization for loops
 */
export interface ILoopContextOptimizer {
  /**
   * Optimizes loop context for subsequent iterations
   * @param context The current enhanced context
   * @param iteration The current iteration number (0-based)
   * @returns Optimized context with minimal data
   */
  optimizeLoopContext(context: EnhancedContext, iteration: number): OptimizedLoopContext;

  /**
   * Creates a phase reference for the loop
   * @param loopStep The loop step being executed
   * @returns Reference object for subsequent iterations
   */
  createPhaseReference(loopStep: LoopStep): LoopPhaseReference;

  /**
   * Checks if the loop has any items to process
   * @param context The context to check
   * @param loopStep The loop step configuration
   * @returns true if the loop has items to process
   */
  hasLoopItems(context: EnhancedContext, loopStep: LoopStep): boolean;

  /**
   * Strips unnecessary metadata from context for subsequent iterations
   * @param context The context to strip
   * @returns Context with minimal necessary data
   */
  stripLoopMetadata(context: EnhancedContext): OptimizedLoopContext;
}