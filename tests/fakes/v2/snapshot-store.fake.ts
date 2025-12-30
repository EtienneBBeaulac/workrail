/**
 * In-memory fake for snapshot store (content-addressed).
 *
 * Implements CAS invariants:
 * - SnapshotRef is deterministically computed from snapshot content
 * - Snapshots are immutable (put is idempotent for same content)
 * - get() returns null if not found (not an error)
 *
 * @enforces snapshot-cas-idempotent
 */

import { okAsync, type ResultAsync } from 'neverthrow';
import type { SnapshotStorePortV2, SnapshotStoreError } from '../../../src/v2/ports/snapshot-store.port.js';
import type { SnapshotRef } from '../../../src/v2/durable-core/ids/index.js';
import { asSnapshotRef, asSha256Digest } from '../../../src/v2/durable-core/ids/index.js';
import type { ExecutionSnapshotFileV1 } from '../../../src/v2/durable-core/schemas/execution-snapshot/index.js';
import { toCanonicalBytes } from '../../../src/v2/durable-core/canonical/jcs.js';
import { Sha256PortV2 } from '../../../src/v2/ports/sha256.port.js';

// Use Node's crypto for the fake (tests can inject mock sha256 if needed)
import { createHash } from 'node:crypto';

/**
 * In-memory fake snapshot store.
 *
 * Behavior:
 * - Snapshots are stored by content-addressed reference (sha256 of canonical JSON)
 * - get() returns null if snapshot not found (idempotent)
 * - put() is idempotent: same snapshot always gets same ref
 */
export class InMemorySnapshotStore implements SnapshotStorePortV2 {
  private store = new Map<string, ExecutionSnapshotFileV1>();

  putExecutionSnapshotV1(snapshot: ExecutionSnapshotFileV1): ResultAsync<SnapshotRef, SnapshotStoreError> {
    // Compute canonical ref deterministically
    const canonicalResult = toCanonicalBytes(snapshot);
    if (canonicalResult.isErr()) {
      return errAsync({
        code: 'SNAPSHOT_STORE_IO_ERROR' as const,
        message: `Failed to canonicalize snapshot: ${canonicalResult.error.message}`,
      });
    }

    const canonical = canonicalResult.value;
    const digest = createHash('sha256').update(Buffer.from(canonical)).digest('hex');
    const ref = asSnapshotRef(asSha256Digest(`sha256:${digest}`));

    // Store snapshot (idempotent: same content → same ref)
    this.store.set(String(ref), snapshot);

    return okAsync(ref);
  }

  getExecutionSnapshotV1(
    snapshotRef: SnapshotRef,
  ): ResultAsync<ExecutionSnapshotFileV1 | null, SnapshotStoreError> {
    const snapshot = this.store.get(String(snapshotRef));
    return okAsync(snapshot ?? null);
  }
}
