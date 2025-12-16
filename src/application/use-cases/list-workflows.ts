import { WorkflowService } from '../services/workflow-service';
import { WorkflowSummary } from '../../types/workflow';

/**
 * Factory function that creates a pure use-case for listing workflows.
 * Dependencies are injected at creation time, returning a pure function.
 */
export function createListWorkflows(service: WorkflowService) {
  return async (): Promise<readonly WorkflowSummary[]> => {
    return service.listWorkflowSummaries();
  };
}

/**
 * @deprecated Use createListWorkflows factory function instead
 * Legacy export for backward compatibility
 */
export async function listWorkflows(
  service: WorkflowService
): Promise<readonly WorkflowSummary[]> {
  return createListWorkflows(service)();
} 