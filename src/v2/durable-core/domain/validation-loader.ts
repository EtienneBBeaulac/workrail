import { ok, type Result } from 'neverthrow';
import type { DomainEventV1 } from '../schemas/session/index.js';
import { EVENT_KIND } from '../constants.js';

export type ValidationLoadError = { readonly code: 'VALIDATION_LOAD_INVARIANT_VIOLATION'; readonly message: string };

export type LoadedValidationV1 = {
  readonly issues: readonly string[];
  readonly suggestions: readonly string[];
};

export function loadValidationResultV1(events: readonly DomainEventV1[], validationId: string): Result<LoadedValidationV1 | null, ValidationLoadError> {
  if (!validationId) {
    return ok(null);
  }

  // Deterministic: pick the latest by eventIndex if duplicates exist.
  let latest: Extract<DomainEventV1, { kind: 'validation_performed' }> | null = null;
  for (const e of events) {
    if (e.kind !== EVENT_KIND.VALIDATION_PERFORMED) continue;
    if (e.data.validationId !== validationId) continue;
    if (!latest || e.eventIndex > latest.eventIndex) latest = e;
  }

  if (!latest) return ok(null);
  return ok({ issues: latest.data.result.issues, suggestions: latest.data.result.suggestions });
}
