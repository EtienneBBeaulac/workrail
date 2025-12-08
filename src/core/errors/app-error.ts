/**
 * Error Hierarchy - Discriminated Unions
 * 
 * Philosophy: Errors are data, not exceptions. Organized by user action.
 * All errors readonly, AI-friendly, exhaustively handled.
 */

// ============================================================================
// Error Categories
// ============================================================================

export type AppError =
  | ResourceError
  | DataError
  | ConfigurationError
  | InternalError;

// ============================================================================
// Resource Errors (User Input Problems - AI Can Suggest Fixes)
// ============================================================================

export type ResourceError =
  | WorkflowNotFoundError
  | StepNotFoundError
  | SessionNotFoundError;

export interface WorkflowNotFoundError {
  readonly _tag: 'WorkflowNotFound';
  readonly workflowId: string;
  readonly suggestions: readonly string[];
  readonly availableCount: number;
  readonly topWorkflows: readonly { readonly id: string; readonly name: string }[];
  readonly message: string;
}

export interface StepNotFoundError {
  readonly _tag: 'StepNotFound';
  readonly stepId: string;
  readonly workflowId: string;
  readonly availableSteps: readonly string[];
  readonly message: string;
}

export interface SessionNotFoundError {
  readonly _tag: 'SessionNotFound';
  readonly sessionId: string;
  readonly workflowId?: string;
  readonly recentSessions: readonly string[];
  readonly message: string;
}

// ============================================================================
// Data Errors (Validation/Parsing Problems)
// ============================================================================

export type DataError =
  | ParseFailedError
  | ValidationFailedError
  | SchemaViolationError;

export interface ParseFailedError {
  readonly _tag: 'ParseFailed';
  readonly source: string;
  readonly format: 'json' | 'yaml';
  readonly line?: number;
  readonly column?: number;
  readonly details: string;
  readonly message: string;
}

export interface ValidationFailedError {
  readonly _tag: 'ValidationFailed';
  readonly field: string;
  readonly value: string;
  readonly issues: string;
  readonly expected?: string;
  readonly message: string;
}

export interface SchemaViolationError {
  readonly _tag: 'SchemaViolation';
  readonly path: string;
  readonly expected: string;
  readonly actual: string;
  readonly message: string;
}

// ============================================================================
// Configuration Errors (Setup Problems)
// ============================================================================

export type ConfigurationError =
  | ConfigInvalidError
  | StartupFailedError;

export interface ConfigInvalidError {
  readonly _tag: 'ConfigInvalid';
  readonly issues: readonly string[];
  readonly message: string;
}

export interface StartupFailedError {
  readonly _tag: 'StartupFailed';
  readonly phase: string;
  readonly details: string;
  readonly cause?: Error;
  readonly message: string;
}

// ============================================================================
// Internal Errors (Bugs)
// ============================================================================

export type InternalError =
  | UnexpectedError
  | ContextSizeExceededError
  | LoopStackCorruptionError
  | MaxIterationsExceededError;

export interface UnexpectedError {
  readonly _tag: 'UnexpectedError';
  readonly operation: string;
  readonly cause?: Error;
  readonly message: string;
}

export interface ContextSizeExceededError {
  readonly _tag: 'ContextSizeExceeded';
  readonly sizeKB: number;
  readonly maxKB: number;
  readonly operation: string;
  readonly message: string;
}

export interface LoopStackCorruptionError {
  readonly _tag: 'LoopStackCorruption';
  readonly loopId: string;
  readonly details: string;
  readonly message: string;
}

export interface MaxIterationsExceededError {
  readonly _tag: 'MaxIterationsExceeded';
  readonly workflowId: string;
  readonly iterations: number;
  readonly maxIterations: number;
  readonly loopIds: readonly string[];
  readonly message: string;
}
