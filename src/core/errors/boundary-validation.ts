/**
 * Boundary Validation Helpers
 * 
 * CTC Pattern: Validate at every I/O boundary.
 * Use these helpers to ensure validation happens (hard to forget).
 */

import { Result, ok, err } from 'neverthrow';
import { z } from 'zod';
import type { ValidationFailedError, ParseFailedError } from './app-error.js';
import { Err } from './factories.js';

/**
 * Validate MCP tool arguments (network → memory boundary).
 */
export function validateMCPArgs<T>(
  schema: z.ZodSchema<T>,
  args: unknown
): Result<T, ValidationFailedError> {
  const result = schema.safeParse(args);
  if (!result.success) {
    const issues = result.error.errors
      .map(e => `${e.path.join('.')}: ${e.message}`)
      .join('; ');
    return err(Err.validationFailed('arguments', JSON.stringify(args), issues));
  }
  return ok(result.data);
}

/**
 * Validate JSON data (disk → memory boundary).
 */
export function validateJSONLoad<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
  source: string
): Result<T, ParseFailedError> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.errors
      .map(e => `${e.path.join('.')}: ${e.message}`)
      .join('\n');
    return err(Err.parseFailed(source, 'json', details));
  }
  return ok(result.data);
}

/**
 * Validate YAML data (disk → memory boundary).
 */
export function validateYAMLLoad<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
  source: string
): Result<T, ParseFailedError> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.errors
      .map(e => `${e.path.join('.')}: ${e.message}`)
      .join('\n');
    return err(Err.parseFailed(source, 'yaml', details));
  }
  return ok(result.data);
}
