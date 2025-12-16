import { 
  LoopConfig, 
  LoopState, 
  EnhancedContext, 
  OptimizedLoopContext,
  LoopPhaseReference,
  LoopStep 
} from '../../types/workflow-types';
import { ConditionContext, evaluateCondition } from '../../utils/condition-evaluator';

/**
 * Manages the execution state and context for a single loop instance.
 * Handles iteration tracking, condition evaluation, and context variable injection.
 */
export class LoopExecutionContext {
  private loopId: string;
  private loopConfig: LoopConfig;
  private state: LoopState[string];
  private readonly maxExecutionTime = 5 * 60 * 1000; // 5 minutes

  constructor(loopId: string, loopConfig: LoopConfig, existingState?: LoopState[string]) {
    this.loopId = loopId;
    this.loopConfig = loopConfig;
    this.state = existingState || {
      iteration: 0,
      started: Date.now(),
      warnings: []
    };

    // Initialize forEach-specific state only if not already present
    if (loopConfig.type === 'forEach' && loopConfig.items && this.state.index === undefined) {
      this.state.index = 0;
    }
  }

  /**
   * Increments the iteration counter and updates related state
   */
  incrementIteration(): void {
    this.state.iteration++;
    
    if (this.loopConfig.type === 'forEach' && typeof this.state.index === 'number') {
      this.state.index++;
    }
  }

  /**
   * Returns the current state of the loop
   */
  getCurrentState(): LoopState[string] {
    return { ...this.state };
  }

  /**
   * Determines if the loop should continue executing
   */
  shouldContinue(context: ConditionContext): boolean {
    // Check iteration limit
    if (this.state.iteration >= this.loopConfig.maxIterations) {
      this.addWarning(`Maximum iterations (${this.loopConfig.maxIterations}) reached`);
      return false;
    }

    // Check execution time
    const executionTime = Date.now() - this.state.started;
    if (executionTime > this.maxExecutionTime) {
      this.addWarning(`Maximum execution time (${this.maxExecutionTime / 1000}s) exceeded`);
      return false;
    }

    // Check loop-specific conditions
    switch (this.loopConfig.type) {
      case 'while':
        return this.loopConfig.condition 
          ? evaluateCondition(this.loopConfig.condition, context)
          : false;
      
      case 'until':
        return this.loopConfig.condition
          ? !evaluateCondition(this.loopConfig.condition, context)
          : false;
      
      case 'for':
        const count = this.resolveCount(context);
        return this.state.iteration < count;
      
      case 'forEach':
        return this.state.items 
          ? (this.state.index || 0) < this.state.items.length
          : false;
      
      default:
        return false;
    }
  }

  /**
   * Initializes forEach loop with items from context
   */
  initializeForEach(context: ConditionContext): void {
    if (this.loopConfig.type === 'forEach' && this.loopConfig.items) {
      const items = context[this.loopConfig.items];
      if (Array.isArray(items)) {
        this.state.items = items;
        this.state.index = 0;
      } else {
        this.addWarning(`Expected array for forEach items '${this.loopConfig.items}', got ${typeof items}`);
        this.state.items = [];
      }
    }
  }



  /**
   * Resolves the count for 'for' loops from number or context variable
   */
  private resolveCount(context: ConditionContext): number {
    if (this.loopConfig.type !== 'for' || !this.loopConfig.count) {
      return 0;
    }

    if (typeof this.loopConfig.count === 'number') {
      return this.loopConfig.count;
    }

    // Resolve from context variable
    const count = context[this.loopConfig.count];
    if (typeof count === 'number') {
      return count;
    }

    this.addWarning(`Invalid count value for 'for' loop: ${this.loopConfig.count}`);
    return 0;
  }

  /**
   * Adds a warning to the loop state
   */
  private addWarning(message: string): void {
    if (!this.state.warnings) {
      this.state.warnings = [];
    }
    this.state.warnings.push(message);
  }

  /**
   * Gets the loop ID
   */
  getLoopId(): string {
    return this.loopId;
  }

  /**
   * Gets the loop configuration
   */
  getLoopConfig(): LoopConfig {
    return { ...this.loopConfig };
  }

  /**
   * Gets the loop configuration (alias for compatibility)
   */
  getConfig(): LoopConfig {
    return this.getLoopConfig();
  }

  /**
   * Generates minimal context for subsequent loop iterations
   * Used for progressive disclosure pattern
   */
  getMinimalContext(context: ConditionContext): OptimizedLoopContext {
    // Start with a copy of context, excluding the items array for forEach loops
    const optimizedContext: OptimizedLoopContext = {
      ...context,
      _loopState: {
        ...(context as EnhancedContext)._loopState,
        [this.loopId]: this.getCurrentState()
      },
      _currentLoop: {
        loopId: this.loopId,
        loopType: this.loopConfig.type,
        iteration: this.state.iteration,
        isFirstIteration: false
      }
    };

    // Only inject current item for forEach loops, not entire array
    if (this.loopConfig.type === 'forEach' && this.state.items) {
      const index = this.state.index || 0;
      const itemVar = this.loopConfig.itemVar || 'currentItem';
      const indexVar = this.loopConfig.indexVar || 'currentIndex';
      
      optimizedContext[itemVar] = this.state.items[index];
      optimizedContext[indexVar] = index;
      
      // Remove the full items array from minimal context to save space
      if (this.loopConfig.items && optimizedContext[this.loopConfig.items] !== undefined) {
        delete optimizedContext[this.loopConfig.items];
      }
    }

    // Add iteration counter
    const iterationVar = this.loopConfig.iterationVar || 'currentIteration';
    optimizedContext[iterationVar] = this.state.iteration + 1;

    return optimizedContext;
  }

  /**
   * Creates a phase reference for this loop
   * Contains minimal information about the loop structure
   */
  getPhaseReference(loopStep: LoopStep): LoopPhaseReference {
    return {
      loopId: this.loopId,
      phaseTitle: loopStep.title,
      totalSteps: Array.isArray(loopStep.body) ? loopStep.body.length : 1,
      functionDefinitions: loopStep.functionDefinitions
    };
  }

  /**
   * Modified injectVariables to support minimal mode
   * @param context The context to enhance
   * @param minimal If true, only inject essential variables
   */
  injectVariables(context: ConditionContext, minimal: boolean = false): EnhancedContext | OptimizedLoopContext {
    if (minimal) {
      return this.getMinimalContext(context);
    }

    // Original implementation for full context
    return this.injectVariablesFull(context);
  }

  /**
   * Original full variable injection (renamed from injectVariables)
   */
  private injectVariablesFull(context: ConditionContext): EnhancedContext {
    // Build enhancements object efficiently
    const enhancements: Partial<EnhancedContext> = {
      _loopState: {
        ...(context as EnhancedContext)._loopState,
        [this.loopId]: this.getCurrentState()
      }
    };
    
    // Inject iteration counter
    const iterationVar = this.loopConfig.iterationVar || 'currentIteration';
    enhancements[iterationVar] = this.state.iteration + 1;

    // Inject forEach-specific variables
    if (this.loopConfig.type === 'forEach' && this.state.items) {
      const index = this.state.index || 0;
      
      // Current item
      const itemVar = this.loopConfig.itemVar || 'currentItem';
      enhancements[itemVar] = this.state.items[index];
      
      // Current index
      const indexVar = this.loopConfig.indexVar || 'currentIndex';
      enhancements[indexVar] = index;
    }

    // Add any warnings
    if (this.state.warnings && this.state.warnings.length > 0) {
      const existingWarnings = (context as EnhancedContext)._warnings || {};
      const existingLoopWarnings = existingWarnings.loops || {};
      
      enhancements._warnings = {
        ...existingWarnings,
        loops: {
          ...existingLoopWarnings,
          [this.loopId]: [...this.state.warnings]
        }
      };
    }

    // Create enhanced context by merging efficiently
    return { ...context, ...enhancements } as EnhancedContext;
  }

  /**
   * Checks if this is the first iteration
   */
  isFirstIteration(): boolean {
    return this.state.iteration === 0;
  }

  /**
   * Checks if the loop is empty (has no items to process)
   * Used to avoid sending phase overview for empty loops
   */
  isEmpty(context: ConditionContext): boolean {
    switch (this.loopConfig.type) {
      case 'forEach':
        // Check state.items first, but fall back to context if not initialized
        if (this.state.items) {
          return this.state.items.length === 0;
        }
        // Check the context directly if state.items hasn't been initialized
        if (this.loopConfig.items) {
          const items = context[this.loopConfig.items];
          return !Array.isArray(items) || items.length === 0;
        }
        return true;
      
      case 'for':
        const count = this.resolveCount(context);
        return count <= 0;
      
      case 'while':
        // Check condition immediately
        return this.loopConfig.condition 
          ? !evaluateCondition(this.loopConfig.condition, context)
          : true;
      
      case 'until':
        // Check condition immediately (inverted)
        return this.loopConfig.condition
          ? evaluateCondition(this.loopConfig.condition, context)
          : true;
      
      default:
        return false;
    }
  }
} 