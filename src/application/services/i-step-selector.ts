import { Workflow, WorkflowStep, WorkflowGuidance } from '../../types/mcp-types';
import { EnhancedContext } from '../../types/workflow-types';

/**
 * Service responsible for finding eligible steps in a workflow.
 * Follows SRP - single concern: "Find me the next step to execute"
 */
export interface IStepSelector {
  /**
   * Finds the next eligible step in the workflow.
   * Respects completion state, runConditions, and loop body membership.
   * 
   * @param workflow - The workflow to search
   * @param loopBodySteps - Set of step IDs that are loop bodies (skip unless in that loop)
   * @param completed - Array of completed step IDs
   * @param context - Current execution context for evaluating conditions
   * @returns Next eligible step or null if none found
   */
  findEligibleStep(
    workflow: Workflow,
    loopBodySteps: Set<string>,
    completed: string[],
    context: EnhancedContext
  ): WorkflowStep | null;

  /**
   * Handles the case when no eligible step is found.
   * Provides guidance on what context variables need to be set for conditional steps.
   * 
   * @param workflow - The workflow being executed
   * @param completed - Array of completed step IDs
   * @param context - Current execution context
   * @param loopBodySteps - Set of loop body step IDs to exclude from analysis
   * @returns Guidance message or null if workflow is truly complete
   */
  handleNoEligibleStep(
    workflow: Workflow,
    completed: string[],
    context: EnhancedContext,
    loopBodySteps: Set<string>
  ): WorkflowGuidance | null;
}
