import type { Result } from 'neverthrow';
import { ok } from 'neverthrow';
import type { LoadedSessionTruthV2 } from '../ports/session-event-log-store.port.js';
import type { SessionHealthV2 } from '../durable-core/schemas/session/session-health.js';
import { projectRunDagV2 } from './run-dag.js';

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
    // We intentionally keep the corruption reason closed-set (Slice 2.5 lock).
    // Map projection invalidity into `non_contiguous_indices` and preserve details in message.
    return ok({ kind: 'corrupt_tail', reason: { code: 'non_contiguous_indices', message: dag.error.message } });
  }

  return ok({ kind: 'healthy' });
}
