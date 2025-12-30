/**
 * Session health classification (v2 Slice 2.5).
 *
 * Locked intent:
 * - Correctness paths require `healthy`
 * - Salvage is read-only and explicitly signaled
 * - Corruption reasons are manifest-attested only (no filesystem scanning for orphans)
 */

/**
 * Closed set: CorruptionReason codes.
 *
 * Lock: docs/design/v2-core-design-locks.md (session substrate / corruption reporting)
 *
 * Why closed:
 * - Keeps health classification deterministic and auditable
 * - Prevents ad-hoc “reason strings” from leaking into durable truth
 *
 * Values:
 * - `digest_mismatch`: manifest-attested segment digest does not match computed digest
 * - `non_contiguous_indices`: eventIndex sequence is not contiguous/monotonic as locked
 * - `missing_attested_segment`: manifest references a segment that is missing
 * - `unknown_schema_version`: manifest/event schema version not recognized (v field mismatch)
 * - `schema_validation_failed`: record is valid JSON with known version, but fails schema validation
 */
export type CorruptionReasonV2 =
  | { readonly code: 'digest_mismatch'; readonly message: string }
  | { readonly code: 'non_contiguous_indices'; readonly message: string }
  | { readonly code: 'missing_attested_segment'; readonly message: string }
  | { readonly code: 'unknown_schema_version'; readonly message: string }
  | { readonly code: 'schema_validation_failed'; readonly message: string };

/**
 * Closed set: SessionHealth (healthy | corrupt_tail | corrupt_head | unknown_version).
 *
 * Lock: docs/design/v2-core-design-locks.md (health gating)
 *
 * Why closed:
 * - Execution is gated on an explicit state machine (no “maybe healthy”)
 * - Studio/clients can render a stable set of health states
 *
 * Values:
 * - `healthy`: safe for execution
 * - `corrupt_tail`: validated prefix exists but tail is corrupted (salvage-only)
 * - `corrupt_head`: corruption early in log (salvage-only)
 * - `unknown_version`: schema/version mismatch prevents safe interpretation
 */
export type SessionHealthV2 =
  | { readonly kind: 'healthy' }
  | { readonly kind: 'corrupt_tail'; readonly reason: CorruptionReasonV2 }
  | { readonly kind: 'corrupt_head'; readonly reason: CorruptionReasonV2 }
  | { readonly kind: 'unknown_version'; readonly reason: CorruptionReasonV2 };
