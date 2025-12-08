/**
 * Error Factories - Consistent Error Construction
 * 
 * CTC Pattern: Err namespace for all error constructors.
 * Ensures consistent error structure and helpful messages.
 */

import type {
  AppError,
  WorkflowNotFoundError,
  StepNotFoundError,
  SessionNotFoundError,
  ParseFailedError,
  ValidationFailedError,
  SchemaViolationError,
  ConfigInvalidError,
  StartupFailedError,
  UnexpectedError,
  ContextSizeExceededError,
  LoopStackCorruptionError,
  MaxIterationsExceededError,
} from './app-error.js';

export const Err = {
  // ==========================================================================
  // Resource Errors
  // ==========================================================================
  
  workflowNotFound: (
    workflowId: string,
    suggestions: readonly string[] = [],
    availableCount: number = 0,
    topWorkflows: readonly { id: string; name: string }[] = []
  ): WorkflowNotFoundError => ({
    _tag: 'WorkflowNotFound',
    workflowId,
    suggestions,
    availableCount,
    topWorkflows,
    message: suggestions.length > 0
      ? `Workflow "${workflowId}" not found. Did you mean: ${suggestions.slice(0, 3).join(', ')}?`
      : `Workflow "${workflowId}" not found (${availableCount} workflows available)`,
  }),
  
  stepNotFound: (
    stepId: string,
    workflowId: string,
    availableSteps: readonly string[] = []
  ): StepNotFoundError => ({
    _tag: 'StepNotFound',
    stepId,
    workflowId,
    availableSteps,
    message: `Step "${stepId}" not found in workflow "${workflowId}". Available: ${availableSteps.slice(0, 5).join(', ')}`,
  }),
  
  sessionNotFound: (
    sessionId: string,
    workflowId?: string,
    recentSessions: readonly string[] = []
  ): SessionNotFoundError => ({
    _tag: 'SessionNotFound',
    sessionId,
    workflowId,
    recentSessions,
    message: recentSessions.length > 0
      ? `Session "${sessionId}" not found. Recent: ${recentSessions.slice(0, 3).join(', ')}`
      : `Session "${sessionId}" not found`,
  }),
  
  // ==========================================================================
  // Data Errors
  // ==========================================================================
  
  parseFailed: (
    source: string,
    format: 'json' | 'yaml',
    details: string,
    line?: number,
    column?: number
  ): ParseFailedError => ({
    _tag: 'ParseFailed',
    source,
    format,
    details,
    line,
    column,
    message: line !== undefined
      ? `Failed to parse ${format} from ${source} at line ${line}: ${details}`
      : `Failed to parse ${format} from ${source}: ${details}`,
  }),
  
  validationFailed: (
    field: string,
    value: string,
    issues: string,
    expected?: string
  ): ValidationFailedError => ({
    _tag: 'ValidationFailed',
    field,
    value,
    issues,
    expected,
    message: expected
      ? `Invalid ${field}: ${issues}. Expected: ${expected}`
      : `Invalid ${field}: ${issues}`,
  }),
  
  schemaViolation: (
    path: string,
    expected: string,
    actual: string
  ): SchemaViolationError => ({
    _tag: 'SchemaViolation',
    path,
    expected,
    actual,
    message: `Schema violation at ${path}: expected ${expected}, got ${actual}`,
  }),
  
  // ==========================================================================
  // Configuration Errors
  // ==========================================================================
  
  configInvalid: (issues: readonly string[]): ConfigInvalidError => ({
    _tag: 'ConfigInvalid',
    issues,
    message: `Configuration invalid:\n${issues.map(i => `  - ${i}`).join('\n')}`,
  }),
  
  startupFailed: (
    phase: string,
    details: string,
    cause?: Error
  ): StartupFailedError => ({
    _tag: 'StartupFailed',
    phase,
    details,
    cause,
    message: `Startup failed during ${phase}: ${details}`,
  }),
  
  // ==========================================================================
  // Internal Errors
  // ==========================================================================
  
  unexpectedError: (operation: string, cause?: Error): UnexpectedError => ({
    _tag: 'UnexpectedError',
    operation,
    cause,
    message: `Unexpected error during ${operation}: ${cause?.message || 'Unknown error'}`,
  }),
  
  contextSizeExceeded: (
    sizeKB: number,
    maxKB: number,
    operation: string
  ): ContextSizeExceededError => ({
    _tag: 'ContextSizeExceeded',
    sizeKB,
    maxKB,
    operation,
    message: `Context size (${sizeKB}KB) exceeds maximum (${maxKB}KB) during ${operation}`,
  }),
  
  loopStackCorruption: (
    loopId: string,
    details: string
  ): LoopStackCorruptionError => ({
    _tag: 'LoopStackCorruption',
    loopId,
    details,
    message: `Loop stack corruption in loop "${loopId}": ${details}`,
  }),
  
  maxIterationsExceeded: (
    workflowId: string,
    iterations: number,
    maxIterations: number,
    loopIds: readonly string[]
  ): MaxIterationsExceededError => ({
    _tag: 'MaxIterationsExceeded',
    workflowId,
    iterations,
    maxIterations,
    loopIds,
    message: `Workflow "${workflowId}" exceeded ${maxIterations} iterations. Active loops: ${loopIds.join(', ')}`,
  }),
};
