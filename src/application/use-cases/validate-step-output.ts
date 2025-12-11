import { WorkflowService } from '../services/workflow-service';

/**
 * Factory function that creates a pure use-case for validating step output.
 * Dependencies are injected at creation time, returning a pure function.
 */
export function createValidateStepOutput(service: WorkflowService) {
  return async (
    workflowId: string,
    stepId: string,
    output: string
  ): Promise<{ valid: boolean; issues: readonly string[]; suggestions: readonly string[] }> => {
    return service.validateStepOutput(workflowId, stepId, output);
  };
}

/**
 * @deprecated Use createValidateStepOutput factory function instead
 * Legacy export for backward compatibility
 */
export async function validateStepOutput(
  service: WorkflowService,
  workflowId: string,
  stepId: string,
  output: string
): Promise<{ valid: boolean; issues: readonly string[]; suggestions: readonly string[] }> {
  return createValidateStepOutput(service)(workflowId, stepId, output);
} 