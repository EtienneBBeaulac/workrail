/**
 * Test Utilities for Branded IDs
 * 
 * ⚠️  FOR TESTING ONLY - ESLint blocks imports in src/
 * 
 * CTC Pattern: Module segregation prevents test utilities in production.
 * 
 * Usage:
 * - Production code: Use parse*() or literal*() from types/parsers
 * - Test code: Use trustAs*() for fixtures
 * 
 * Two variants:
 * - trustAs*<T extends string>(literal) - Template literal constraint (safer)
 * - trustAs*Unsafe(string) - Dynamic strings (explicit unsafe)
 */

import type {
  WorkflowId,
  SessionId,
  StepId,
  LoopId,
  ProjectId,
  NonEmptyString,
  PositiveInteger,
  SemVer,
  FilePath,
} from '../schemas.js';

// ============================================================================
// ID Utilities (Literal-Only Variants)
// ============================================================================

/**
 * Create branded WorkflowId for testing.
 * ONLY accepts string literals (template literal constraint).
 * 
 * @example
 * const id = trustAsWorkflowId("test-workflow");  // ✓ OK
 * const id = trustAsWorkflowId(dynamicString);    // ✗ ERROR: not a literal
 */
export function trustAsWorkflowId<T extends string>(s: T): WorkflowId {
  return s as unknown as WorkflowId;
}

export function trustAsSessionId<T extends string>(s: T): SessionId {
  return s as unknown as SessionId;
}

export function trustAsStepId<T extends string>(s: T): StepId {
  return s as unknown as StepId;
}

export function trustAsLoopId<T extends string>(s: T): LoopId {
  return s as unknown as LoopId;
}

export function trustAsProjectId<T extends string>(s: T): ProjectId {
  return s as unknown as ProjectId;
}

// ============================================================================
// ID Utilities (Unsafe Variants for Dynamic Data)
// ============================================================================

/**
 * Create branded WorkflowId from dynamic string (UNSAFE).
 * Use ONLY when generating many test IDs programmatically.
 * 
 * @example
 * const ids = Array.from({ length: 100 }, (_, i) => 
 *   trustAsWorkflowIdUnsafe(`workflow-${i}`)
 * );
 */
export function trustAsWorkflowIdUnsafe(s: string): WorkflowId {
  return s as WorkflowId;
}

export function trustAsSessionIdUnsafe(s: string): SessionId {
  return s as SessionId;
}

export function trustAsStepIdUnsafe(s: string): StepId {
  return s as StepId;
}

export function trustAsLoopIdUnsafe(s: string): LoopId {
  return s as LoopId;
}

export function trustAsProjectIdUnsafe(s: string): ProjectId {
  return s as ProjectId;
}

// ============================================================================
// Primitive Utilities
// ============================================================================

export function trustAsNonEmptyString<T extends string>(s: T): NonEmptyString {
  return s as unknown as NonEmptyString;
}

export function trustAsPositiveInteger(n: number): PositiveInteger {
  return n as unknown as PositiveInteger;
}

export function trustAsSemVer<T extends string>(s: T): SemVer {
  return s as unknown as SemVer;
}

export function trustAsFilePath<T extends string>(s: T): FilePath {
  return s as unknown as FilePath;
}
