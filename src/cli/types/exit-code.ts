/**
 * Typed exit codes for CLI commands.
 * Prefer these over raw integers for type safety.
 * Maps to standard Unix conventions.
 */
export type ExitCode =
  | { kind: 'success' }        // 0 - successful execution
  | { kind: 'general_error' }  // 1 - general errors
  | { kind: 'misuse' };        // 2 - misuse of command (bad args, etc)

/**
 * Convert ExitCode to ProcessTerminator's expected format.
 */
export function toProcessExitCode(exitCode: ExitCode): { kind: 'success' } | { kind: 'failure' } {
  switch (exitCode.kind) {
    case 'success':
      return { kind: 'success' };
    case 'general_error':
    case 'misuse':
      return { kind: 'failure' };
  }
}

/**
 * Convert ExitCode to numeric value for raw process.exit().
 * Only use this at composition root boundaries where DI is unavailable.
 */
export function toNumericExitCode(exitCode: ExitCode): number {
  switch (exitCode.kind) {
    case 'success':
      return 0;
    case 'general_error':
      return 1;
    case 'misuse':
      return 2;
  }
}
