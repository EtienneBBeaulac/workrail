import type { AppError } from './app-error.js';
import { assertNever } from '../runtime/assert-never.js';

export function formatAppError(error: AppError): string {
  switch (error._tag) {
    case 'ConfigInvalid': {
      const issues = error.issues.length
        ? error.issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n')
        : '  - (no details)';
      return `${error.message}\n\n${issues}`;
    }

    case 'StartupFailed': {
      const base = `Startup failed during ${error.phase}: ${error.message}`;
      return error.cause ? `${base}\nCause: ${safeToString(error.cause)}` : base;
    }

    case 'Unexpected':
      return `${error.message}\nCause: ${safeToString(error.cause)}`;

    default:
      return assertNever(error);
  }
}

function safeToString(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}
