/**
 * CLI Result Interpreter
 *
 * Bridges CLI command results to process termination.
 * This is the only place where CliResult is converted to process exit.
 */

import type { CliResult } from './types/cli-result.js';
import { toProcessExitCode, toNumericExitCode } from './types/exit-code.js';
import type { ProcessTerminator } from '../runtime/ports/process-terminator.js';
import { printResult } from './output-formatter.js';

/**
 * Interpret a CLI result and handle termination via ProcessTerminator.
 * Use this when DI container is available.
 *
 * @param result - The CLI command result
 * @param terminator - The process terminator from DI
 */
export function interpretCliResult(
  result: CliResult,
  terminator: ProcessTerminator
): void {
  printResult(result);

  switch (result.kind) {
    case 'success':
      // Don't explicitly exit on success; let the process end naturally.
      // This allows any cleanup handlers to run.
      return;

    case 'failure':
      terminator.terminate(toProcessExitCode(result.exitCode));
  }
}

/**
 * Interpret a CLI result without DI (for pre-container commands).
 * Use this only at composition root boundary when container isn't initialized.
 *
 * @param result - The CLI command result
 */
export function interpretCliResultWithoutDI(result: CliResult): void {
  printResult(result);

  switch (result.kind) {
    case 'success':
      return;

    case 'failure':
      process.exit(toNumericExitCode(result.exitCode));
  }
}
