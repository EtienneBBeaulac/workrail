import type { Brand } from '../../../runtime/brand.js';
import type { Sha256Digest } from './workflow-ids.js';

/**
 * Branded type: SnapshotRef (content-addressed snapshot reference).
 *
 * Footgun prevented:
 * - Prevents mixing snapshot refs with workflow hashes
 * - Prevents plain strings being used as snapshot identifiers
 *
 * How to construct:
 * - Compute from a snapshot file (content-addressed)
 * - Use `asSnapshotRef(asSha256Digest(...))` only after validation or computation
 *
 * Lock: snapshotRef = sha256(RFC 8785 JCS canonical bytes of ExecutionSnapshotFileV1).
 *
 * Example:
 * ```typescript
 * const ref = asSnapshotRef(asSha256Digest('sha256:...'));
 * await snapshotStore.getExecutionSnapshotV1(ref);
 * ```
 */
export type SnapshotRef = Brand<Sha256Digest, 'v2.SnapshotRef'>;

/**
 * Branded type: CanonicalBytes (RFC 8785 JCS canonical JSON bytes).
 *
 * Footgun prevented:
 * - Prevents hashing raw/non-canonical JSON bytes (canonicalize-before-hash discipline)
 * - Prevents passing arbitrary Uint8Array into content-addressed hashing
 *
 * How to construct:
 * - Use `toCanonicalBytes(jsonValue)` (canonicalization boundary)
 * - Treat as immutable; do not mutate the underlying bytes
 *
 * Lock: All v2 hashing inputs are RFC 8785 (JCS) canonical JSON bytes.
 *
 * Example:
 * ```typescript
 * const canonical = asCanonicalBytes(new Uint8Array());
 * ```
 */
export type CanonicalBytes = Brand<Uint8Array, 'v2.CanonicalBytes'>;

export function asSnapshotRef(value: Sha256Digest): SnapshotRef {
  return value as SnapshotRef;
}

export function asCanonicalBytes(value: Uint8Array): CanonicalBytes {
  return value as CanonicalBytes;
}
