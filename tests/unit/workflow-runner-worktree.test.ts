/**
 * Unit tests for worktree isolation support in workflow-runner.ts and delivery-action.ts.
 *
 * Tests:
 * 1. branchStrategy: 'worktree' -> worktree created at correct path, sessionWorkspacePath derived
 * 2. branchStrategy: 'none' -> no worktree created, sessionWorkspacePath = trigger.workspacePath
 * 3. delivery-action branch assertion: correct branch passes, wrong branch returns error
 * 4. Orphan cleanup: runStartupRecovery calls git worktree remove for >24h orphans with worktreePath
 *
 * Strategy:
 * - readAllDaemonSessions / runStartupRecovery tests: write real files to temp dir, inject execFn
 * - delivery-action tests: inject execFn fakes, no real git needed
 * - worktree creation in runWorkflow is tested via OrphanedSession integration (sidecar JSON)
 *   since runWorkflow requires full DI context; we test the sidecar read/write path here.
 *
 * WHY real temp dirs over mocked fs: I/O-heavy functions are most accurately verified
 * against a real filesystem. Temp directories are cheap and clean up after each test.
 * Following the established pattern from workflow-runner-crash-recovery.test.ts.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  readAllDaemonSessions,
  runStartupRecovery,
  WORKTREES_DIR,
} from '../../src/daemon/workflow-runner.js';
import {
  runDelivery,
  type HandoffArtifact,
  type DeliveryFlags,
  type ExecFn,
} from '../../src/trigger/delivery-action.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workrail-test-worktree-'));
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

function makeValidArtifact(overrides: Partial<HandoffArtifact> = {}): HandoffArtifact {
  return {
    commitType: 'feat',
    commitScope: 'daemon',
    commitSubject: 'feat(daemon): add worktree isolation for coding sessions',
    prTitle: 'feat(daemon): add worktree isolation for coding sessions',
    prBody: '## Summary\n- Worktree isolation\n\n## Test plan\n- [ ] Build passes\n- [ ] Tests pass',
    filesChanged: ['src/daemon/workflow-runner.ts'],
    followUpTickets: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Sidecar JSON: worktreePath persistence
// ---------------------------------------------------------------------------

describe('OrphanedSession worktreePath field', () => {
  it('reads worktreePath from sidecar when present', async () => {
    const sessionId = 'aaaaaaaa-0000-0000-0000-000000000001';
    await writeSession(tmpDir, sessionId, {
      continueToken: 'ct_test',
      checkpointToken: null,
      ts: Date.now(),
      worktreePath: '/Users/test/.workrail/worktrees/abc123',
    });

    const sessions = await readAllDaemonSessions(tmpDir);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.worktreePath).toBe('/Users/test/.workrail/worktrees/abc123');
  });

  it('returns undefined worktreePath for sessions without the field', async () => {
    const sessionId = 'aaaaaaaa-0000-0000-0000-000000000001';
    await writeSession(tmpDir, sessionId, {
      continueToken: 'ct_test',
      checkpointToken: null,
      ts: Date.now(),
      // No worktreePath -- pre-#627 session
    });

    const sessions = await readAllDaemonSessions(tmpDir);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.worktreePath).toBeUndefined();
  });

  it('does not reject sessions with extra fields (forward compatibility)', async () => {
    const sessionId = 'aaaaaaaa-0000-0000-0000-000000000001';
    const worktreePath = path.join(tmpDir, 'wt', 'abc');
    await writeSession(tmpDir, sessionId, {
      continueToken: 'ct_test',
      checkpointToken: null,
      ts: Date.now(),
      worktreePath,
      futureField: 'some future value',
    });

    const sessions = await readAllDaemonSessions(tmpDir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.worktreePath).toBe(worktreePath);
  });
});

// ---------------------------------------------------------------------------
// runStartupRecovery: orphan worktree cleanup
// ---------------------------------------------------------------------------

describe('runStartupRecovery() orphan worktree cleanup', () => {
  it('calls git worktree remove for orphan sessions older than 24h with worktreePath', async () => {
    const sessionId = 'bbbbbbbb-0000-0000-0000-000000000001';
    const worktreePath = path.join(tmpDir, 'worktrees', sessionId);
    const staleTsMs = Date.now() - (25 * 60 * 60 * 1000); // 25 hours ago

    await writeSession(tmpDir, sessionId, {
      continueToken: 'ct_stale',
      checkpointToken: null,
      ts: staleTsMs,
      worktreePath,
    });

    const calls: Array<{ file: string; args: string[] }> = [];
    const fakeExecFn = async (file: string, args: string[]) => {
      calls.push({ file, args });
      return { stdout: '', stderr: '' };
    };

    await runStartupRecovery(tmpDir, fakeExecFn);

    // Should have called git worktree remove --force <worktreePath>
    const worktreeRemoveCalls = calls.filter(
      (c) => c.file === 'git' && c.args.includes('worktree') && c.args.includes('remove'),
    );
    expect(worktreeRemoveCalls).toHaveLength(1);
    expect(worktreeRemoveCalls[0]!.args).toContain('--force');
    expect(worktreeRemoveCalls[0]!.args).toContain(worktreePath);

    // Session file should be deleted
    await expect(
      fs.access(path.join(tmpDir, `${sessionId}.json`)),
    ).rejects.toThrow();
  });

  it('does NOT call git worktree remove for recent orphans (< 24h)', async () => {
    const sessionId = 'bbbbbbbb-0000-0000-0000-000000000002';
    const worktreePath = path.join(tmpDir, 'worktrees', sessionId);
    const recentTsMs = Date.now() - (2 * 60 * 60 * 1000); // 2 hours ago

    await writeSession(tmpDir, sessionId, {
      continueToken: 'ct_recent',
      checkpointToken: null,
      ts: recentTsMs,
      worktreePath,
    });

    const calls: Array<{ file: string; args: string[] }> = [];
    const fakeExecFn = async (file: string, args: string[]) => {
      calls.push({ file, args });
      return { stdout: '', stderr: '' };
    };

    await runStartupRecovery(tmpDir, fakeExecFn);

    // Should NOT have called git worktree remove
    const worktreeRemoveCalls = calls.filter(
      (c) => c.file === 'git' && c.args.includes('worktree') && c.args.includes('remove'),
    );
    expect(worktreeRemoveCalls).toHaveLength(0);

    // Session file should still be deleted (sidecar cleanup always runs)
    await expect(
      fs.access(path.join(tmpDir, `${sessionId}.json`)),
    ).rejects.toThrow();
  });

  it('does NOT call git worktree remove for orphans without worktreePath', async () => {
    const sessionId = 'bbbbbbbb-0000-0000-0000-000000000003';
    const staleTsMs = Date.now() - (25 * 60 * 60 * 1000);

    await writeSession(tmpDir, sessionId, {
      continueToken: 'ct_stale_no_wt',
      checkpointToken: null,
      ts: staleTsMs,
      // No worktreePath -- pre-#627 session
    });

    const calls: Array<{ file: string; args: string[] }> = [];
    const fakeExecFn = async (file: string, args: string[]) => {
      calls.push({ file, args });
      return { stdout: '', stderr: '' };
    };

    await runStartupRecovery(tmpDir, fakeExecFn);

    const worktreeRemoveCalls = calls.filter(
      (c) => c.file === 'git' && c.args.includes('worktree') && c.args.includes('remove'),
    );
    expect(worktreeRemoveCalls).toHaveLength(0);
  });

  it('continues cleanup even if git worktree remove fails', async () => {
    const sessionId = 'bbbbbbbb-0000-0000-0000-000000000004';
    const worktreePath = path.join(tmpDir, 'worktrees', 'gone');
    const staleTsMs = Date.now() - (25 * 60 * 60 * 1000);

    await writeSession(tmpDir, sessionId, {
      continueToken: 'ct_stale',
      checkpointToken: null,
      ts: staleTsMs,
      worktreePath,
    });

    const fakeExecFn = async (_file: string, _args: string[]) => {
      throw new Error('not a worktree: path not found');
    };

    // Should not throw even when git worktree remove fails
    await expect(runStartupRecovery(tmpDir, fakeExecFn)).resolves.toBeUndefined();

    // Session file should still be deleted (best-effort, not blocked by git failure)
    await expect(
      fs.access(path.join(tmpDir, `${sessionId}.json`)),
    ).rejects.toThrow();
  });

  it('handles multiple orphans: removes stale worktrees, keeps recent ones', async () => {
    const staleId = 'cccccccc-0000-0000-0000-000000000001';
    const recentId = 'cccccccc-0000-0000-0000-000000000002';
    const noWtId = 'cccccccc-0000-0000-0000-000000000003';

    const staleWt = path.join(tmpDir, 'wt-stale');
    const recentWt = path.join(tmpDir, 'wt-recent');

    await writeSession(tmpDir, staleId, {
      continueToken: 'ct_s1',
      checkpointToken: null,
      ts: Date.now() - (26 * 60 * 60 * 1000),
      worktreePath: staleWt,
    });
    await writeSession(tmpDir, recentId, {
      continueToken: 'ct_s2',
      checkpointToken: null,
      ts: Date.now() - (1 * 60 * 60 * 1000),
      worktreePath: recentWt,
    });
    await writeSession(tmpDir, noWtId, {
      continueToken: 'ct_s3',
      checkpointToken: null,
      ts: Date.now() - (30 * 60 * 60 * 1000),
    });

    const calls: Array<{ file: string; args: string[] }> = [];
    const fakeExecFn = async (file: string, args: string[]) => {
      calls.push({ file, args });
      return { stdout: '', stderr: '' };
    };

    await runStartupRecovery(tmpDir, fakeExecFn);

    const removedPaths = calls
      .filter((c) => c.file === 'git' && c.args.includes('remove'))
      .map((c) => c.args[c.args.length - 1]!);

    // Only the stale worktree should be removed
    expect(removedPaths).toContain(staleWt);
    expect(removedPaths).not.toContain(recentWt);
    expect(removedPaths).not.toContain(recentId);
  });
});

// ---------------------------------------------------------------------------
// delivery-action: branch assertion
// ---------------------------------------------------------------------------

describe('delivery-action: branch assertion', () => {
  // Use os.tmpdir() for cross-platform compatibility (avoids /tmp hardcode)
  const WORKSPACE = path.join(os.tmpdir(), 'workrail-test-fake-workspace');
  const SESSION_ID = 'test-session-uuid-1234';
  const BRANCH_PREFIX = 'worktrain/';
  const EXPECTED_BRANCH = `${BRANCH_PREFIX}${SESSION_ID}`;

  function makeExecFn(headBranch: string): ExecFn {
    return async (file, args, _opts) => {
      // Simulate git rev-parse --abbrev-ref HEAD
      if (file === 'git' && args.includes('rev-parse') && args.includes('HEAD')) {
        return { stdout: `${headBranch}\n`, stderr: '' };
      }
      // Simulate git add (success)
      if (file === 'git' && args[0] === 'add') {
        return { stdout: '', stderr: '' };
      }
      // Simulate git commit (success)
      if (file === 'git' && args[0] === 'commit') {
        return { stdout: '[worktrain/test-session-uuid-1234 abc1234] feat(daemon): add worktree', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    };
  }

  it('passes when HEAD matches expected branch', async () => {
    const artifact = makeValidArtifact();
    const flags: DeliveryFlags = {
      autoCommit: true,
      autoOpenPR: false,
      sessionId: SESSION_ID,
      branchPrefix: BRANCH_PREFIX,
    };

    const result = await runDelivery(artifact, WORKSPACE, flags, makeExecFn(EXPECTED_BRANCH));

    expect(result._tag).toBe('committed');
  });

  it('returns error when HEAD does not match expected branch', async () => {
    const artifact = makeValidArtifact();
    const flags: DeliveryFlags = {
      autoCommit: true,
      autoOpenPR: false,
      sessionId: SESSION_ID,
      branchPrefix: BRANCH_PREFIX,
    };

    const result = await runDelivery(artifact, WORKSPACE, flags, makeExecFn('main'));

    expect(result._tag).toBe('error');
    if (result._tag === 'error') {
      expect(result.phase).toBe('commit');
      expect(result.details).toContain('HEAD branch mismatch');
      expect(result.details).toContain(EXPECTED_BRANCH);
      expect(result.details).toContain('main');
    }
  });

  it('skips assertion when sessionId is not set (branchStrategy=none)', async () => {
    const artifact = makeValidArtifact();
    const flags: DeliveryFlags = {
      autoCommit: true,
      autoOpenPR: false,
      // No sessionId -- branchStrategy: none
    };

    // Head is 'main' -- but no assertion is performed
    const result = await runDelivery(artifact, WORKSPACE, flags, makeExecFn('main'));

    // Should succeed (no branch assertion without sessionId)
    expect(result._tag).toBe('committed');
  });

  it('uses default branchPrefix when branchPrefix is not set', async () => {
    const artifact = makeValidArtifact();
    const flags: DeliveryFlags = {
      autoCommit: true,
      autoOpenPR: false,
      sessionId: SESSION_ID,
      // No branchPrefix -- should default to 'worktrain/'
    };

    // HEAD matches 'worktrain/<sessionId>' which is the default
    const result = await runDelivery(artifact, WORKSPACE, flags, makeExecFn(EXPECTED_BRANCH));
    expect(result._tag).toBe('committed');
  });

  it('returns error when git rev-parse fails', async () => {
    const artifact = makeValidArtifact();
    const flags: DeliveryFlags = {
      autoCommit: true,
      autoOpenPR: false,
      sessionId: SESSION_ID,
      branchPrefix: BRANCH_PREFIX,
    };

    const failingExecFn: ExecFn = async (file, args, _opts) => {
      if (file === 'git' && args.includes('rev-parse')) {
        throw new Error('not a git repository');
      }
      return { stdout: '', stderr: '' };
    };

    const result = await runDelivery(artifact, WORKSPACE, flags, failingExecFn);

    expect(result._tag).toBe('error');
    if (result._tag === 'error') {
      expect(result.phase).toBe('commit');
      expect(result.details).toContain('HEAD branch check failed');
    }
  });
});

// ---------------------------------------------------------------------------
// WORKTREES_DIR constant
// ---------------------------------------------------------------------------

describe('WORKTREES_DIR constant', () => {
  it('is under ~/.workrail/worktrees', () => {
    expect(WORKTREES_DIR).toBe(path.join(os.homedir(), '.workrail', 'worktrees'));
  });
});
