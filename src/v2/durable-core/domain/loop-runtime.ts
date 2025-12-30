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
