/**
 * Unit tests for LocalSessionLockV2.clearIfStaleLock() behavior.
 *
 * Tests the stale lock detection path introduced to handle crash recovery.
 * A "stale" lock is one whose owning process (by PID) is no longer alive.
 *
 * Tests exercise clearIfStaleLock indirectly through acquire(), which
 * calls it as pre-flight cleanup before attempting openExclusive.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryFileSystem } from '../../fakes/v2/file-system.fake.js';
import { FakeTimeClockV2 } from '../../fakes/v2/time-clock.fake.js';
import { LocalSessionLockV2 } from '../../../src/v2/infra/local/session-lock/index.js';
import type { DataDirPortV2 } from '../../../src/v2/ports/data-dir.port.js';
import type { SessionId } from '../../../src/v2/durable-core/ids/index.js';

// ---------------------------------------------------------------------------
// Fake DataDir
// ---------------------------------------------------------------------------

const SESSION_DIR = '/data/sessions/sess-001';
const LOCK_PATH = '/data/sessions/sess-001/.lock';
const SESSION_ID = 'sess-001' as SessionId;

const fakeDataDir: DataDirPortV2 = {
  root: () => '/data',
  sessionDir: () => SESSION_DIR,
  sessionLockPath: () => LOCK_PATH,
  perfDir: () => '/data/perf',
  snapshotDir: () => '/data/snapshots',
  snapshotPath: () => '/data/snapshots/snap.json',
  snapshotTmpPath: () => '/data/snapshots/snap.json.tmp',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLock(pid: number) {
  return JSON.stringify({ v: 1, sessionId: SESSION_ID, pid, startedAtMs: Date.now() });
}

async function acquireExpectSuccess(lock: LocalSessionLockV2) {
  const result = await lock.acquire(SESSION_ID);
  expect(result.isOk()).toBe(true);
}

async function acquireExpectBusy(lock: LocalSessionLockV2) {
  const result = await lock.acquire(SESSION_ID);
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.code).toBe('SESSION_LOCK_BUSY');
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LocalSessionLockV2 stale lock detection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clears a stale lock (dead PID) and acquires successfully', async () => {
    const fs = new InMemoryFileSystem();
    const clock = new FakeTimeClockV2();
    const lock = new LocalSessionLockV2(fakeDataDir, fs, clock);

    // Plant a stale lock with a dead PID
    const deadPid = 99999;
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === deadPid && signal === 0) {
        const err = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
        throw err;
      }
      return true;
    });

    // Pre-create the lock file with the dead PID
    await fs.mkdirp(SESSION_DIR);
    await fs.writeFileBytes(LOCK_PATH, new TextEncoder().encode(makeLock(deadPid)));

    // Acquire should clear the stale lock and succeed
    await acquireExpectSuccess(lock);
  });

  it('does NOT clear a live lock (process still alive)', async () => {
    const fs = new InMemoryFileSystem();
    const clock = new FakeTimeClockV2();
    const lock = new LocalSessionLockV2(fakeDataDir, fs, clock);

    const livePid = 12345;
    // process.kill(pid, 0) does NOT throw for live processes
    vi.spyOn(process, 'kill').mockReturnValue(true);

    await fs.mkdirp(SESSION_DIR);
    await fs.writeFileBytes(LOCK_PATH, new TextEncoder().encode(makeLock(livePid)));

    // Acquire should fail -- live lock, not stale
    await acquireExpectBusy(lock);
  });

  it('does NOT clear a lock when EPERM is returned (alive, no permission)', async () => {
    const fs = new InMemoryFileSystem();
    const clock = new FakeTimeClockV2();
    const lock = new LocalSessionLockV2(fakeDataDir, fs, clock);

    const pidNoPermission = 1; // init/systemd -- alive but EPERM
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      throw err;
    });

    await fs.mkdirp(SESSION_DIR);
    await fs.writeFileBytes(LOCK_PATH, new TextEncoder().encode(makeLock(pidNoPermission)));

    // Should be treated as live (not stale) -- lock is preserved
    await acquireExpectBusy(lock);
  });

  it('proceeds normally when no lock file exists (no stale to clear)', async () => {
    const fs = new InMemoryFileSystem();
    const clock = new FakeTimeClockV2();
    const lock = new LocalSessionLockV2(fakeDataDir, fs, clock);

    // No pre-existing lock file -- clearIfStaleLock returns ok() gracefully
    await acquireExpectSuccess(lock);
  });

  it('does not clear lock when lock file has invalid JSON', async () => {
    const fs = new InMemoryFileSystem();
    const clock = new FakeTimeClockV2();
    const lock = new LocalSessionLockV2(fakeDataDir, fs, clock);

    vi.spyOn(process, 'kill'); // Should not be called

    await fs.mkdirp(SESSION_DIR);
    await fs.writeFileBytes(LOCK_PATH, new TextEncoder().encode('not-json'));

    // Can't determine staleness -- treated as live, acquire fails
    await acquireExpectBusy(lock);

    expect(process.kill).not.toHaveBeenCalled();
  });

  it('does not clear lock when PID field is missing from lock file', async () => {
    const fs = new InMemoryFileSystem();
    const clock = new FakeTimeClockV2();
    const lock = new LocalSessionLockV2(fakeDataDir, fs, clock);

    vi.spyOn(process, 'kill'); // Should not be called

    await fs.mkdirp(SESSION_DIR);
    await fs.writeFileBytes(LOCK_PATH, new TextEncoder().encode(JSON.stringify({ v: 1 })));

    await acquireExpectBusy(lock);
    expect(process.kill).not.toHaveBeenCalled();
  });

  it('does NOT clear a lock from a different worker sharing the same PID', async () => {
    const fs = new InMemoryFileSystem();
    const clock = new FakeTimeClockV2();
    // This instance is the 'mcp-server' worker
    const lock = new LocalSessionLockV2(fakeDataDir, fs, clock, 'mcp-server');

    const sharedPid = clock.getPid(); // 12345 (same PID as the lock below)
    // process.kill(pid, 0) returns true -- the process is alive
    vi.spyOn(process, 'kill').mockReturnValue(true);

    // Plant a lock file with the SAME PID but a DIFFERENT workerId ('daemon')
    await fs.mkdirp(SESSION_DIR);
    await fs.writeFileBytes(
      LOCK_PATH,
      new TextEncoder().encode(
        JSON.stringify({ v: 1, sessionId: SESSION_ID, pid: sharedPid, workerId: 'daemon', startedAtMs: Date.now() })
      )
    );

    // Acquire should fail -- a different worker in this same process holds the lock
    await acquireExpectBusy(lock);
  });

  it('release removes the lock file', async () => {
    const fs = new InMemoryFileSystem();
    const clock = new FakeTimeClockV2();
    const lock = new LocalSessionLockV2(fakeDataDir, fs, clock);

    const handle = await lock.acquire(SESSION_ID);
    expect(handle.isOk()).toBe(true);

    const release = await lock.release(handle._unsafeUnwrap());
    expect(release.isOk()).toBe(true);

    // Lock file should be gone -- next acquire should succeed
    await acquireExpectSuccess(lock);
  });
});
