/**
 * CLI Types - Public API
 */

export type { ExitCode } from './exit-code.js';
export { toProcessExitCode, toNumericExitCode } from './exit-code.js';

export type { CliOutput, CliResult } from './cli-result.js';
export { success, successMessage, failure, misuse } from './cli-result.js';
