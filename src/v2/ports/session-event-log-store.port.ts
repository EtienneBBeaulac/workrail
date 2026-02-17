import type { ResultAsync } from 'neverthrow';
import type { SessionId, SnapshotRef } from '../durable-core/ids/index.js';
import type { DomainEventV1, ManifestRecordV1 } from '../durable-core/schemas/session/index.js';
import type { WithHealthySessionLock } from '../durable-core/ids/with-healthy-session-lock.js';
import type { CorruptionReasonV2 } from '../durable-core/schemas/session/session-health.js';

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
  | { readonly code: 'SESSION_STORE_LOCK_BUSY'; readonly message: string; readonly retry: { readonly kind: 'retryable_after_ms'; readonly afterMs: number } }
  | { readonly code: 'SESSION_STORE_IO_ERROR'; readonly message: string }
  | {
      readonly code: 'SESSION_STORE_CORRUPTION_DETECTED';
      readonly message: string;
      readonly location: 'head' | 'tail';
      readonly reason: CorruptionReasonV2;
    }
  | { readonly code: 'SESSION_STORE_INVARIANT_VIOLATION'; readonly message: string };

export interface LoadedSessionTruthV2 {
  readonly manifest: readonly ManifestRecordV1[];
  readonly events: readonly DomainEventV1[];
}

export type LoadedValidatedPrefixV2 =
  | { readonly kind: 'complete'; readonly truth: LoadedSessionTruthV2 }
  | { readonly kind: 'truncated'; readonly truth: LoadedSessionTruthV2; readonly tailReason: CorruptionReasonV2 };

/**
 * Port: Session event log storage (append-only truth substrate).
 * 
 * Purpose:
 * - Persist session domain events as append-only JSONL segments
 * - Enforce single-writer via cross-process lock
 * - Validate integrity via manifest control stream
 * 
 * Locked invariants (v2-core-design-locks.md Section 1):
 * - Events are strictly ordered by EventIndex (0-based, monotonic)
 * - Append is crash-safe (temp → fsync → rename → fsync)
 * - Orphan segments without manifest.segment_closed are ignored
 * - No salvage scanning; corruption is explicit via SessionHealth
 * - Pin-after-close: segment → segment_closed → snapshot_pinned
 * 
 * Guarantees:
 * - append() is atomic: all events or none
 * - load() returns events in ascending EventIndex order
 * - Idempotent: duplicate dedupeKey is no-op
 * - Concurrent access: single-writer enforced via lock witness
 * 
 * When to use:
 * - All durable writes must go through append() with a healthy lock witness
 * - Rehydrate/inspection uses load() (readonly)
 * - Never mutate returned events (they are immutable snapshots)
 * 
 * Example:
 * ```typescript
 * await gate.withHealthySessionLock(sessionId, (lock) =>
 *   store.append(lock, {
 *     events: [sessionCreated, runStarted],
 *     snapshotPins: [{ snapshotRef, eventIndex: 1, createdByEventId: 'evt_run' }],
 *   })
 * );
 * ```
 */
export interface SessionEventLogReadonlyStorePortV2 {
  /**
   * Load complete session truth (events + manifest).
   * 
   * Returns all committed events in ascending EventIndex order.
   * Fails fast if corruption detected; use loadValidatedPrefix for salvage.
   */
  load(sessionId: SessionId): ResultAsync<LoadedSessionTruthV2, SessionEventLogStoreError>;

  /**
   * Read-only salvage path: return the validated prefix, if any.
   *
   * Slice 2.5 lock: used for inspection/export only; execution requires SessionHealth=healthy.
   * 
   * Returns:
   * - kind='complete': fully validated session
   * - kind='truncated': validated prefix with corruption reason
   */
  loadValidatedPrefix(sessionId: SessionId): ResultAsync<LoadedValidatedPrefixV2, SessionEventLogStoreError>;
}

/**
 * Port: Append-capable session event log (requires witness).
 * 
 * Slice 2.5 lock: append requires WithHealthySessionLock witness
 * to prevent accidental writes and ensure session health.
 * 
 * Separated from readonly port to make rehydrate-purity enforceable.
 */
export interface SessionEventLogAppendStorePortV2 {
  /**
   * Append durable truth under a healthy-held session lock witness.
   *
   * Atomic: all events in plan or none.
   * Idempotent: replaying same dedupeKeys is no-op.
   * 
   * Partial idempotency (some exist, some don't) fails fast with INVARIANT_VIOLATION.
   * 
   * Slice 2.5 lock: requires non-forgeable witness from ExecutionSessionGateV2.
   * Witness misuse-after-release fails fast before any I/O.
   */
  append(lock: WithHealthySessionLock, plan: AppendPlanV2): ResultAsync<void, SessionEventLogStoreError>;
}
