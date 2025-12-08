/**
 * Brand Infrastructure
 * 
 * CTC Pattern: Zero runtime cost, maximum compile-time safety.
 * Brands are erased at compile time - no performance impact.
 * 
 * Philosophy: Use TypeScript's type system to prevent bugs before code runs.
 */

declare const brand: unique symbol;

/**
 * Brand type infrastructure.
 * Creates a nominal type from a structural type.
 * 
 * @example
 * type WorkflowId = Brand<string, "WorkflowId">;
 * type SessionId = Brand<string, "SessionId">;
 * 
 * // Can't mix them up:
 * function getWorkflow(id: WorkflowId) { ... }
 * const sessionId: SessionId = ...;
 * getWorkflow(sessionId);  // ✗ COMPILE ERROR
 */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

// ============================================================================
// Domain IDs (Prevent mix-ups at compile time)
// ============================================================================

/**
 * Workflow identifier.
 * Format: lowercase kebab-case (e.g., "bug-investigation", "migrate-workflow")
 */
export type WorkflowId = Brand<string, "WorkflowId">;

/**
 * Session identifier.
 * Format: UUID v4
 */
export type SessionId = Brand<string, "SessionId">;

/**
 * Step identifier within a workflow.
 * Format: lowercase with hyphens/underscores (e.g., "backup-database", "step_1")
 */
export type StepId = Brand<string, "StepId">;

/**
 * Loop identifier (same format as StepId, but semantically different).
 * Loops are special steps, so same validation but different brand.
 */
export type LoopId = Brand<string, "LoopId">;

/**
 * Project identifier.
 * Format: 12-character hex hash (derived from project path)
 */
export type ProjectId = Brand<string, "ProjectId">;

// ============================================================================
// Validated Primitives (Prove constraints at type level)
// ============================================================================

/**
 * String that cannot be empty.
 * Use for required fields where empty string is invalid.
 */
export type NonEmptyString = Brand<string, "NonEmptyString">;

/**
 * Integer greater than zero.
 * Use for counts, iterations, etc.
 */
export type PositiveInteger = Brand<number, "PositiveInteger">;

/**
 * Semantic version string.
 * Format: MAJOR.MINOR.PATCH (e.g., "1.0.0")
 */
export type SemVer = Brand<string, "SemVer">;

/**
 * Validated file system path.
 * Use to prove path has been validated/expanded.
 */
export type FilePath = Brand<string, "FilePath">;

/**
 * Validated URL.
 * Use to prove URL has been validated.
 */
export type Url = Brand<string, "Url">;

// ============================================================================
// Validated Configurations (Prove validation happened)
// ============================================================================

// These will be defined later when we create persistence config types
