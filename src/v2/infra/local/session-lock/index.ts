import type { ResultAsync } from 'neverthrow';
import type { DataDirPortV2 } from '../../../ports/data-dir.port.js';
import type { FileSystemPortV2 } from '../../../ports/fs.port.js';
import type { TimeClockPortV2 } from '../../../ports/time-clock.port.js';
import type { SessionId } from '../../../durable-core/ids/index.js';
import type { SessionLockHandleV2, SessionLockError, SessionLockPortV2 } from '../../../ports/session-lock.port.js';

/**
 * Local, per-session single-writer lock.
 *
 * Locked behavior:
 * - fail fast if the lock file already exists
 * - no stale detection / no auto-breaking
 */
export class LocalSessionLockV2 implements SessionLockPortV2 {
  constructor(
    private readonly dataDir: DataDirPortV2,
    private readonly fs: FileSystemPortV2,
    private readonly clock: TimeClockPortV2
  ) {}

  acquire(sessionId: SessionId): ResultAsync<SessionLockHandleV2, SessionLockError> {
    const sessionDir = this.dataDir.sessionDir(sessionId);
    const lockPath = this.dataDir.sessionLockPath(sessionId);

    const mapFs = (e: { readonly code: string; readonly message: string }): SessionLockError => {
      if (e.code === 'FS_ALREADY_EXISTS') {
        return {
          code: 'SESSION_LOCK_BUSY',
          message: `Session is locked by another process: ${sessionId}`,
          retry: { kind: 'retryable_after_ms', afterMs: 250 },
          lockPath,
        };
      }
      return { code: 'SESSION_LOCK_IO_ERROR', message: e.message, lockPath };
    };

    return this.fs
      .mkdirp(sessionDir)
      .andThen(() =>
        this.fs.openExclusive(
          lockPath,
          new TextEncoder().encode(
            JSON.stringify({
              v: 1,
              sessionId,
              pid: this.clock.getPid(),
              startedAtMs: this.clock.nowMs(),
            })
          )
        )
      )
      .andThen(({ fd }) => this.fs.fsyncFile(fd).andThen(() => this.fs.closeFile(fd)))
      .mapErr(mapFs)
      .map(() => ({ kind: 'v2_session_lock_handle', sessionId } as const));
  }

  release(handle: SessionLockHandleV2): ResultAsync<void, SessionLockError> {
    const lockPath = this.dataDir.sessionLockPath(handle.sessionId);
    return this.fs.unlink(lockPath).mapErr((e): SessionLockError => ({
      code: 'SESSION_LOCK_IO_ERROR',
      message: e.message,
      lockPath,
    }));
  }
}
