import type { Result } from 'neverthrow';
import { err, ok } from 'neverthrow';
import type { LoadedSessionTruthV2 } from '../ports/session-event-log-store.port.js';
import { projectRunDagV2 } from './run-dag.js';

export type SessionHealthV2 =
  | { readonly kind: 'healthy' }
  | {
      readonly kind: 'corrupted';
      readonly reason:
        | { readonly code: 'MANIFEST_INVALID'; readonly message: string }
        | { readonly code: 'EVENT_LOG_INVALID'; readonly message: string }
        | { readonly code: 'RUN_DAG_INVALID'; readonly message: string };
    };

/**
 * Pure corruption gating.
 *
 * Lock intent:
 * - execution requires `healthy`
 * - salvage is read-only and explicitly signaled
 */
export function projectSessionHealthV2(truth: LoadedSessionTruthV2): Result<SessionHealthV2, never> {
  // If the store returned something, `manifest`/`events` are already schema-validated.
  // SessionHealth is an extra guardrail that makes "is this safe to execute?" explicit.

  // Deterministic additional check: run DAG must be projectable without invariant violations.
  const dag = projectRunDagV2(truth.events);
  if (dag.isErr()) {
    return ok({
      kind: 'corrupted',
      reason: { code: 'RUN_DAG_INVALID', message: dag.error.message },
    });
  }

  return ok({ kind: 'healthy' });
}
