import { WorkflowService } from '../services/workflow-service';
import { Workflow, WorkflowStepDefinition } from '../../types/workflow';
import { WorkflowNotFoundError } from '../../core/error-handler';
import { evaluateCondition, ConditionContext } from '../../utils/condition-evaluator';

// Define the mode type
export type WorkflowGetMode = 'metadata' | 'preview' | undefined;

// Define the response types for different modes
export interface WorkflowMetadata {
  id: string;
  name: string;
  description: string;
  version: string;
  preconditions?: readonly string[] | undefined;
  clarificationPrompts?: readonly string[] | undefined;
  metaGuidance?: readonly string[] | undefined;
  totalSteps: number;
}

export interface WorkflowPreview extends WorkflowMetadata {
  firstStep: WorkflowStepDefinition | null;
}

export type WorkflowGetResult = Workflow | WorkflowMetadata | WorkflowPreview;

/**
 * Factory function that creates a pure use-case for retrieving workflows.
 * Dependencies are injected at creation time, returning a pure function.
 */
export function createGetWorkflow(service: WorkflowService) {
  return async (workflowId: string, mode: WorkflowGetMode = 'preview'): Promise<WorkflowGetResult> => {
    const workflow = await service.getWorkflowById(workflowId);
    if (!workflow) {
      throw new WorkflowNotFoundError(workflowId);
    }

    // Handle different modes
    switch (mode) {
      case 'metadata':
        return {
          id: workflow.definition.id,
          name: workflow.definition.name,
          description: workflow.definition.description,
          version: workflow.definition.version,
          preconditions: workflow.definition.preconditions,
          clarificationPrompts: workflow.definition.clarificationPrompts,
          metaGuidance: workflow.definition.metaGuidance,
          totalSteps: workflow.definition.steps.length
        };

      case 'preview':
      default:
        // Find the first eligible step (similar to workflow_next logic)
        const firstStep = findFirstEligibleStep(workflow.definition.steps);
        return {
          id: workflow.definition.id,
          name: workflow.definition.name,
          description: workflow.definition.description,
          version: workflow.definition.version,
          preconditions: workflow.definition.preconditions,
          clarificationPrompts: workflow.definition.clarificationPrompts,
          metaGuidance: workflow.definition.metaGuidance,
          totalSteps: workflow.definition.steps.length,
          firstStep
        };
    }
  };
}

/**
 * Helper function to find the first eligible step in a workflow.
 * Uses the same logic as workflow_next but with empty completed steps and context.
 */
function findFirstEligibleStep(steps: readonly WorkflowStepDefinition[], context: ConditionContext = {}): WorkflowStepDefinition | null {
  return steps.find((step) => {
    // If step has a runCondition, evaluate it
    if (step.runCondition) {
      return evaluateCondition(step.runCondition, context);
    }
    
    // No condition means step is eligible
    return true;
  }) || null;
}

/**
 * @deprecated Use createGetWorkflow factory function instead
 * Legacy export for backward compatibility
 */
export async function getWorkflow(
  service: WorkflowService,
  workflowId: string
): Promise<Workflow> {
  return createGetWorkflow(service)(workflowId, 'preview') as Promise<Workflow>;
} 