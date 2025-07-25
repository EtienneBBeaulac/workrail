import { LoopConfig, LoopState, EnhancedContext } from '../../types/workflow-types';
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
   * Injects loop-specific variables into the execution context
   */
  injectVariables(context: ConditionContext): EnhancedContext {
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
} 