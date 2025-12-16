import { WorkflowService } from '../services/workflow-service';
import { Workflow, WorkflowStepDefinition } from '../../types/workflow';
import { WorkflowNotFoundError } from '../../core/error-handler';
import { ConditionContext } from '../../utils/condition-evaluator';
import { initialExecutionState } from '../../domain/execution/state';

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
        // Find the first next step via the interpreter (authoritative)
        const next = await service.getNextStep(workflowId, initialExecutionState(), undefined, {} as ConditionContext);
        const firstStep =
          next.kind === 'ok'
            ? (next.value.next ? next.value.next.step : null)
            : null;
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
 * @deprecated Use createGetWorkflow factory function instead
 * Legacy export for backward compatibility
 */
export async function getWorkflow(
  service: WorkflowService,
  workflowId: string
): Promise<Workflow> {
  return createGetWorkflow(service)(workflowId, 'preview') as Promise<Workflow>;
} 