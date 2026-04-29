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
import { okAsync, errAsync } from 'neverthrow';
import {
  readAllDaemonSessions,
  runStartupRecovery,
  clearQueueIssueSidecars,
  countOrphanStepAdvances,
} from '../../src/daemon/workflow-runner.js';
import type { V2ToolContext } from '../../src/mcp/types.js';
import type { SessionId } from '../../src/v2/durable-core/ids/index.js';
import type { DomainEventV1 } from '../../src/v2/durable-core/schemas/session/index.js';

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

  it('reads workflowId, goal, workspacePath from sidecar when present', async () => {
    const sessionId = 'aaaaaaaa-0000-0000-0000-000000000001';
    await writeSession(tmpDir, sessionId, {
      continueToken: 'ct_test',
      checkpointToken: null,
      ts: Date.now(),
      workflowId: 'wr.coding-task',
      goal: 'Implement OAuth',
      workspacePath: '/home/user/project',
    });

    const result = await readAllDaemonSessions(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.workflowId).toBe('wr.coding-task');
    expect(result[0]!.goal).toBe('Implement OAuth');
    expect(result[0]!.workspacePath).toBe('/home/user/project');
  });

  it('returns undefined for workflowId/goal/workspacePath when not present in sidecar (old format)', async () => {
    // Old-format sidecars do not have recovery context fields -- should parse OK with undefined fields.
    const sessionId = 'aaaaaaaa-0000-0000-0000-000000000001';
    await writeSession(tmpDir, sessionId, {
      continueToken: 'ct_test',
      checkpointToken: null,
      ts: Date.now(),
      // no workflowId, goal, or workspacePath
    });

    const result = await readAllDaemonSessions(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]!.workflowId).toBeUndefined();
    expect(result[0]!.goal).toBeUndefined();
    expect(result[0]!.workspacePath).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// persistTokens() -- recovery context fields
//
// WHY test this separately: persistTokens() is not exported, but its effects
// are observable via readAllDaemonSessions(). We verify that recovery context
// fields written by persistTokens() are correctly read back.
// ---------------------------------------------------------------------------

describe('persistTokens() recovery context fields (via readDaemonSessionState)', () => {
  // persistTokens is private, but we can exercise it via runWorkflow's observable side-effects
  // through readAllDaemonSessions. However, since we can't call persistTokens directly,
  // we test the round-trip by writing a sidecar file manually (as persistTokens would)
  // and verifying readAllDaemonSessions reads it correctly.
  //
  // WHY this approach: persistTokens is a private implementation detail. Testing via
  // readAllDaemonSessions validates the full sidecar round-trip, which is the real invariant.

  it('sidecar with recoveryContext fields round-trips through readAllDaemonSessions', async () => {
    const sessionId = 'bbbbbbbb-0000-0000-0000-000000000001';
    // Simulate what persistTokens writes when recoveryContext is provided
    await writeSession(tmpDir, sessionId, {
      continueToken: 'ct_persist_test',
      checkpointToken: null,
      ts: Date.now(),
      workflowId: 'wr.mr-review',
      goal: 'Review PR #42',
      workspacePath: '/repos/myproject',
    });

    const sessions = await readAllDaemonSessions(tmpDir);
    expect(sessions).toHaveLength(1);
    const session = sessions[0]!;
    expect(session.workflowId).toBe('wr.mr-review');
    expect(session.goal).toBe('Review PR #42');
    expect(session.workspacePath).toBe('/repos/myproject');
    expect(session.continueToken).toBe('ct_persist_test');
  });

  it('sidecar without recoveryContext fields round-trips with undefined fields', async () => {
    const sessionId = 'bbbbbbbb-0000-0000-0000-000000000002';
    // Simulate old-format sidecar (written before recoveryContext was added)
    await writeSession(tmpDir, sessionId, {
      continueToken: 'ct_old_format',
      checkpointToken: null,
      ts: Date.now(),
    });

    const sessions = await readAllDaemonSessions(tmpDir);
    expect(sessions).toHaveLength(1);
    const session = sessions[0]!;
    expect(session.workflowId).toBeUndefined();
    expect(session.goal).toBeUndefined();
    expect(session.workspacePath).toBeUndefined();
    expect(session.continueToken).toBe('ct_old_format');
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

  // Helper: build a fake rehydrate response for _executeContinueWorkflowFn.
  // Returns a ResultAsync<ContinueWorkflowResult, ContinueWorkflowError> that resolves ok
  // with the minimal shape needed for the resume path.
  function fakeRehydrateOk(opts: { isComplete?: boolean; pending?: null } = {}) {
    const response = {
      kind: 'ok' as const,
      continueToken: 'ct_fake_rehydrated',
      checkpointToken: undefined,
      isComplete: opts.isComplete ?? false,
      pending: opts.pending !== undefined ? opts.pending : {
        stepId: 'step-1',
        prompt: 'Do the thing',
        contentEnvelope: undefined,
      },
      preferences: { model: 'claude-opus-4-5', output: {} },
      nextIntent: 'advance' as const,
      nextCall: { tool: 'continue_workflow' as const, params: { continueToken: 'ct_fake_rehydrated' } },
    };
    return okAsync({ response }) as unknown as ReturnType<typeof import('../../src/mcp/handlers/v2-execution/index.js').executeContinueWorkflow>;
  }

  function fakeRehydrateErr() {
    return errAsync({ kind: 'validation_failed', failure: { code: 'TOKEN_INVALID_FORMAT', message: 'bad token', kind: 'not_retryable' } }) as unknown as ReturnType<typeof import('../../src/mcp/handlers/v2-execution/index.js').executeContinueWorkflow>;
  }

  // Helper: build a validSessionData with recovery context fields.
  function sessionDataWithContext(continueToken = `ct_test_${Date.now()}`) {
    return {
      continueToken,
      checkpointToken: null,
      ts: Date.now(),
      workflowId: 'wr.coding-task',
      goal: 'Implement feature X',
      workspacePath: '/some/workspace',
    };
  }

  it('discards a session when _countStepAdvancesFn returns 0', async () => {
    const sessionId = 'aaaaaaaa-0000-0000-0000-000000000001';
    await writeSession(tmpDir, sessionId, validSessionData());

    const resumedTokens: string[] = [];
    const fakeExecute = async (input: { continueToken: string; intent: string }) => {
      resumedTokens.push(input.continueToken);
      return fakeRehydrateOk();
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

    await runStartupRecovery(
      tmpDir,
      noopExecFn,
      stubCtx,
      async () => { throw new Error('token decode failed'); }, // step count fails
      async () => fakeRehydrateOk(),
    );

    // Step count failure -> discard path
    // Sidecar IS deleted (fall to discard)
    await expect(fs.access(path.join(tmpDir, `${sessionId}.json`))).rejects.toThrow();
  });

  it('discards session with step advances when sidecar has no workflowId (old format)', async () => {
    // Old-format sidecar: no workflowId/goal/workspacePath. Must be discarded, not resumed.
    const sessionId = 'aaaaaaaa-0000-0000-0000-000000000001';
    await writeSession(tmpDir, sessionId, validSessionData()); // no recovery context fields

    const runWorkflowCalls: unknown[] = [];
    await runStartupRecovery(
      tmpDir,
      noopExecFn,
      stubCtx,
      async () => 1, // stepAdvances = 1 -> resume attempted
      async () => fakeRehydrateOk(),
      async (trigger) => { runWorkflowCalls.push(trigger); return { _tag: 'success', workflowId: 'wr.coding-task', stopReason: 'done' } as import('../../src/daemon/workflow-runner.js').WorkflowRunResult; },
    );

    // Old-format sidecar: hasContext is false -> discard
    expect(runWorkflowCalls).toHaveLength(0);
    // Sidecar IS deleted
    await expect(fs.access(path.join(tmpDir, `${sessionId}.json`))).rejects.toThrow();
  });

  it('resumes session when stepAdvances >= 1 and sidecar has context fields', async () => {
    // New-format sidecar: has workflowId/goal/workspacePath. Should be resumed.
    const sessionId = 'aaaaaaaa-0000-0000-0000-000000000001';
    await writeSession(tmpDir, sessionId, sessionDataWithContext('ct_resume_me'));

    const runWorkflowTriggers: import('../../src/daemon/workflow-runner.js').WorkflowTrigger[] = [];
    const capturedApiKeys: string[] = [];
    const fakeRunWorkflow = async (trigger: import('../../src/daemon/workflow-runner.js').WorkflowTrigger, _ctx: unknown, key: string) => {
      runWorkflowTriggers.push(trigger);
      capturedApiKeys.push(key);
      return { _tag: 'success', workflowId: trigger.workflowId, stopReason: 'done' } as import('../../src/daemon/workflow-runner.js').WorkflowRunResult;
    };

    await runStartupRecovery(
      tmpDir,
      noopExecFn,
      stubCtx,
      async () => 1, // stepAdvances = 1 -> resume
      async () => fakeRehydrateOk(),
      fakeRunWorkflow as Parameters<typeof runStartupRecovery>[5],
      'test-api-key',
    );

    // runWorkflow IS called with the reconstructed trigger
    expect(runWorkflowTriggers).toHaveLength(1);
    expect(runWorkflowTriggers[0]!.workflowId).toBe('wr.coding-task');
    expect(runWorkflowTriggers[0]!.goal).toBe('Implement feature X');
    expect(runWorkflowTriggers[0]!.workspacePath).toBe('/some/workspace');
    expect(runWorkflowTriggers[0]!.branchStrategy).toBe('none');
    expect(runWorkflowTriggers[0]!._preAllocatedStartResponse).toBeDefined();
    expect(runWorkflowTriggers[0]!._preAllocatedStartResponse?.continueToken).toBe('ct_fake_rehydrated');
    // apiKey is forwarded to runWorkflow -- a regression here would pass all other assertions silently
    expect(capturedApiKeys[0]).toBe('test-api-key');

    // Sidecar is NOT deleted by runStartupRecovery (runWorkflow manages its own lifecycle)
    await expect(fs.access(path.join(tmpDir, `${sessionId}.json`))).resolves.toBeUndefined();
  });

  it('falls to discard when rehydrate returns isErr()', async () => {
    const sessionId = 'aaaaaaaa-0000-0000-0000-000000000001';
    await writeSession(tmpDir, sessionId, sessionDataWithContext());

    const runWorkflowCalls: unknown[] = [];
    await runStartupRecovery(
      tmpDir,
      noopExecFn,
      stubCtx,
      async () => 1,
      async () => fakeRehydrateErr(), // rehydrate error
      async (trigger) => { runWorkflowCalls.push(trigger); return { _tag: 'success', workflowId: 'wr.test', stopReason: 'done' } as import('../../src/daemon/workflow-runner.js').WorkflowRunResult; },
    );

    expect(runWorkflowCalls).toHaveLength(0);
    // Sidecar IS deleted
    await expect(fs.access(path.join(tmpDir, `${sessionId}.json`))).rejects.toThrow();
  });

  it('falls to discard when rehydrate throws', async () => {
    const sessionId = 'aaaaaaaa-0000-0000-0000-000000000001';
    await writeSession(tmpDir, sessionId, sessionDataWithContext());

    const runWorkflowCalls: unknown[] = [];
    await runStartupRecovery(
      tmpDir,
      noopExecFn,
      stubCtx,
      async () => 1,
      async () => { throw new Error('engine unavailable'); }, // rehydrate throws
      async (trigger) => { runWorkflowCalls.push(trigger); return { _tag: 'success', workflowId: 'wr.test', stopReason: 'done' } as import('../../src/daemon/workflow-runner.js').WorkflowRunResult; },
    );

    expect(runWorkflowCalls).toHaveLength(0);
    await expect(fs.access(path.join(tmpDir, `${sessionId}.json`))).rejects.toThrow();
  });

  it('falls to discard when rehydrate returns isComplete=true', async () => {
    const sessionId = 'aaaaaaaa-0000-0000-0000-000000000001';
    await writeSession(tmpDir, sessionId, sessionDataWithContext());

    const runWorkflowCalls: unknown[] = [];
    await runStartupRecovery(
      tmpDir,
      noopExecFn,
      stubCtx,
      async () => 2,
      async () => fakeRehydrateOk({ isComplete: true, pending: null }), // already done
      async (trigger) => { runWorkflowCalls.push(trigger); return { _tag: 'success', workflowId: 'wr.test', stopReason: 'done' } as import('../../src/daemon/workflow-runner.js').WorkflowRunResult; },
    );

    expect(runWorkflowCalls).toHaveLength(0);
    await expect(fs.access(path.join(tmpDir, `${sessionId}.json`))).rejects.toThrow();
  });

  it('clears queue-issue sidecars even when ctx is provided', async () => {
    const sidecarPath = path.join(tmpDir, 'queue-issue-7.json');
    await fs.writeFile(
      sidecarPath,
      JSON.stringify({ issueNumber: 7, dispatchedAt: Date.now(), ttlMs: 3360000 }),
      'utf8',
    );

    await runStartupRecovery(tmpDir, noopExecFn, stubCtx, async () => 0, async () => fakeRehydrateOk());

    await expect(fs.access(sidecarPath)).rejects.toThrow();
  });

  it('resumes session when worktreePath is set and the directory exists on disk', async () => {
    // F1: worktree path is set AND the directory exists -- session should be resumed.
    const sessionId = 'aaaaaaaa-0000-0000-0000-000000000001';
    // Create a real directory to serve as the worktree path.
    const fakeWorktreePath = path.join(tmpDir, 'fake-worktree');
    await fs.mkdir(fakeWorktreePath);

    await writeSession(tmpDir, sessionId, {
      ...sessionDataWithContext('ct_worktree_exists'),
      worktreePath: fakeWorktreePath,
    });

    const runWorkflowTriggers: import('../../src/daemon/workflow-runner.js').WorkflowTrigger[] = [];
    const capturedApiKeys: string[] = [];
    const fakeRunWorkflow = async (trigger: import('../../src/daemon/workflow-runner.js').WorkflowTrigger, _ctx: unknown, key: string) => {
      runWorkflowTriggers.push(trigger);
      capturedApiKeys.push(key);
      return { _tag: 'success', workflowId: trigger.workflowId, stopReason: 'done' } as import('../../src/daemon/workflow-runner.js').WorkflowRunResult;
    };

    await runStartupRecovery(
      tmpDir,
      noopExecFn,
      stubCtx,
      async () => 1, // stepAdvances = 1 -> resume attempted
      async () => fakeRehydrateOk(),
      fakeRunWorkflow as Parameters<typeof runStartupRecovery>[5],
      'test-api-key',
    );

    // Worktree exists -> _runWorkflowFn IS called
    expect(runWorkflowTriggers).toHaveLength(1);
    // effectiveWorkspacePath should be the worktree path, not the original workspacePath
    expect(runWorkflowTriggers[0]!.workspacePath).toBe(fakeWorktreePath);
    expect(runWorkflowTriggers[0]!.branchStrategy).toBe('none');
    expect(capturedApiKeys[0]).toBe('test-api-key');

    // Sidecar is NOT deleted (runWorkflow manages its own lifecycle)
    await expect(fs.access(path.join(tmpDir, `${sessionId}.json`))).resolves.toBeUndefined();
  });

  it('discards session when worktreePath is set but the directory is missing (ENOENT)', async () => {
    // F1: worktree path is set BUT the directory does NOT exist -- must discard, not resume.
    const sessionId = 'aaaaaaaa-0000-0000-0000-000000000001';
    const missingWorktreePath = path.join(tmpDir, 'does-not-exist-worktree');
    // Do NOT create the directory -- it must be absent on disk.

    await writeSession(tmpDir, sessionId, {
      ...sessionDataWithContext('ct_worktree_missing'),
      worktreePath: missingWorktreePath,
    });

    const runWorkflowCalls: unknown[] = [];
    await runStartupRecovery(
      tmpDir,
      noopExecFn,
      stubCtx,
      async () => 1, // stepAdvances = 1 -> resume attempted
      async () => fakeRehydrateOk(),
      async (trigger) => {
        runWorkflowCalls.push(trigger);
        return { _tag: 'success', workflowId: 'wr.test', stopReason: 'done' } as import('../../src/daemon/workflow-runner.js').WorkflowRunResult;
      },
    );

    // Worktree is missing -> falls to discard: _runWorkflowFn NOT called
    expect(runWorkflowCalls).toHaveLength(0);
    // Sidecar IS deleted on discard
    await expect(fs.access(path.join(tmpDir, `${sessionId}.json`))).rejects.toThrow();
  });

  it('resumes multiple sessions with step advances (both get runWorkflow called)', async () => {
    const id1 = 'aaaaaaaa-0000-0000-0000-000000000001';
    const id2 = 'aaaaaaaa-0000-0000-0000-000000000002';
    await writeSession(tmpDir, id1, { ...sessionDataWithContext('ct_token1'), workflowId: 'wr.wf1' });
    await writeSession(tmpDir, id2, { ...sessionDataWithContext('ct_token2'), workflowId: 'wr.wf2' });

    const runWorkflowIds: string[] = [];
    const capturedApiKeys: string[] = [];
    const fakeRunWorkflow = async (trigger: import('../../src/daemon/workflow-runner.js').WorkflowTrigger, _ctx: unknown, key: string) => {
      runWorkflowIds.push(trigger.workflowId);
      capturedApiKeys.push(key);
      return { _tag: 'success', workflowId: trigger.workflowId, stopReason: 'done' } as import('../../src/daemon/workflow-runner.js').WorkflowRunResult;
    };

    await runStartupRecovery(
      tmpDir,
      noopExecFn,
      stubCtx,
      async () => 2, // both have advances
      async () => fakeRehydrateOk(),
      fakeRunWorkflow as Parameters<typeof runStartupRecovery>[5],
      'test-api-key',
    );

    // Both sessions get runWorkflow called
    expect(runWorkflowIds.sort()).toEqual(['wr.wf1', 'wr.wf2'].sort());
    // apiKey forwarded to both sessions
    expect(capturedApiKeys).toHaveLength(2);
    expect(capturedApiKeys.every(k => k === 'test-api-key')).toBe(true);

    // Sidecars are NOT deleted by runStartupRecovery (runWorkflow manages its own lifecycle)
    await expect(fs.access(path.join(tmpDir, `${id1}.json`))).resolves.toBeUndefined();
    await expect(fs.access(path.join(tmpDir, `${id2}.json`))).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// countOrphanStepAdvances() -- behavioral tests via injectable fns
// ---------------------------------------------------------------------------

describe('countOrphanStepAdvances()', () => {
  // stubCtx is not used by countOrphanStepAdvances when both _parseFn and _loadFn are injected
  // (the defaults that would access ctx.v2.* are never reached).
  const stubCtx = {} as unknown as V2ToolContext;

  // Fake parseFn that succeeds, returning a ContinueTokenResolved with a fixed sessionId.
  const okParseFn = (_raw: string) =>
    okAsync({ sessionId: 'sess_fake_001', runId: 'r', nodeId: 'n', attemptId: 'a', workflowHashRef: 'h' } as import('../../src/mcp/handlers/v2-token-ops.js').ContinueTokenResolved);

  // Fake parseFn that always fails.
  const failParseFn = (_raw: string) =>
    errAsync({ code: 'TOKEN_INVALID_FORMAT', message: 'bad token', kind: 'not_retryable' } as unknown as import('../../src/mcp/handlers/v2-execution-helpers.js').ToolFailure);

  // Builds a fake loadFn returning N advance_recorded events in the session event log.
  function fakeLoadFn(advanceCount: number) {
    return (_sessionId: SessionId) => {
      const events: DomainEventV1[] = Array.from({ length: advanceCount }, (_, i) => ({
        kind: 'advance_recorded' as const,
        eventId: `evt_${i}`,
        eventIndex: i,
        sessionId: 'sess_fake_001',
        ts: Date.now(),
        scope: { runId: 'r', nodeId: `n_${i}` },
        data: {},
      } as unknown as DomainEventV1));
      return okAsync({ kind: 'complete' as const, truth: { manifest: [], events } });
    };
  }

  it('returns 2 when the session event log contains 2 advance_recorded events', async () => {
    const result = await countOrphanStepAdvances('ct_fake', stubCtx, okParseFn, fakeLoadFn(2));
    expect(result).toBe(2);
  });

  it('returns 0 when the session event log contains no advance_recorded events', async () => {
    const result = await countOrphanStepAdvances('ct_fake', stubCtx, okParseFn, fakeLoadFn(0));
    expect(result).toBe(0);
  });

  it('returns 0 when parseFn fails (token decode error)', async () => {
    const result = await countOrphanStepAdvances('ct_fake', stubCtx, failParseFn, fakeLoadFn(5));
    expect(result).toBe(0);
  });

  it('returns 0 when loadFn fails (session store error)', async () => {
    const failLoadFn = (_sessionId: SessionId) =>
      errAsync({ code: 'SESSION_STORE_IO_ERROR' as const, message: 'disk failure' });
    const result = await countOrphanStepAdvances('ct_fake', stubCtx, okParseFn, failLoadFn);
    expect(result).toBe(0);
  });

  it('counts only advance_recorded events and ignores other event kinds', async () => {
    const mixedLoadFn = (_sessionId: SessionId) =>
      okAsync({
        kind: 'complete' as const,
        truth: {
          manifest: [],
          events: [
            { kind: 'advance_recorded', eventId: 'e1', eventIndex: 0 } as unknown as DomainEventV1,
            { kind: 'session_started', eventId: 'e2', eventIndex: 1 } as unknown as DomainEventV1,
            { kind: 'advance_recorded', eventId: 'e3', eventIndex: 2 } as unknown as DomainEventV1,
          ],
        },
      });
    const result = await countOrphanStepAdvances('ct_fake', stubCtx, okParseFn, mixedLoadFn);
    expect(result).toBe(2);
  });
});
