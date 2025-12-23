/**
 * Session health classification (v2 Slice 2.5).
 *
 * Locked intent:
 * - Correctness paths require `healthy`
 * - Salvage is read-only and explicitly signaled
 * - Corruption reasons are manifest-attested only (no filesystem scanning for orphans)
 */

export type CorruptionReasonV2 =
  | { readonly code: 'digest_mismatch'; readonly message: string }
  | { readonly code: 'non_contiguous_indices'; readonly message: string }
  | { readonly code: 'missing_attested_segment'; readonly message: string }
  | { readonly code: 'unknown_schema_version'; readonly message: string };

export type SessionHealthV2 =
  | { readonly kind: 'healthy' }
  | { readonly kind: 'corrupt_tail'; readonly reason: CorruptionReasonV2 }
  | { readonly kind: 'corrupt_head'; readonly reason: CorruptionReasonV2 }
  | { readonly kind: 'unknown_version'; readonly reason: CorruptionReasonV2 };
