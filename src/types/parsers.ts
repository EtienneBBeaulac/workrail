/**
 * Parse Functions - Runtime Validation with Branded Types
 * 
 * CTC Pattern: "Parse, Don't Validate"
 * Validation returns branded type - compiler enforces validation happened.
 * 
 * Three pathways to branded types:
 * 1. parse*() - Runtime validation (user input, network data) → Result<T, E>
 * 2. literal*() - Compile-time constants (static strings) → T or throw
 * 3. Zod validation - Schemas validate and brand atomically → T
 * 
 * Philosophy: Use types to prove validation happened, not runtime checks.
 */

import { Result, ok, err } from 'neverthrow';
import {
  WorkflowIdSchema,
  SessionIdSchema,
  StepIdSchema,
  LoopIdSchema,
  ProjectIdSchema,
  NonEmptyStringSchema,
  PositiveIntegerSchema,
  SemVerSchema,
  FilePathSchema,
  UrlSchema,
  type WorkflowId,
  type SessionId,
  type StepId,
  type LoopId,
  type ProjectId,
  type NonEmptyString,
  type PositiveInteger,
  type SemVer,
  type FilePath,
  type Url,
} from './schemas.js';

// Error types (will be defined in core/errors)
// For now, use a simple error structure
interface ValidationFailedError {
  readonly _tag: 'ValidationFailed';
  readonly field: string;
  readonly value: string;
  readonly issues: string;
  readonly expected?: string;
  readonly message: string;
}

// Temporary error factory (will be replaced by core/errors/factories.ts)
const createValidationError = (
  field: string,
  value: unknown,
  issues: string,
  expected?: string
): ValidationFailedError => ({
  _tag: 'ValidationFailed',
  field,
  value: String(value),
  issues,
  expected,
  message: expected
    ? `Invalid ${field}: ${issues}. Expected: ${expected}`
    : `Invalid ${field}: ${issues}`,
});

// ============================================================================
// Runtime Parsing (User Input, Network Data, File Loads)
// ============================================================================

export function parseWorkflowId(input: unknown): Result<WorkflowId, ValidationFailedError> {
  const result = WorkflowIdSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.errors.map(e => e.message).join('; ');
    return err(createValidationError(
      'workflowId',
      input,
      issues,
      'lowercase kebab-case (e.g., "bug-investigation")'
    ));
  }
  return ok(result.data);
}

export function parseSessionId(input: unknown): Result<SessionId, ValidationFailedError> {
  const result = SessionIdSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.errors.map(e => e.message).join('; ');
    return err(createValidationError(
      'sessionId',
      input,
      issues,
      'UUID v4 (e.g., "550e8400-e29b-41d4-a716-446655440000")'
    ));
  }
  return ok(result.data);
}

export function parseStepId(input: unknown): Result<StepId, ValidationFailedError> {
  const result = StepIdSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.errors.map(e => e.message).join('; ');
    return err(createValidationError(
      'stepId',
      input,
      issues,
      'lowercase with hyphens/underscores (e.g., "backup-database")'
    ));
  }
  return ok(result.data);
}

export function parseLoopId(input: unknown): Result<LoopId, ValidationFailedError> {
  const result = LoopIdSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.errors.map(e => e.message).join('; ');
    return err(createValidationError(
      'loopId',
      input,
      issues,
      'lowercase with hyphens/underscores'
    ));
  }
  return ok(result.data);
}

export function parseProjectId(input: unknown): Result<ProjectId, ValidationFailedError> {
  const result = ProjectIdSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.errors.map(e => e.message).join('; ');
    return err(createValidationError(
      'projectId',
      input,
      issues,
      '12-character hex hash'
    ));
  }
  return ok(result.data);
}

export function parseNonEmptyString(input: unknown): Result<NonEmptyString, ValidationFailedError> {
  const result = NonEmptyStringSchema.safeParse(input);
  if (!result.success) {
    return err(createValidationError('string', input, 'Cannot be empty'));
  }
  return ok(result.data);
}

export function parsePositiveInteger(input: unknown): Result<PositiveInteger, ValidationFailedError> {
  const result = PositiveIntegerSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.errors.map(e => e.message).join('; ');
    return err(createValidationError('number', input, issues, 'positive integer'));
  }
  return ok(result.data);
}

export function parseSemVer(input: unknown): Result<SemVer, ValidationFailedError> {
  const result = SemVerSchema.safeParse(input);
  if (!result.success) {
    return err(createValidationError(
      'version',
      input,
      'Invalid semantic version',
      'MAJOR.MINOR.PATCH (e.g., "1.0.0")'
    ));
  }
  return ok(result.data);
}

export function parseFilePath(input: unknown): Result<FilePath, ValidationFailedError> {
  const result = FilePathSchema.safeParse(input);
  if (!result.success) {
    return err(createValidationError('filePath', input, 'Cannot be empty'));
  }
  return ok(result.data);
}

export function parseUrl(input: unknown): Result<Url, ValidationFailedError> {
  const result = UrlSchema.safeParse(input);
  if (!result.success) {
    return err(createValidationError('url', input, 'Invalid URL format'));
  }
  return ok(result.data);
}

// ============================================================================
// Compile-Time Literals (Static Constants)
// ============================================================================

/**
 * Create WorkflowId from compile-time literal.
 * Use for static constants in code.
 * Throws if invalid (caught at development time).
 * 
 * @example
 * const BUG_INVESTIGATION = literalWorkflow("bug-investigation");  // ✓ OK
 * const BAD = literalWorkflow("BadId");  // ✗ Throws at runtime
 */
export function literalWorkflow(s: string): WorkflowId {
  const result = WorkflowIdSchema.safeParse(s);
  if (!result.success) {
    throw new Error(
      `Invalid literal workflow ID "${s}": ${result.error.errors[0]?.message}`
    );
  }
  return result.data;
}

export function literalStep(s: string): StepId {
  const result = StepIdSchema.safeParse(s);
  if (!result.success) {
    throw new Error(
      `Invalid literal step ID "${s}": ${result.error.errors[0]?.message}`
    );
  }
  return result.data;
}

export function literalLoop(s: string): LoopId {
  const result = LoopIdSchema.safeParse(s);
  if (!result.success) {
    throw new Error(
      `Invalid literal loop ID "${s}": ${result.error.errors[0]?.message}`
    );
  }
  return result.data;
}

export function literalProject(s: string): ProjectId {
  const result = ProjectIdSchema.safeParse(s);
  if (!result.success) {
    throw new Error(
      `Invalid literal project ID "${s}": ${result.error.errors[0]?.message}`
    );
  }
  return result.data;
}

// ============================================================================
// Array Parsing (Parse multiple items)
// ============================================================================

/**
 * Parse array of step IDs.
 * Returns Result with all successes or first error.
 * 
 * @example
 * const result = parseStepIds(['step-1', 'step-2']);
 * if (result.isOk()) {
 *   const ids: readonly StepId[] = result.value;
 * }
 */
export function parseStepIds(inputs: readonly unknown[]): Result<readonly StepId[], ValidationFailedError> {
  const results = inputs.map(input => parseStepId(input));
  
  // Find first error
  const firstError = results.find(r => r.isErr());
  if (firstError?.isErr()) {
    return err(firstError.error);
  }
  
  // All succeeded - extract values
  const stepIds = results.map(r => (r as any).value as StepId);
  return ok(stepIds);
}

/**
 * Parse array of workflow IDs.
 */
export function parseWorkflowIds(inputs: readonly unknown[]): Result<readonly WorkflowId[], ValidationFailedError> {
  const results = inputs.map(input => parseWorkflowId(input));
  
  const firstError = results.find(r => r.isErr());
  if (firstError?.isErr()) {
    return err(firstError.error);
  }
  
  const workflowIds = results.map(r => (r as any).value as WorkflowId);
  return ok(workflowIds);
}
