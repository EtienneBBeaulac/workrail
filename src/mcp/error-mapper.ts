import type { DomainError } from '../domain/execution/error.js';
import type { ToolError } from './types.js';
import type { JsonValue } from './output-schemas.js';
import { toBoundedJsonString } from './validation/bounded-json.js';
import { internalSuggestion } from './handlers/v2-execution-helpers.js';

function assertNever(_x: never): ToolError {
  // This should never execute at runtime if all cases are handled.
  // Return a fail-closed error instead of throwing.
  return {
    type: 'error',
    code: 'INTERNAL_ERROR',
    message: 'WorkRail encountered an unexpected error. This is not caused by your input.',
    retry: { kind: 'not_retryable' },
    details: { suggestion: internalSuggestion('', 'WorkRail has an internal error.') },
  };
}

export function mapDomainErrorToToolError(err: DomainError): ToolError {
  switch (err._tag) {
    case 'WorkflowNotFound':
      return {
        type: 'error',
        code: 'NOT_FOUND',
        message: err.message,
        retry: { kind: 'not_retryable' },
        details: { suggestion: `Check available workflows with workflow_list` },
      };

    case 'InvalidState':
      return {
        type: 'error',
        code: 'VALIDATION_ERROR',
        message: err.message,
        retry: { kind: 'not_retryable' },
        details: {
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
        },
      };

    case 'InvalidLoop':
      return {
        type: 'error',
        code: 'VALIDATION_ERROR',
        message: err.message,
        retry: { kind: 'not_retryable' },
        details: { suggestion: 'Validate the workflow definition and ensure loop/body step IDs are consistent' },
      };

    case 'MissingContext':
      return {
        type: 'error',
        code: 'PRECONDITION_FAILED',
        message: err.message,
        retry: { kind: 'not_retryable' },
        details: {
          suggestion:
            'Provide the required keys in the `context` object for condition evaluation and loop inputs.\n' +
            'Example:\n' +
            toBoundedJsonString({ context: { '<requiredKey>': '<value>' } }, 256),
        },
      };

    case 'ConditionEvalFailed':
      return {
        type: 'error',
        code: 'INTERNAL_ERROR',
        message: err.message,
        retry: { kind: 'not_retryable' },
        details: { suggestion: 'Validate workflow JSON and condition expressions with workflow_validate_json' },
      };

    case 'MaxIterationsExceeded':
      return {
        type: 'error',
        code: 'PRECONDITION_FAILED',
        message: err.message,
        retry: { kind: 'not_retryable' },
        details: { suggestion: `Increase maxIterations for loop '${err.loopId}' or adjust its condition/body` },
      };

    default:
      return assertNever(err);
  }
}

export function mapUnknownErrorToToolError(_err: unknown): ToolError {
  return {
    type: 'error',
    code: 'INTERNAL_ERROR',
    message: 'WorkRail encountered an unexpected error. This is not caused by your input.',
    retry: { kind: 'not_retryable' },
    details: { suggestion: internalSuggestion('Retry the call.', 'WorkRail has an internal error.') },
  };
}
