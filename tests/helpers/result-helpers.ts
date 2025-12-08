/**
 * Test Helpers for Result Types
 * 
 * CTC Pattern: Ergonomic test utilities for working with Result<T, E>.
 * 
 * These helpers unwrap Results in tests, throwing descriptive errors on failure.
 * This makes test assertions cleaner and failures easier to debug.
 */

import { Result } from 'neverthrow';

/**
 * Unwrap Ok value from Result, throw if Err.
 * Use in tests when you expect success and want to assert on the value.
 * 
 * @example
 * const result = await service.getWorkflow(id);
 * const workflow = expectOk(result, 'getting workflow');
 * expect(workflow.name).toBe('Test Workflow');
 * 
 * @param result - Result to unwrap
 * @param context - Description of operation (for error message)
 * @returns The unwrapped value
 * @throws Error with full context if result is Err
 */
export function expectOk<T, E>(result: Result<T, E>, context: string): T {
  if (result.isErr()) {
    const errorJson = JSON.stringify(result.error, null, 2);
    throw new Error(
      `Expected Ok in ${context}, but got Err:\n${errorJson}`
    );
  }
  return result.value;
}

/**
 * Unwrap Err value from Result, throw if Ok.
 * Use in tests when you expect failure and want to assert on the error.
 * 
 * @example
 * const result = await service.getWorkflow(invalidId);
 * const error = expectErr(result, 'getting invalid workflow');
 * expect(error._tag).toBe('WorkflowNotFound');
 * 
 * @param result - Result to unwrap
 * @param context - Description of operation (for error message)
 * @returns The unwrapped error
 * @throws Error if result is Ok
 */
export function expectErr<T, E>(result: Result<T, E>, context: string): E {
  if (result.isOk()) {
    const valueJson = JSON.stringify(result.value, null, 2);
    throw new Error(
      `Expected Err in ${context}, but got Ok:\n${valueJson}`
    );
  }
  return result.error;
}

/**
 * Assert that result is Ok (for use in expect statements).
 * 
 * @example
 * const result = await service.getWorkflow(id);
 * expect(isOk(result)).toBe(true);
 */
export function isOk<T, E>(result: Result<T, E>): boolean {
  return result.isOk();
}

/**
 * Assert that result is Err (for use in expect statements).
 */
export function isErr<T, E>(result: Result<T, E>): boolean {
  return result.isErr();
}
