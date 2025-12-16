import type { AppError, ConfigIssue, ConfigInvalidError, StartupFailedError, UnexpectedError } from './app-error.js';

export const Err = {
  configInvalid: (issues: readonly ConfigIssue[]): ConfigInvalidError => ({
    _tag: 'ConfigInvalid',
    issues,
    message: 'Invalid configuration',
  }),

  startupFailed: (phase: string, message: string, cause?: unknown): StartupFailedError => ({
    _tag: 'StartupFailed',
    phase,
    message,
    cause,
  }),

  unexpected: (message: string, cause: unknown): UnexpectedError => ({
    _tag: 'Unexpected',
    message,
    cause,
  }),
} as const satisfies Record<string, (...args: any[]) => AppError>;
