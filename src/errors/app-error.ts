import type { Brand } from '../runtime/brand.js';

export type ConfigIssue = Readonly<{
  readonly path: string;
  readonly message: string;
}>;

export type ConfigInvalidError = Readonly<{
  readonly _tag: 'ConfigInvalid';
  readonly issues: readonly ConfigIssue[];
  readonly message: string;
}>;

export type StartupFailedError = Readonly<{
  readonly _tag: 'StartupFailed';
  readonly phase: string;
  readonly message: string;
  readonly cause?: unknown;
}>;

export type UnexpectedError = Readonly<{
  readonly _tag: 'Unexpected';
  readonly message: string;
  readonly cause: unknown;
}>;

export type AppError = ConfigInvalidError | StartupFailedError | UnexpectedError;

/**
 * Branded error type for validated config.
 * (Kept here so callers can require a validated version without runtime checks.)
 */
export type ValidatedAppConfig<T> = Brand<T, 'ValidatedAppConfig'>;
