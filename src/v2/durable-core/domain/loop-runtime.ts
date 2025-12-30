/**
 * Loop iteration runtime semantics (v2, locked).
 *
 * This module centralizes all loop iteration logic to prevent drift and ensure
 * deterministic behavior across the engine.
 *
 * Locks (see docs/design/v2-core-design-locks.md):
 * - Iteration indexing: `loopStack[].iteration` is 0-based.
 * - maxIterations meaning: count of allowed iterations (not max index).
 *   Allowed iteration values are: 0..(maxIterations - 1).
 * - Iteration increment point: increments only when starting the next iteration
 *   (after completing the loop body and deciding to continue).
 * - Termination reason: loop exits due to condition=false OR max iterations reached.
 * - Failure mode: attempting to continue past max MUST fail fast with typed error.
 */

import { err, ok, type Result } from 'neverthrow';

// =============================================================================
// Types
// =============================================================================

/**
 * Error returned when loop boundary is violated.
 *
 * This is a typed error (errors-as-data), not an exception.
 */
export interface LoopBoundaryError {
  readonly code: 'LOOP_MAX_ITERATIONS_REACHED';
  readonly loopId: string;
  readonly iteration: number;
  readonly maxIterations: number;
  readonly message: string;
}

// =============================================================================
// Core Functions (Pure)
// =============================================================================

/**
 * Determines if a loop can continue to the next iteration.
 *
 * Lock: iteration is 0-based; maxIterations is a count.
 * Allowed iterations are 0..(maxIterations - 1).
 *
 * @param iteration Current iteration (0-based)
 * @param maxIterations Maximum number of iterations allowed (count)
 * @returns true if another iteration is allowed
 *
 * @example
 * canContinueLoop(0, 5) // true (iterations 0-4 allowed)
 * canContinueLoop(4, 5) // true (iteration 4 is the last allowed)
 * canContinueLoop(5, 5) // false (would be 6th iteration)
 */
export function canContinueLoop(iteration: number, maxIterations: number): boolean {
  // Lock: iteration < maxIterations means we haven't exhausted allowed iterations
  return iteration < maxIterations;
}

/**
 * Computes the next iteration value.
 *
 * Lock: iteration increments by exactly 1 when starting the next iteration.
 *
 * @param iteration Current iteration (0-based)
 * @returns Next iteration value
 */
export function nextIteration(iteration: number): number {
  return iteration + 1;
}

/**
 * Validates that advancing to the next iteration is allowed.
 *
 * Use this when you need a Result instead of a boolean (fail-fast with typed error).
 *
 * @param loopId Loop identifier (for error message)
 * @param iteration Current iteration (0-based)
 * @param maxIterations Maximum iterations allowed (count)
 * @returns Ok(nextIteration) if allowed, Err(LoopBoundaryError) if not
 */
export function validateLoopAdvance(
  loopId: string,
  iteration: number,
  maxIterations: number
): Result<number, LoopBoundaryError> {
  const next = nextIteration(iteration);
  
  // Lock: the next iteration value must be < maxIterations to enter the loop body
  // (iteration 0 enters first, iteration maxIterations-1 enters last)
  // Use canContinueLoop for consistency with the central semantics
  if (!canContinueLoop(next, maxIterations)) {
    return err({
      code: 'LOOP_MAX_ITERATIONS_REACHED',
      loopId,
      iteration,
      maxIterations,
      message: `Loop '${loopId}' cannot advance: iteration ${iteration} + 1 = ${next} exceeds maxIterations (${maxIterations})`,
    });
  }
  
  return ok(next);
}

/**
 * Checks if a loop should continue based on iteration count only.
 *
 * Note: This does not evaluate the loop's condition expression—it only checks
 * the iteration boundary. Callers must also evaluate the condition separately.
 *
 * @param iteration Current iteration (0-based, already incremented for this pass)
 * @param maxIterations Maximum iterations allowed (count)
 * @returns true if iteration is within bounds
 */
export function isIterationWithinBounds(iteration: number, maxIterations: number): boolean {
  // Lock: allowed iterations are 0..(maxIterations - 1)
  return iteration < maxIterations;
}

// =============================================================================
// Loop Kernel (Pure)
// =============================================================================

export type LoopDecision =
  | { readonly kind: 'execute_body_step'; readonly bodyIndex: number }
  | { readonly kind: 'advance_iteration'; readonly toIteration: number }
  | { readonly kind: 'exit_loop' };

export interface LoopKernelInvalidStateError {
  readonly code: 'LOOP_INVALID_STATE';
  readonly loopId: string;
  readonly message: string;
}

export interface LoopKernelInvalidConfigError {
  readonly code: 'LOOP_INVALID_CONFIG';
  readonly loopId: string;
  readonly message: string;
}

export interface LoopKernelMissingContextError {
  readonly code: 'LOOP_MISSING_CONTEXT';
  readonly loopId: string;
  readonly message: string;
}

export type LoopKernelError =
  | LoopBoundaryError
  | LoopKernelInvalidStateError
  | LoopKernelInvalidConfigError
  | LoopKernelMissingContextError;

export interface LoopKernelPorts {
  /**
   * Pre-check semantics.
   *
   * Returns whether the engine should ENTER the given iteration (0-based).
   */
  readonly shouldEnterIteration: (iteration: number) => Result<boolean, LoopKernelError>;

  /**
   * Eligibility is an external concern (completed set + runCondition evaluation).
   */
  readonly isBodyIndexEligible: (bodyIndex: number) => boolean;
}

export interface LoopKernelInput {
  readonly loopId: string;
  readonly iteration: number;
  readonly bodyIndex: number;
  readonly bodyLength: number;
  readonly maxIterations: number;
  readonly ports: LoopKernelPorts;
}

export function computeLoopDecision(input: LoopKernelInput): Result<LoopDecision, LoopKernelError> {
  const { loopId, iteration, bodyIndex, bodyLength, maxIterations, ports } = input;

  if (!Number.isInteger(iteration) || iteration < 0) {
    return err({
      code: 'LOOP_INVALID_STATE',
      loopId,
      message: `Invalid loop state: iteration must be a non-negative integer (got ${String(iteration)})`,
    });
  }

  if (!Number.isInteger(bodyIndex) || bodyIndex < 0) {
    return err({
      code: 'LOOP_INVALID_STATE',
      loopId,
      message: `Invalid loop state: bodyIndex must be a non-negative integer (got ${String(bodyIndex)})`,
    });
  }

  if (!Number.isInteger(bodyLength) || bodyLength < 1) {
    return err({
      code: 'LOOP_INVALID_CONFIG',
      loopId,
      message: `Invalid loop config: bodyLength must be >= 1 (got ${String(bodyLength)})`,
    });
  }

  if (!Number.isInteger(maxIterations) || maxIterations < 0) {
    return err({
      code: 'LOOP_INVALID_CONFIG',
      loopId,
      message: `Invalid loop config: maxIterations must be a non-negative integer (got ${String(maxIterations)})`,
    });
  }

  // If the frame is already out of bounds, this is an engine bug / invalid state.
  if (!isIterationWithinBounds(iteration, maxIterations)) {
    return err({
      code: 'LOOP_INVALID_STATE',
      loopId,
      message: `Invalid loop state: iteration ${iteration} is out of bounds for maxIterations ${maxIterations}`,
    });
  }

  if (bodyIndex > bodyLength) {
    return err({
      code: 'LOOP_INVALID_STATE',
      loopId,
      message: `Invalid loop state: bodyIndex ${bodyIndex} exceeds bodyLength ${bodyLength}`,
    });
  }

  // Pre-check: should we even enter this iteration?
  const shouldEnterThis = ports.shouldEnterIteration(iteration);
  if (shouldEnterThis.isErr()) return err(shouldEnterThis.error);
  if (!shouldEnterThis.value) return ok({ kind: 'exit_loop' });

  // Find next eligible body step in this iteration.
  for (let i = bodyIndex; i < bodyLength; i++) {
    if (ports.isBodyIndexEligible(i)) {
      return ok({ kind: 'execute_body_step', bodyIndex: i });
    }
  }

  // No eligible steps left in this iteration.
  // Skipped-body iterations still count as an iteration, so we now consult whether to enter the NEXT iteration.
  const next = nextIteration(iteration);

  // Natural termination: maxIterations reached.
  if (!isIterationWithinBounds(next, maxIterations)) {
    return ok({ kind: 'exit_loop' });
  }

  const shouldEnterNext = ports.shouldEnterIteration(next);
  if (shouldEnterNext.isErr()) return err(shouldEnterNext.error);
  if (!shouldEnterNext.value) return ok({ kind: 'exit_loop' });

  return ok({ kind: 'advance_iteration', toIteration: next });
}
