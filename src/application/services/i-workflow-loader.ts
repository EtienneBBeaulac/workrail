import { Workflow } from '../../types/mcp-types';

/**
 * Service responsible for loading and validating workflows.
 * Follows SRP - single concern: "Get me a validated workflow ready for execution"
 */
export interface IWorkflowLoader {
  /**
   * Loads a workflow by ID and validates its structure.
   * Also computes the set of loop body step IDs for efficient filtering.
   * 
   * @param workflowId - The workflow to load
   * @returns Validated workflow with pre-computed loop body steps
   * @throws {WorkflowNotFoundError} if workflow doesn't exist
   * @throws {Error} if workflow validation fails
   */
  loadAndValidate(workflowId: string): Promise<LoadedWorkflow>;
}

/**
 * Result of loading and validating a workflow.
 * Includes pre-computed metadata for efficient step resolution.
 */
export interface LoadedWorkflow {
  /** The validated workflow */
  workflow: Workflow;
  
  /** 
   * Set of step IDs that are loop bodies.
   * Pre-computed for efficient O(1) lookup during step selection.
   */
  loopBodySteps: Set<string>;
}
