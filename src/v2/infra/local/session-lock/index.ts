import type { ResultAsync } from 'neverthrow';
import { okAsync } from 'neverthrow';
import { randomUUID } from 'node:crypto';
import type { DataDirPortV2 } from '../../../ports/data-dir.port.js';
import type { FileSystemPortV2 } from '../../../ports/fs.port.js';
import type { TimeClockPortV2 } from '../../../ports/time-clock.port.js';
import type { SessionId } from '../../../durable-core/ids/index.js';
import type { SessionLockHandleV2, SessionLockError, SessionLockPortV2 } from '../../../ports/session-lock.port.js';

/**
 * Local, per-session single-writer lock.
 *
 * Locked behavior:
 * - clear stale lock files left by crashed processes before acquiring
 * - fail fast if a live process holds the lock
 *
 * @param workerId - Identifies this specific worker within a process (e.g. 'mcp-server',
 *   'daemon'). Defaults to 'default' for backward compatibility with single-process callers.
 *   When two workers share a PID (same process), the workerId discriminant prevents a live
 *   worker's lock from being incorrectly cleared by the other worker.
 */
export class LocalSessionLockV2 implements SessionLockPortV2 {
  /** Identifies the acquiring instance for diagnostics, never proof of process death. */
  private readonly instanceId = randomUUID();

  constructor(
    private readonly dataDir: DataDirPortV2,
    private readonly fs: FileSystemPortV2,
    private readonly clock: TimeClockPortV2,
    private readonly workerId: string = 'default'
  ) {}

  /**
   * Remove the lock file if it is stale (no longer owned by a live caller).
   *
   * A different instance or worker in the same process can still hold a live lock.
   * Only a confirmed dead process permits stale-lock recovery. Recomposition does
   * not establish that the previous instance has finished its critical section.
   *
   * Uses `process.kill(pid, 0)` -- signal 0 checks process existence without
   * sending a signal. Throws ESRCH when the PID does not exist.
   *
   * Never fails: if the lock file can't be read or the PID check is
   * ambiguous, the method returns ok(undefined) and acquisition proceeds
   * normally (will fail with SESSION_LOCK_BUSY if lock is genuinely held).
   */
  private clearIfStaleLock(lockPath: string): ResultAsync<void, never> {
    return this.fs
      .readFileUtf8(lockPath)
      .map((content) => {
        try {
          interface LockFileData { pid?: unknown; workerId?: unknown; instanceId?: unknown }
          const data = JSON.parse(content) as LockFileData;
          const pid = typeof data.pid === 'number' ? data.pid : null;
          if (pid === null) return false;

          const myPid = this.clock.getPid();
          if (pid === myPid) return false;

          try {
            process.kill(pid, 0); // throws ESRCH if dead, EPERM if alive but no permission
            return false; // process alive -- not stale
          } catch (e) {
            return (e as NodeJS.ErrnoException).code === 'ESRCH'; // dead → stale
          }
        } catch {
          return false; // parse error → can't determine staleness
        }
      })
      .andThen((isStale) => {
        if (!isStale) return okAsync(undefined);
        console.error(`[SessionLock] Removing stale lock at ${lockPath} (process no longer alive)`);
        return this.fs.unlink(lockPath);
      })
      .orElse(() => okAsync(undefined)); // lock file missing → nothing to clear
  }

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
      .andThen(() => this.clearIfStaleLock(lockPath))
      .andThen(() =>
        this.fs.openExclusive(
          lockPath,
          new TextEncoder().encode(
            JSON.stringify({
              v: 1,
              sessionId,
              pid: this.clock.getPid(),
              workerId: this.workerId,
              instanceId: this.instanceId,
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
