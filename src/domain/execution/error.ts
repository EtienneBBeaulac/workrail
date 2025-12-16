export type DomainError =
  | { readonly _tag: 'WorkflowNotFound'; readonly workflowId: string; readonly message: string }
  | { readonly _tag: 'InvalidState'; readonly message: string }
  | { readonly _tag: 'InvalidLoop'; readonly loopId: string; readonly message: string }
  | { readonly _tag: 'ConditionEvalFailed'; readonly message: string }
  | { readonly _tag: 'MaxIterationsExceeded'; readonly loopId: string; readonly maxIterations: number; readonly message: string }
  | { readonly _tag: 'MissingContext'; readonly message: string };

export const Err = {
  workflowNotFound: (workflowId: string): DomainError => ({
    _tag: 'WorkflowNotFound',
    workflowId,
    message: `Workflow '${workflowId}' not found`,
  }),
  invalidState: (message: string): DomainError => ({ _tag: 'InvalidState', message }),
  invalidLoop: (loopId: string, message: string): DomainError => ({ _tag: 'InvalidLoop', loopId, message }),
  conditionEvalFailed: (message: string): DomainError => ({ _tag: 'ConditionEvalFailed', message }),
  maxIterationsExceeded: (loopId: string, maxIterations: number): DomainError => ({
    _tag: 'MaxIterationsExceeded',
    loopId,
    maxIterations,
    message: `Loop '${loopId}' exceeded maxIterations (${maxIterations})`,
  }),
  missingContext: (message: string): DomainError => ({ _tag: 'MissingContext', message }),
} as const;

export function isRetriable(_e: DomainError): boolean {
  // Stateless workflow progression errors are not retriable by default.
  return false;
}
