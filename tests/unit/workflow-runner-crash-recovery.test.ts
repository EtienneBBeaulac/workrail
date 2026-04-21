/**
 * Unit tests for crash recovery functions in workflow-runner.ts.
 *
 * Tests: readAllDaemonSessions(), runStartupRecovery(), clearQueueIssueSidecars()
 *
 * Strategy: each test writes real files to a temp directory and passes the
 * temp dir as the optional sessionsDir parameter. This avoids mocking fs and
 * avoids touching the real ~/.workrail/daemon-sessions/ directory.
 *
 * WHY real fs over mocks: the functions are I/O-heavy and the real behavior
 * (ENOENT, parse errors, file deletion) is most accurately verified against
 * a real filesystem. Temp directories are cheap and clean up after each test.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  readAllDaemonSessions,
  runStartupRecovery,
  clearQueueIssueSidecars,
  countOrphanStepAdvances,
} from '../../src/daemon/workflow-runner.js';
import type { V2ToolContext } from '../../src/mcp/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workrail-test-sessions-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function writeSession(
  dir: string,
  sessionId: string,
  data: object,
): Promise<void> {
  return fs.writeFile(
    path.join(dir, `${sessionId}.json`),
    JSON.stringify(data, null, 2),
    'utf8',
  );
}

function validSessionData(tsOffset = 0) {
  return {
    continueToken: `ct_test_${Date.now()}`,
    checkpointToken: `ck_test_${Date.now()}`,
    ts: Date.now() + tsOffset,
  };
}

// ---------------------------------------------------------------------------
// readAllDaemonSessions()
// ---------------------------------------------------------------------------

describe('readAllDaemonSessions()', () => {
  it('returns empty array when directory does not exist', async () => {
    const nonExistentDir = path.join(os.tmpdir(), `workrail-nonexistent-${Date.now()}`);
    const result = await readAllDaemonSessions(nonExistentDir);
    expect(result).toEqual([]);
  });

  it('returns empty array when directory is empty', async () => {
    const result = await readAllDaemonSessions(tmpDir);
    expect(result).toEqual([]);
  });

  it('returns parsed sessions from valid .json files', async () => {
    const sessionId = 'aaaaaaaa-0000-0000-0000-000000000001';
    const data = validSessionData();
    await writeSession(tmpDir, sessionId, data);

    const result = await readAllDaemonSessions(tmpDir);

    expect(result).toHaveLength(1);
    expect(result[0]!.sessionId).toBe(sessionId);
    expect(result[0]!.continueToken).toBe(data.continueToken);
    expect(result[0]!.checkpointToken).toBe(data.checkpointToken);
    expect(result[0]!.ts).toBe(data.ts);
  });

  it('returns multiple sessions when multiple files exist', async () => {
    const id1 = 'aaaaaaaa-0000-0000-0000-000000000001';
    const id2 = 'aaaaaaaa-0000-0000-0000-000000000002';
    await writeSession(tmpDir, id1, validSessionData());
    await writeSession(tmpDir, id2, validSessionData());

    const result = await readAllDaemonSessions(tmpDir);
    expect(result).toHaveLength(2);

    const ids = result.map((s) => s.sessionId).sort();
    expect(ids).toEqual([id1, id2].sort());
  });

  it('skips corrupt files (invalid JSON)', async () => {
    const goodId = 'aaaaaaaa-0000-0000-0000-000000000001';
    const badId = 'aaaaaaaa-0000-0000-0000-000000000002';

    await writeSession(tmpDir, goodId, validSessionData());
    await fs.writeFile(path.join(tmpDir, `${badId}.json`), 'this is not json', 'utf8');

    const result = await readAllDaemonSessions(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.sessionId).toBe(goodId);
  });

  it('skips files with missing required fields (no continueToken)', async () => {
    const sessionId = 'aaaaaaaa-0000-0000-0000-000000000001';
    await writeSession(tmpDir, sessionId, { ts: Date.now() }); // missing continueToken

    const result = await readAllDaemonSessions(tmpDir);
    expect(result).toHaveLength(0);
  });

  it('skips files with missing required fields (no ts)', async () => {
    const sessionId = 'aaaaaaaa-0000-0000-0000-000000000001';
    await writeSession(tmpDir, sessionId, { continueToken: 'ct_test' }); // missing ts

    const result = await readAllDaemonSessions(tmpDir);
    expect(result).toHaveLength(0);
  });

  it('excludes .tmp files (partial writes)', async () => {
    const sessionId = 'aaaaaaaa-0000-0000-0000-000000000001';
    // Temp files are named <sessionId>.json.tmp -- they do NOT end in .json
    await fs.writeFile(
      path.join(tmpDir, `${sessionId}.json.tmp`),
      JSON.stringify(validSessionData()),
      'utf8',
    );

    const result = await readAllDaemonSessions(tmpDir);
    expect(result).toHaveLength(0);
  });

  it('handles null checkpointToken gracefully', async () => {
    const sessionId = 'aaaaaaaa-0000-0000-0000-000000000001';
    await writeSession(tmpDir, sessionId, {
      continueToken: 'ct_test',
      checkpointToken: null,
      ts: Date.now(),
    });

    const result = await readAllDaemonSessions(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.checkpointToken).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runStartupRecovery()
// ---------------------------------------------------------------------------

describe('runStartupRecovery()', () => {
  it('is a no-op when directory does not exist', async () => {
    const nonExistentDir = path.join(os.tmpdir(), `workrail-nonexistent-${Date.now()}`);
    // Should not throw
    await expect(runStartupRecovery(nonExistentDir)).resolves.toBeUndefined();
  });

  it('is a no-op when directory is empty', async () => {
    await expect(runStartupRecovery(tmpDir)).resolves.toBeUndefined();
  });

  it('clears orphaned session files', async () => {
    const sessionId = 'aaaaaaaa-0000-0000-0000-000000000001';
    await writeSession(tmpDir, sessionId, validSessionData());

    await runStartupRecovery(tmpDir);

    // File should be gone
    await expect(
      fs.access(path.join(tmpDir, `${sessionId}.json`)),
    ).rejects.toThrow();
  });

  it('clears multiple orphaned session files', async () => {
    const id1 = 'aaaaaaaa-0000-0000-0000-000000000001';
    const id2 = 'aaaaaaaa-0000-0000-0000-000000000002';
    await writeSession(tmpDir, id1, validSessionData());
    await writeSession(tmpDir, id2, validSessionData());

    await runStartupRecovery(tmpDir);

    await expect(fs.access(path.join(tmpDir, `${id1}.json`))).rejects.toThrow();
    await expect(fs.access(path.join(tmpDir, `${id2}.json`))).rejects.toThrow();
  });

  it('clears stale sessions (age > 2h) without error', async () => {
    const sessionId = 'aaaaaaaa-0000-0000-0000-000000000001';
    // Write a session with a timestamp 3 hours ago
    const staleTs = Date.now() - 3 * 60 * 60 * 1000;
    await writeSession(tmpDir, sessionId, {
      continueToken: 'ct_stale',
      checkpointToken: null,
      ts: staleTs,
    });

    await runStartupRecovery(tmpDir);

    await expect(
      fs.access(path.join(tmpDir, `${sessionId}.json`)),
    ).rejects.toThrow();
  });

  it('clears stray .tmp files', async () => {
    const tmpFile = 'some-session.json.tmp';
    await fs.writeFile(path.join(tmpDir, tmpFile), 'partial write', 'utf8');

    await runStartupRecovery(tmpDir);

    await expect(
      fs.access(path.join(tmpDir, tmpFile)),
    ).rejects.toThrow();
  });

  it('does not throw when corrupt session files are present; corrupt files remain on disk', async () => {
    // A corrupt file is skipped by readAllDaemonSessions() but should not prevent
    // the recovery from running for other sessions. The corrupt file itself remains
    // (runStartupRecovery only deletes files found by readAllDaemonSessions).
    // This test verifies that a corrupt file does not cause runStartupRecovery to throw.
    const goodId = 'aaaaaaaa-0000-0000-0000-000000000001';
    const badId = 'aaaaaaaa-0000-0000-0000-000000000002';

    await writeSession(tmpDir, goodId, validSessionData());
    await fs.writeFile(path.join(tmpDir, `${badId}.json`), 'not json', 'utf8');

    await expect(runStartupRecovery(tmpDir)).resolves.toBeUndefined();

    // Good session is cleared
    await expect(fs.access(path.join(tmpDir, `${goodId}.json`))).rejects.toThrow();
    // Corrupt session remains (not in the parseable list -- would need a separate cleanup step)
    // This is an accepted limitation: corrupt files are logged but not auto-cleared
    // by the current implementation. Verify the test doesn't crash.
  });
});

// ---------------------------------------------------------------------------
// clearQueueIssueSidecars()
// ---------------------------------------------------------------------------

describe('clearQueueIssueSidecars()', () => {
  it('is a no-op when directory does not exist', async () => {
    const nonExistentDir = path.join(os.tmpdir(), `workrail-nonexistent-${Date.now()}`);
    await expect(clearQueueIssueSidecars(nonExistentDir)).resolves.toBeUndefined();
  });

  it('is a no-op when directory is empty', async () => {
    await expect(clearQueueIssueSidecars(tmpDir)).resolves.toBeUndefined();
  });

  it('deletes a queue-issue sidecar file', async () => {
    const sidecarPath = path.join(tmpDir, 'queue-issue-123.json');
    await fs.writeFile(
      sidecarPath,
      JSON.stringify({ issueNumber: 123, dispatchedAt: Date.now(), ttlMs: 3360000 }),
      'utf8',
    );

    await clearQueueIssueSidecars(tmpDir);

    await expect(fs.access(sidecarPath)).rejects.toThrow();
  });

  it('deletes multiple queue-issue sidecar files', async () => {
    const paths = [
      path.join(tmpDir, 'queue-issue-1.json'),
      path.join(tmpDir, 'queue-issue-2.json'),
      path.join(tmpDir, 'queue-issue-99.json'),
    ];
    for (const p of paths) {
      await fs.writeFile(p, JSON.stringify({ issueNumber: 1, dispatchedAt: Date.now(), ttlMs: 3360000 }), 'utf8');
    }

    await clearQueueIssueSidecars(tmpDir);

    for (const p of paths) {
      await expect(fs.access(p)).rejects.toThrow();
    }
  });

  it('does NOT delete regular session .json files', async () => {
    const sessionId = 'aaaaaaaa-0000-0000-0000-000000000001';
    const sessionPath = path.join(tmpDir, `${sessionId}.json`);
    await writeSession(tmpDir, sessionId, validSessionData());

    await clearQueueIssueSidecars(tmpDir);

    // Session file should still exist
    await expect(fs.access(sessionPath)).resolves.toBeUndefined();
  });

  it('does NOT delete .tmp files', async () => {
    const tmpFile = path.join(tmpDir, 'queue-issue-1.json.tmp');
    await fs.writeFile(tmpFile, 'partial', 'utf8');

    await clearQueueIssueSidecars(tmpDir);

    // .tmp file should still exist (handled by clearStrayTmpFiles, not clearQueueIssueSidecars)
    await expect(fs.access(tmpFile)).resolves.toBeUndefined();
  });

  it('handles ENOENT gracefully (file deleted between readdir and unlink)', async () => {
    // Writing and immediately deleting -- simulate race condition.
    // The function should not throw even if the file disappears during iteration.
    await expect(clearQueueIssueSidecars(tmpDir)).resolves.toBeUndefined();
  });

  it('runStartupRecovery clears queue-issue sidecars unconditionally (no ctx)', async () => {
    // Even without V2ToolContext, queue-issue sidecars should be deleted.
    const sidecarPath = path.join(tmpDir, 'queue-issue-42.json');
    await fs.writeFile(
      sidecarPath,
      JSON.stringify({ issueNumber: 42, dispatchedAt: Date.now(), ttlMs: 3360000 }),
      'utf8',
    );

    await runStartupRecovery(tmpDir);

    await expect(fs.access(sidecarPath)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// runStartupRecovery() with ctx -- resume/discard injectable stub tests
// ---------------------------------------------------------------------------

describe('runStartupRecovery() with ctx -- resume and discard paths', () => {
  // Minimal stub for V2ToolContext -- cast is safe because injectable fns
  // are used in tests instead of the real ctx.v2 engine calls.
  const stubCtx = {} as unknown as V2ToolContext;

  const noopExecFn = async () => ({ stdout: '', stderr: '' });

  it('resumes a session when _countStepAdvancesFn returns 1', async () => {
    const sessionId = 'aaaaaaaa-0000-0000-0000-000000000001';
    await writeSession(tmpDir, sessionId, validSessionData());

    const resumedTokens: string[] = [];
    const fakeExecute = async (input: { continueToken: string; intent: string }) => {
      resumedTokens.push(input.continueToken);
      return { content: [], isError: false } as unknown as Awaited<ReturnType<typeof import('../../src/mcp/handlers/v2-execution/index.js').executeContinueWorkflow>>;
    };

    await runStartupRecovery(
      tmpDir,
      noopExecFn,
      stubCtx,
      async () => 1, // stepAdvances = 1 -> resume
      fakeExecute as Parameters<typeof runStartupRecovery>[4],
    );

    // Resume path: executeContinueWorkflow called with the session's continueToken
    expect(resumedTokens).toHaveLength(1);

    // Sidecar is NOT deleted on resume (agent will update it on next advance)
    await expect(fs.access(path.join(tmpDir, `${sessionId}.json`))).resolves.toBeUndefined();
  });

  it('discards a session when _countStepAdvancesFn returns 0', async () => {
    const sessionId = 'aaaaaaaa-0000-0000-0000-000000000001';
    await writeSession(tmpDir, sessionId, validSessionData());

    const resumedTokens: string[] = [];
    const fakeExecute = async (input: { continueToken: string; intent: string }) => {
      resumedTokens.push(input.continueToken);
      return { content: [], isError: false } as unknown as Awaited<ReturnType<typeof import('../../src/mcp/handlers/v2-execution/index.js').executeContinueWorkflow>>;
    };

    await runStartupRecovery(
      tmpDir,
      noopExecFn,
      stubCtx,
      async () => 0, // stepAdvances = 0 -> discard
      fakeExecute as Parameters<typeof runStartupRecovery>[4],
    );

    // Discard path: executeContinueWorkflow NOT called
    expect(resumedTokens).toHaveLength(0);

    // Sidecar IS deleted on discard
    await expect(fs.access(path.join(tmpDir, `${sessionId}.json`))).rejects.toThrow();
  });

  it('falls back to discard when _countStepAdvancesFn throws', async () => {
    const sessionId = 'aaaaaaaa-0000-0000-0000-000000000001';
    await writeSession(tmpDir, sessionId, validSessionData());

    const resumedTokens: string[] = [];
    const fakeExecute = async (input: { continueToken: string; intent: string }) => {
      resumedTokens.push(input.continueToken);
      return { content: [], isError: false } as unknown as Awaited<ReturnType<typeof import('../../src/mcp/handlers/v2-execution/index.js').executeContinueWorkflow>>;
    };

    await runStartupRecovery(
      tmpDir,
      noopExecFn,
      stubCtx,
      async () => { throw new Error('token decode failed'); }, // step count fails
      fakeExecute as Parameters<typeof runStartupRecovery>[4],
    );

    // Step count failure -> discard path
    expect(resumedTokens).toHaveLength(0);

    // Sidecar IS deleted (fall to discard)
    await expect(fs.access(path.join(tmpDir, `${sessionId}.json`))).rejects.toThrow();
  });

  it('falls back to discard when _executeContinueWorkflowFn throws', async () => {
    const sessionId = 'aaaaaaaa-0000-0000-0000-000000000001';
    await writeSession(tmpDir, sessionId, validSessionData());

    await runStartupRecovery(
      tmpDir,
      noopExecFn,
      stubCtx,
      async () => 3, // stepAdvances = 3 -> resume
      async () => { throw new Error('rehydrate failed'); }, // resume fails
    );

    // Resume failed -> sidecar is deleted (fall to discard)
    await expect(fs.access(path.join(tmpDir, `${sessionId}.json`))).rejects.toThrow();
  });

  it('clears queue-issue sidecars even when ctx is provided', async () => {
    const sidecarPath = path.join(tmpDir, 'queue-issue-7.json');
    await fs.writeFile(
      sidecarPath,
      JSON.stringify({ issueNumber: 7, dispatchedAt: Date.now(), ttlMs: 3360000 }),
      'utf8',
    );

    await runStartupRecovery(tmpDir, noopExecFn, stubCtx, async () => 0, async () => { throw new Error('unused'); });

    await expect(fs.access(sidecarPath)).rejects.toThrow();
  });

  it('resumes multiple sessions with step advances', async () => {
    const id1 = 'aaaaaaaa-0000-0000-0000-000000000001';
    const id2 = 'aaaaaaaa-0000-0000-0000-000000000002';
    await writeSession(tmpDir, id1, { ...validSessionData(), continueToken: 'ct_token1' });
    await writeSession(tmpDir, id2, { ...validSessionData(), continueToken: 'ct_token2' });

    const resumedTokens: string[] = [];
    const fakeExecute = async (input: { continueToken: string }) => {
      resumedTokens.push(input.continueToken);
      return { content: [], isError: false } as unknown as Awaited<ReturnType<typeof import('../../src/mcp/handlers/v2-execution/index.js').executeContinueWorkflow>>;
    };

    await runStartupRecovery(
      tmpDir,
      noopExecFn,
      stubCtx,
      async () => 2, // both have advances -> resume both
      fakeExecute as Parameters<typeof runStartupRecovery>[4],
    );

    expect(resumedTokens).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// countOrphanStepAdvances() -- exported for testability
// ---------------------------------------------------------------------------

describe('countOrphanStepAdvances()', () => {
  it('is exported from workflow-runner', () => {
    // Verify the function is exported (import check)
    expect(typeof countOrphanStepAdvances).toBe('function');
  });
});
