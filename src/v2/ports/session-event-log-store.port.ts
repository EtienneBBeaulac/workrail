import type { ResultAsync } from 'neverthrow';
import type { SessionId, SnapshotRef } from '../durable-core/ids/index.js';
import type { DomainEventV1, ManifestRecordV1 } from '../durable-core/schemas/session/index.js';

export interface SnapshotPinV2 {
  readonly snapshotRef: SnapshotRef;
  readonly eventIndex: number;
  readonly createdByEventId: string;
}

export interface AppendPlanV2 {
  /**
   * Domain events to append as the atomic truth unit.
   *
   * Locked: segment files are JSONL, ordered by EventIndex, and committed via manifest attestation.
   */
  readonly events: readonly DomainEventV1[];

  /**
   * Snapshot refs introduced by these events that must be pinned (pin-on-create).
   *
   * Locked: pins must be written AFTER `segment_closed`.
   */
  readonly snapshotPins: readonly SnapshotPinV2[];
}

export type SessionEventLogStoreError =
  | { readonly code: 'SESSION_STORE_LOCK_BUSY'; readonly message: string; readonly retry: { readonly kind: 'retryable'; readonly afterMs: number } }
  | { readonly code: 'SESSION_STORE_IO_ERROR'; readonly message: string }
  | { readonly code: 'SESSION_STORE_CORRUPTION_DETECTED'; readonly message: string }
  | { readonly code: 'SESSION_STORE_INVARIANT_VIOLATION'; readonly message: string };

export interface LoadedSessionTruthV2 {
  readonly manifest: readonly ManifestRecordV1[];
  readonly events: readonly DomainEventV1[];
}

/**
 * Append-only session truth substrate.
 *
 * Locked: the only durable mutation is `append(sessionId, plan)`.
 */
export interface SessionEventLogStorePortV2 {
  append(sessionId: SessionId, plan: AppendPlanV2): ResultAsync<void, SessionEventLogStoreError>;
  load(sessionId: SessionId): ResultAsync<LoadedSessionTruthV2, SessionEventLogStoreError>;
}
