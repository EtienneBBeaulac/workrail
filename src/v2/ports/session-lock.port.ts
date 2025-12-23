import type { ResultAsync } from 'neverthrow';
import type { SessionId } from '../durable-core/ids/index.js';

export type SessionLockError =
  | {
      readonly code: 'SESSION_LOCK_BUSY';
      readonly message: string;
      readonly retry: { readonly kind: 'retryable'; readonly afterMs: number };
      readonly lockPath: string;
    }
  | { readonly code: 'SESSION_LOCK_IO_ERROR'; readonly message: string; readonly lockPath: string };

export interface SessionLockHandleV2 {
  readonly kind: 'v2_session_lock_handle';
  readonly sessionId: SessionId;
}

/**
 * Single-writer lock (per session).
 *
 * Locked behavior: fail-fast if busy. Do not attempt stale detection / auto-breaking.
 */
export interface SessionLockPortV2 {
  acquire(sessionId: SessionId): ResultAsync<SessionLockHandleV2, SessionLockError>;
  release(handle: SessionLockHandleV2): ResultAsync<void, SessionLockError>;
}
