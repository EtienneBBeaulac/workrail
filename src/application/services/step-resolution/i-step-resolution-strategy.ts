import { WorkflowStep, WorkflowGuidance } from '../../../types/mcp-types';
import { ConditionContext } from '../../../utils/condition-evaluator';

/**
 * Strategy for resolving the next step in a workflow.
 * 
 * This interface enables polymorphic step resolution - different algorithms
 * can be swapped at runtime via dependency injection.
 * 
 * Current implementations:
 * - IterativeStepResolutionStrategy: Zero-recursion with explicit loop stack
 * - RecursiveStepResolutionStrategy: Legacy recursive implementation (to be removed)
 */
export interface IStepResolutionStrategy {
  /**
   * Determines the next step in a workflow given completed steps and context.
   * 
   * @param workflowId - Unique identifier of the workflow to execute
   * @param completedSteps - Array of step IDs that have been completed
   * @param context - Execution context with variables for condition evaluation
   * @returns Next step to execute, guidance, completion status, and updated context
   * @throws {WorkflowNotFoundError} if workflow doesn't exist
   * @throws {MaxIterationsExceededError} if execution exceeds iteration limit
   * @throws {LoopStackCorruptionError} if loop stack becomes invalid
   */
  getNextStep(
    workflowId: string,
    completedSteps: string[],
    context: ConditionContext
  ): Promise<StepResolutionResult>;
}

/**
 * Result of step resolution.
 */
export interface StepResolutionResult {
  /** The next step to execute, or null if workflow is complete */
  step: WorkflowStep | null;
  
  /** Guidance for executing the step (includes prompt, agent role, etc.) */
  guidance: WorkflowGuidance;
  
  /** True if workflow has completed all steps */
  isComplete: boolean;
  
  /** Updated execution context (may include loop state, iteration variables, etc.) */
  context?: ConditionContext;
}
