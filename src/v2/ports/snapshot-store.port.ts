import type { ResultAsync } from 'neverthrow';
import type { SnapshotRef } from '../durable-core/ids/index.js';
import type { ExecutionSnapshotFileV1 } from '../durable-core/schemas/execution-snapshot/index.js';

export type SnapshotStoreError =
  | { readonly code: 'SNAPSHOT_STORE_IO_ERROR'; readonly message: string }
  | { readonly code: 'SNAPSHOT_STORE_CORRUPTION_DETECTED'; readonly message: string }
  | { readonly code: 'SNAPSHOT_STORE_INVARIANT_VIOLATION'; readonly message: string };

/**
 * Port: Content-addressed snapshot store (CAS).
 * 
 * Purpose:
 * - Store execution snapshots by content hash
 * - Enable deduplication (same content → same ref)
 * - Support export/import via snapshot references
 * 
 * Locked invariants (v2-core-design-locks.md Section 1.1, 2.2):
 * - SnapshotRef = sha256(JCS(snapshot)) - content-addressed
 * - Snapshots are immutable (put once, never modified)
 * - Global CAS (shared across all sessions)
 * - GC uses mark-and-sweep from session manifest pins
 * 
 * Guarantees:
 * - put() is idempotent (same snapshot → same ref)
 * - get() returns null if not found (not an error)
 * - Integrity: hash of retrieved snapshot matches ref
 * - Thread-safe: concurrent reads/writes safe
 * 
 * When to use:
 * - Store execution snapshots when creating nodes
 * - Retrieve snapshots for rehydration/replay
 * - Never modify snapshots after put
 * 
 * Example:
 * ```typescript
 * const ref = await store.putExecutionSnapshotV1(snapshot);
 * const retrieved = await store.getExecutionSnapshotV1(ref);
 * ```
 */
export interface SnapshotStorePortV2 {
  /**
   * Store execution snapshot in CAS.
   * 
   * Returns: SnapshotRef = sha256(JCS(snapshot)) - deterministic
   * Idempotent: same snapshot content → same ref
   */
  putExecutionSnapshotV1(snapshot: ExecutionSnapshotFileV1): ResultAsync<SnapshotRef, SnapshotStoreError>;

  /**
   * Retrieve execution snapshot by content-addressed ref.
   * 
   * Returns: snapshot if found, null if not found (not an error)
   * Validates: hash of retrieved snapshot matches ref
   */
  getExecutionSnapshotV1(snapshotRef: SnapshotRef): ResultAsync<ExecutionSnapshotFileV1 | null, SnapshotStoreError>;
}
