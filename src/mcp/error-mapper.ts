import type { DomainError } from '../domain/execution/error.js';
import type { ErrorCode, ToolRetry, JsonValue } from './types.js';
import { toBoundedJsonString } from './validation/bounded-json.js';

export interface ToolErrorMapping {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retry: ToolRetry;
  readonly suggestion?: string;
  readonly details?: JsonValue;
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
        retry: { kind: 'not_retryable' },
        suggestion: `Check available workflows with workflow_list`,
      };

    case 'InvalidState':
      return {
        code: 'VALIDATION_ERROR',
        message: err.message,
        retry: { kind: 'not_retryable' },
        suggestion:
          `Use the "state" returned by the last workflow_next call.\n` +
          `If you are completing a step, send an event like:\n` +
          toBoundedJsonString(
            {
              kind: 'step_completed',
              stepInstanceId: {
                stepId: '<previous next.stepInstanceId.stepId>',
                loopPath: [],
              },
            },
            512
          ),
      };

    case 'InvalidLoop':
      return {
        code: 'VALIDATION_ERROR',
        message: err.message,
        retry: { kind: 'not_retryable' },
        suggestion: 'Validate the workflow definition and ensure loop/body step IDs are consistent',
      };

    case 'MissingContext':
      return {
        code: 'PRECONDITION_FAILED',
        message: err.message,
        retry: { kind: 'not_retryable' },
        suggestion:
          'Provide the required keys in the `context` object for condition evaluation and loop inputs.\n' +
          'Example:\n' +
          toBoundedJsonString({ context: { '<requiredKey>': '<value>' } }, 256),
      };

    case 'ConditionEvalFailed':
      return {
        code: 'INTERNAL_ERROR',
        message: err.message,
        retry: { kind: 'not_retryable' },
        suggestion: 'Validate workflow JSON and condition expressions with workflow_validate_json',
      };

    case 'MaxIterationsExceeded':
      return {
        code: 'PRECONDITION_FAILED',
        message: err.message,
        retry: { kind: 'not_retryable' },
        suggestion: `Increase maxIterations for loop '${err.loopId}' or adjust its condition/body`,
      };

    default:
      return assertNever(err);
  }
}

export function mapUnknownErrorToToolError(err: unknown): ToolErrorMapping {
  if (err instanceof Error) {
    return { code: 'INTERNAL_ERROR', message: err.message, retry: { kind: 'not_retryable' } };
  }
  return { code: 'INTERNAL_ERROR', message: String(err), retry: { kind: 'not_retryable' } };
}
