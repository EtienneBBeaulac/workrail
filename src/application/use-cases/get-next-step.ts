import { WorkflowService } from '../services/workflow-service';
import { ConditionContext } from '../../utils/condition-evaluator';
import type { ExecutionState } from '../../domain/execution/state';
import type { WorkflowEvent } from '../../domain/execution/event';

/**
 * Factory function that creates a pure use-case for getting next workflow step.
 * Dependencies are injected at creation time, returning a pure function.
 */
export function createGetNextStep(service: WorkflowService) {
  return async (
    workflowId: string,
    state: ExecutionState,
    event?: WorkflowEvent,
    context?: ConditionContext
  ) => {
    return service.getNextStep(workflowId, state, event, context);
  };
}