import type { ResultAsync } from 'neverthrow';
import type { SessionId } from '../durable-core/ids/index.js';

export type SessionLockError =
  | {
      readonly code: 'SESSION_LOCK_BUSY';
      readonly message: string;
      readonly retry: { readonly kind: 'retryable_after_ms'; readonly afterMs: number };
      readonly lockPath: string;
    }
  | { readonly code: 'SESSION_LOCK_IO_ERROR'; readonly message: string; readonly lockPath: string };

export interface SessionLockHandleV2 {
  readonly kind: 'v2_session_lock_handle';
  readonly sessionId: SessionId;
}

/**
 * Port: Per-session exclusive lock (single-writer enforcement).
 * 
 * Purpose:
 * - Enforce single writer per session
 * - Prevent concurrent modifications
 * - Enable safe append ordering
 * 
 * Locked invariants (v2-core-design-locks.md Section 15):
 * - OS-level exclusive file lock
 * - Fail-fast if busy (no blocking)
 * - Cross-process safe
 * 
 * Guarantees:
 * - Only one writer at a time
 * - acquire() fails immediately if busy
 * - release() required after acquire
 * 
 * When to use:
 * - Via ExecutionSessionGateV2 only
 * - Don't call directly
 * 
 * Example:
 * ```typescript
 * const handle = await lock.acquire(sessionId);
 * try {
 *   // Critical section
 * } finally {
 *   await lock.release(handle);
 * }
 * ```
 */
export interface SessionLockPortV2 {
  acquire(sessionId: SessionId): ResultAsync<SessionLockHandleV2, SessionLockError>;
  release(handle: SessionLockHandleV2): ResultAsync<void, SessionLockError>;
}
