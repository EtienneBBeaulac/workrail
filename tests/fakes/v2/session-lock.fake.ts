/**
 * In-memory fake for session lock (exclusive per-session locking).
 *
 * Implements lock invariants:
 * - Single writer per session (mutually exclusive)
 * - Fail-fast if lock is busy (no blocking)
 * - release() unlocks the session
 *
 * @enforces session-lock-exclusive
 * @enforces session-lock-busy-fails-fast
 */

import { okAsync, errAsync, type ResultAsync } from 'neverthrow';
import type { SessionLockPortV2, SessionLockError, SessionLockHandleV2 } from '../../../src/v2/ports/session-lock.port.js';
import type { SessionId } from '../../../src/v2/durable-core/ids/index.js';

/**
 * In-memory fake session lock.
 *
 * Behavior:
 * - Tracks which sessions currently have held locks
 * - acquire() succeeds only if session is not locked
 * - release() unlocks the session
 * - Multiple acquire() on same session fails fast with retryable error
 */
export class InMemorySessionLock implements SessionLockPortV2 {
  private heldLocks = new Set<string>();

  acquire(sessionId: SessionId): ResultAsync<SessionLockHandleV2, SessionLockError> {
    const key = String(sessionId);

    if (this.heldLocks.has(key)) {
      return errAsync({
        code: 'SESSION_LOCK_BUSY' as const,
        message: `Session lock is busy: ${key}`,
        retry: { kind: 'retryable_after_ms' as const, afterMs: 10 },
        lockPath: `fake_lock_${key}`,
      });
    }

    // Acquire the lock
    this.heldLocks.add(key);

    const handle: SessionLockHandleV2 = {
      kind: 'v2_session_lock_handle',
      sessionId,
    };

    return okAsync(handle);
  }

  release(handle: SessionLockHandleV2): ResultAsync<void, SessionLockError> {
    const key = String(handle.sessionId);
    this.heldLocks.delete(key);
    return okAsync(void 0);
  }
}
