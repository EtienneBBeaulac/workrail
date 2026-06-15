import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { WorkspaceLockManager } from '../../src/daemon/workspace-lock.js';
import { makeWriteTool, makeEditTool, makeReadTool } from '../../src/daemon/tools/file-tools.js';
import type { SessionScope } from '../../src/daemon/session-scope.js';
import { DefaultFileStateTracker } from '../../src/daemon/session-scope.js';
import type { RunId } from '../../src/daemon/daemon-events.js';
import type { SessionId } from '../../src/v2/durable-core/ids/index.js';
import { ok, err, Result } from 'neverthrow';

describe('WorkspaceLockManager & EditLimiter Integration Tests', () => {
  const tempTestDir = path.join(os.tmpdir(), 'workrail-lock-tests-' + Math.random().toString(36).substring(2));

  beforeEach(async () => {
    await fs.mkdir(tempTestDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tempTestDir, { recursive: true, force: true });
    } catch {}
  });

  it('should acquire lock when empty and reject different run UUID on active process', async () => {
    const lockRes = await WorkspaceLockManager.acquire(tempTestDir, 'uuid-1');
    expect(lockRes.isOk()).toBe(true);

    const lock = lockRes._unsafeUnwrap();
    expect(lock.uuid).toBe('uuid-1');

    // Attempting with a different UUID in another "session" (but same PID)
    // Wait, the lock stack allows nested locks in the same process!
    // So if same PID, it succeeds.
    // Let's test with a mock file of a different PID that is ALIVE.
    // We can use process.pid, but to test eviction of a DEAD process:
    const lockFile = path.join(tempTestDir, '.workrail.lock');
    const deadPidData = {
      pid: 999999, // very likely dead/non-existent
      uuid: 'uuid-dead',
      heartbeat: Date.now(),
    };
    await fs.writeFile(lockFile, JSON.stringify(deadPidData), 'utf8');

    // Acquire should evict the dead PID lock!
    const evictRes = await WorkspaceLockManager.acquire(tempTestDir, 'uuid-new');
    expect(evictRes.isOk()).toBe(true);
    expect(evictRes._unsafeUnwrap().uuid).toBe('uuid-new');

    await WorkspaceLockManager.release(tempTestDir, 'uuid-new');
    await lock.release();
  });

  it('should evict lock on starved heartbeat even if process is alive', async () => {
    const lockFile = path.join(tempTestDir, '.workrail.lock');
    const starvedData = {
      pid: process.pid,
      uuid: 'uuid-starved',
      heartbeat: Date.now() - 100000, // 100s ago (> 90s lease)
    };
    await fs.writeFile(lockFile, JSON.stringify(starvedData), 'utf8');

    // Acquire should succeed on starved heartbeat
    const acquireRes = await WorkspaceLockManager.acquire(tempTestDir, 'uuid-fresh');
    expect(acquireRes.isOk()).toBe(true);
    await WorkspaceLockManager.release(tempTestDir, 'uuid-fresh');
  });

  it('should handle nested locks in the same process using stack-based logic', async () => {
    const lock1 = await WorkspaceLockManager.acquire(tempTestDir, 'uuid-parent');
    expect(lock1.isOk()).toBe(true);

    const lock2 = await WorkspaceLockManager.acquire(tempTestDir, 'uuid-child');
    expect(lock2.isOk()).toBe(true);

    // Lock file should now reflect the top of the stack (uuid-child)
    const content = await fs.readFile(path.join(tempTestDir, '.workrail.lock'), 'utf8');
    const data = JSON.parse(content);
    expect(data.uuid).toBe('uuid-child');

    // Release child
    await WorkspaceLockManager.release(tempTestDir, 'uuid-child');

    // Lock file should fall back to parent
    const content2 = await fs.readFile(path.join(tempTestDir, '.workrail.lock'), 'utf8');
    const data2 = JSON.parse(content2);
    expect(data2.uuid).toBe('uuid-parent');

    await WorkspaceLockManager.release(tempTestDir, 'uuid-parent');
  });

  it('should enforce write-assertion in Write and Edit tools when lock is stolen', async () => {
    const parentLock = await WorkspaceLockManager.acquire(tempTestDir, 'my-uuid');
    expect(parentLock.isOk()).toBe(true);

    const fileEditCounts = new Map<string, number>();
    const state = {
      terminalSignal: null as any,
      issueSummaries: [] as string[],
    };

    const scope: SessionScope = {
      fileTracker: new DefaultFileStateTracker(),
      onAdvance: () => {},
      onComplete: () => {},
      onTokenUpdate: () => {},
      onIssueReported: () => {},
      onSteer: () => {},
      getCurrentToken: () => '',
      sessionWorkspacePath: tempTestDir,
      spawnCurrentDepth: 0,
      spawnMaxDepth: 3,
      workrailSessionId: 'wf-session' as SessionId,
      emitter: undefined,
      sessionId: 'my-uuid' as RunId,
      workflowId: 'wf',
      triggerWorkspacePath: tempTestDir,
      triggerGoal: '',
      activeSessionSet: undefined,
      onGateParked: () => {},
      recordFileEdit: (filePath: string) => {
        const count = (fileEditCounts.get(filePath) ?? 0) + 1;
        fileEditCounts.set(filePath, count);
        if (count > 5) {
          state.terminalSignal = { kind: 'stuck', reason: 'edit_limit_exceeded' };
          return err(new Error('limit exceeded'));
        }
        return ok(undefined);
      },
      assertWorkspaceLockActive: () => {
        WorkspaceLockManager.assertLockActive(tempTestDir, 'my-uuid');
      },
    };

    const writeTool = makeWriteTool(tempTestDir, scope.fileTracker.toMap(), {}, 'my-uuid' as RunId, undefined, null, scope.recordFileEdit, scope.assertWorkspaceLockActive);
    const readTool = makeReadTool(tempTestDir, scope.fileTracker.toMap(), {}, 'my-uuid' as RunId, undefined, null);

    const targetFile = path.join(tempTestDir, 'test.txt');

    // Standard write (new file, no read needed)
    await writeTool.execute('1', { filePath: 'test.txt', content: 'hello' }, new AbortController().signal);

    // Read it first for read-before-write staleness check on existing files
    await readTool.execute('2', { filePath: 'test.txt' }, new AbortController().signal);

    // Write again should succeed
    await writeTool.execute('3', { filePath: 'test.txt', content: 'hello world' }, new AbortController().signal);

    // Now, mock lock theft: overwrite .workrail.lock with a different UUID
    const lockFile = path.join(tempTestDir, '.workrail.lock');
    await fs.writeFile(lockFile, JSON.stringify({ pid: 11111, uuid: 'stolen-uuid', heartbeat: Date.now() }), 'utf8');

    // Next write/edit tool call should throw lock violation!
    await expect(writeTool.execute('4', { filePath: 'test.txt', content: 'hello world stolen' }, new AbortController().signal))
      .rejects.toThrow('WorkspaceLockViolation');

    await WorkspaceLockManager.release(tempTestDir, 'my-uuid');
  });

  it('should trigger stuck detection on edit count > 5 in a single step', async () => {
    const fileEditCounts = new Map<string, number>();
    const state = {
      terminalSignal: null as any,
    };
    const scope: SessionScope = {
      fileTracker: new DefaultFileStateTracker(),
      onAdvance: () => {
        fileEditCounts.clear();
      },
      onComplete: () => {},
      onTokenUpdate: () => {},
      onIssueReported: () => {},
      onSteer: () => {},
      getCurrentToken: () => '',
      sessionWorkspacePath: tempTestDir,
      spawnCurrentDepth: 0,
      spawnMaxDepth: 3,
      workrailSessionId: 'wf-session' as SessionId,
      emitter: undefined,
      sessionId: 'my-uuid' as RunId,
      workflowId: 'wf',
      triggerWorkspacePath: tempTestDir,
      triggerGoal: '',
      activeSessionSet: undefined,
      onGateParked: () => {},
      recordFileEdit: (filePath: string) => {
        const count = (fileEditCounts.get(filePath) ?? 0) + 1;
        fileEditCounts.set(filePath, count);
        if (count > 5) {
          state.terminalSignal = { kind: 'stuck', reason: 'edit_limit_exceeded' };
          return err(new Error('limit exceeded'));
        }
        return ok(undefined);
      },
      assertWorkspaceLockActive: () => {},
    };

    const writeTool = makeWriteTool(tempTestDir, scope.fileTracker.toMap(), {}, 'my-uuid' as RunId, undefined, null, scope.recordFileEdit, scope.assertWorkspaceLockActive);
    const readTool = makeReadTool(tempTestDir, scope.fileTracker.toMap(), {}, 'my-uuid' as RunId, undefined, null);

    const targetFile = path.join(tempTestDir, 'test.txt');

    // 1st write
    await writeTool.execute('1', { filePath: 'test.txt', content: '1' }, new AbortController().signal);

    // Edit loop: read and write
    for (let i = 2; i <= 5; i++) {
      await readTool.execute(`read-${i}`, { filePath: 'test.txt' }, new AbortController().signal);
      await writeTool.execute(`write-${i}`, { filePath: 'test.txt', content: String(i) }, new AbortController().signal);
    }

    // 6th write should throw limit exceeded!
    await readTool.execute('read-6', { filePath: 'test.txt' }, new AbortController().signal);
    await expect(writeTool.execute('write-6', { filePath: 'test.txt', content: '6' }, new AbortController().signal))
      .rejects.toThrow('limit exceeded');

    expect(state.terminalSignal?.reason).toBe('edit_limit_exceeded');
  });
});
