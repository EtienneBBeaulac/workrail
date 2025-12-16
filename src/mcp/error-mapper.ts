import type { DomainError } from '../domain/execution/error.js';
import type { ErrorCode } from './types.js';

export interface ToolErrorMapping {
  readonly code: ErrorCode;
  readonly message: string;
  readonly suggestion?: string;
}

function assertNever(x: never): never {
  throw new Error(`Unhandled DomainError variant: ${JSON.stringify(x)}`);
}

export function mapDomainErrorToToolError(err: DomainError): ToolErrorMapping {
  switch (err._tag) {
    case 'WorkflowNotFound':
      return {
        code: 'NOT_FOUND',
        message: err.message,
        suggestion: `Check available workflows with workflow_list`,
      };

    case 'InvalidState':
      return {
        code: 'VALIDATION_ERROR',
        message: err.message,
        suggestion: 'Reset state to { kind: "init" } or use the state returned by the last workflow_next call',
      };

    case 'InvalidLoop':
      return {
        code: 'VALIDATION_ERROR',
        message: err.message,
        suggestion: 'Validate the workflow definition and ensure loop/body step IDs are consistent',
      };

    case 'MissingContext':
      return {
        code: 'PRECONDITION_FAILED',
        message: err.message,
        suggestion: 'Provide the required keys in the `context` object for condition evaluation',
      };

    case 'ConditionEvalFailed':
      return {
        code: 'INTERNAL_ERROR',
        message: err.message,
        suggestion: 'Validate workflow JSON and condition expressions with workflow_validate_json',
      };

    case 'MaxIterationsExceeded':
      return {
        code: 'PRECONDITION_FAILED',
        message: err.message,
        suggestion: `Increase maxIterations for loop '${err.loopId}' or adjust its condition/body`,
      };

    default:
      return assertNever(err);
  }
}

export function mapUnknownErrorToToolError(err: unknown): ToolErrorMapping {
  if (err instanceof Error) {
    return { code: 'INTERNAL_ERROR', message: err.message };
  }
  return { code: 'INTERNAL_ERROR', message: String(err) };
}
