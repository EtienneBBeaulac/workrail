import type { ResultAsync } from 'neverthrow';
import type { SnapshotRef } from '../durable-core/ids/index.js';
import type { ExecutionSnapshotFileV1 } from '../durable-core/schemas/execution-snapshot/index.js';

export type SnapshotStoreError =
  | { readonly code: 'SNAPSHOT_STORE_IO_ERROR'; readonly message: string }
  | { readonly code: 'SNAPSHOT_STORE_CORRUPTION_DETECTED'; readonly message: string }
  | { readonly code: 'SNAPSHOT_STORE_INVARIANT_VIOLATION'; readonly message: string };

/**
 * Snapshot CAS store (v2 Slice 3 prereq).
 *
 * Locked intent:
 * - immutable, content-addressed
 * - snapshotRef = sha256(JCS(snapshotFile))
 * - store canonical bytes to prevent drift
 */
export interface SnapshotStorePortV2 {
  putExecutionSnapshotV1(snapshot: ExecutionSnapshotFileV1): ResultAsync<SnapshotRef, SnapshotStoreError>;
  getExecutionSnapshotV1(snapshotRef: SnapshotRef): ResultAsync<ExecutionSnapshotFileV1 | null, SnapshotStoreError>;
}
