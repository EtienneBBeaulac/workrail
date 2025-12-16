/**
 * CLI Result Types
 *
 * Discriminated unions for CLI command outcomes.
 * Commands return these types; the composition root interprets them.
 */

import type { ExitCode } from './exit-code.js';

/**
 * Structured output for CLI display.
 * Separates content from presentation.
 */
export interface CliOutput {
  readonly message: string;
  readonly details?: readonly string[];
  readonly warnings?: readonly string[];
  readonly suggestions?: readonly string[];
}

/**
 * Result of a CLI command execution.
 * All commands should return this type.
 */
export type CliResult =
  | { kind: 'success'; output?: CliOutput }
  | { kind: 'failure'; exitCode: ExitCode; output: CliOutput };

/**
 * Helper to create a success result.
 */
export function success(output?: CliOutput): CliResult {
  return { kind: 'success', output };
}

/**
 * Helper to create a success result with just a message.
 */
export function successMessage(message: string): CliResult {
  return { kind: 'success', output: { message } };
}

/**
 * Helper to create a failure result.
 */
export function failure(
  message: string,
  options?: {
    exitCode?: ExitCode;
    details?: readonly string[];
    suggestions?: readonly string[];
  }
): CliResult {
  return {
    kind: 'failure',
    exitCode: options?.exitCode ?? { kind: 'general_error' },
    output: {
      message,
      details: options?.details,
      suggestions: options?.suggestions,
    },
  };
}

/**
 * Helper to create a misuse failure (bad arguments, etc).
 */
export function misuse(message: string, suggestions?: readonly string[]): CliResult {
  return {
    kind: 'failure',
    exitCode: { kind: 'misuse' },
    output: { message, suggestions },
  };
}
