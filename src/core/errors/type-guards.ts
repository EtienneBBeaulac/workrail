/**
 * Error Type Guards
 */

import type {
  AppError,
  ResourceError,
  DataError,
  ConfigurationError,
  InternalError,
  WorkflowNotFoundError,
  TransientError,
} from './app-error.js';

export function isAppError(e: unknown): e is AppError {
  return typeof e === 'object' && e !== null && '_tag' in e;
}

export function isResourceError(e: AppError): e is ResourceError {
  return e._tag === 'WorkflowNotFound' 
    || e._tag === 'StepNotFound' 
    || e._tag === 'SessionNotFound';
}

export function isDataError(e: AppError): e is DataError {
  return e._tag === 'ParseFailed' 
    || e._tag === 'ValidationFailed' 
    || e._tag === 'SchemaViolation';
}

export function isConfigurationError(e: AppError): e is ConfigurationError {
  return e._tag === 'ConfigInvalid' || e._tag === 'StartupFailed';
}

export function isInternalError(e: AppError): e is InternalError {
  return e._tag === 'UnexpectedError' 
    || e._tag === 'ContextSizeExceeded'
    || e._tag === 'LoopStackCorruption'
    || e._tag === 'MaxIterationsExceeded';
}

export function isWorkflowNotFound(e: AppError): e is WorkflowNotFoundError {
  return e._tag === 'WorkflowNotFound';
}

export function isRetriable(e: AppError): boolean {
  return e._tag === 'StartupFailed';
}

export function assertNever(value: never): never {
  throw new Error(`Unreachable code reached: ${JSON.stringify(value)}`);
}
