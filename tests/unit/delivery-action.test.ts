/**
 * Tests for src/trigger/delivery-action.ts
 *
 * Covers:
 * - parseHandoffArtifact: JSON fenced block, line-scan fallback, missing fields, empty input
 * - runDelivery: disabled flags, empty filesChanged, commit-only, commit+PR, exec failures
 * - Attribution signals: [WT] prefix, commit trailers, PR body footer, label calls
 * - Per-command identity: -c user.name/email flags when botIdentity is set
 * - Regression: no git config calls on worktree when botIdentity is set
 *
 * All tests use an injected fake execFn -- no child_process mock.
 */

import { describe, expect, it, vi } from 'vitest';
import { parseHandoffArtifact, runDelivery } from '../../src/trigger/delivery-action.js';
import type { HandoffArtifact, DeliveryFlags, ExecFn } from '../../src/trigger/delivery-action.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeArtifact(overrides: Partial<HandoffArtifact> = {}): HandoffArtifact {
  return {
    commitType: 'feat',
    commitScope: 'mcp',
    commitSubject: 'feat(mcp): add auto-commit support',
    prTitle: 'feat(mcp): add auto-commit support',
    prBody: '## Summary\n- Added auto-commit\n\n## Test plan\n- [ ] Run tests',
    filesChanged: ['src/trigger/delivery-action.ts', 'tests/unit/delivery-action.test.ts'],
    followUpTickets: [],
    ...overrides,
  };
}

function makeFlags(overrides: Partial<DeliveryFlags> = {}): DeliveryFlags {
  // WHY secretScan: false default: existing tests focus on commit/PR behavior, not secret scan.
  // The secret scan requires a mocked git diff --cached call. Tests that specifically test
  // the secret scan feature set secretScan explicitly.
  return { autoCommit: false, autoOpenPR: false, secretScan: false, ...overrides };
}

/** Fake execFn that resolves successfully with empty output. */
function makeFakeExec(stdout = '', stderr = ''): ExecFn {
  return vi.fn().mockResolvedValue({ stdout, stderr });
}

/** Fake execFn that rejects with an exec-style error. */
function makeFailingExec(message: string, stdout = '', stderr = ''): ExecFn {
  const error = Object.assign(new Error(message), { stdout, stderr });
  return vi.fn().mockRejectedValue(error);
}

// ---------------------------------------------------------------------------
// parseHandoffArtifact tests
// ---------------------------------------------------------------------------

describe('parseHandoffArtifact', () => {
  describe('JSON fenced block', () => {
    it('parses a valid JSON block', () => {
      const notes = `
Some notes here.

\`\`\`json
{
  "commitType": "feat",
  "commitScope": "engine",
  "commitSubject": "feat(engine): add retry logic",
  "prTitle": "feat(engine): add retry logic",
  "prBody": "## Summary\\n- Added retry\\n\\n## Test plan\\n- [ ] Tests pass",
  "followUpTickets": ["JIRA-123"],
  "filesChanged": ["src/engine/retry.ts", "tests/unit/retry.test.ts"]
}
\`\`\`
`;
      const result = parseHandoffArtifact(notes);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.value.commitType).toBe('feat');
        expect(result.value.commitScope).toBe('engine');
        expect(result.value.filesChanged).toEqual(['src/engine/retry.ts', 'tests/unit/retry.test.ts']);
        expect(result.value.followUpTickets).toEqual(['JIRA-123']);
      }
    });

    it('returns err when all JSON blocks fail validation and line-scan finds nothing', () => {
      const notes = `
\`\`\`json
{
  "commitScope": "engine",
  "commitSubject": "feat(engine): add retry logic",
  "prTitle": "feat(engine): add retry logic",
  "prBody": "## Summary",
  "filesChanged": ["src/engine/retry.ts"]
}
\`\`\`
`;
      const result = parseHandoffArtifact(notes);
      expect(result.kind).toBe('err');
    });

    it('returns err when all JSON blocks have empty filesChanged and line-scan finds nothing', () => {
      const notes = `
\`\`\`json
{
  "commitType": "feat",
  "commitScope": "engine",
  "commitSubject": "feat(engine): add retry",
  "prTitle": "feat(engine): add retry",
  "prBody": "## Summary",
  "filesChanged": []
}
\`\`\`
`;
      const result = parseHandoffArtifact(notes);
      expect(result.kind).toBe('err');
    });

    it('falls through to line-scan if JSON is invalid and succeeds', () => {
      const notes = `
\`\`\`json
{ invalid json here
\`\`\`

- commitType: chore
- commitScope: docs
- commitSubject: chore(docs): update readme
- prTitle: chore(docs): update readme
- prBody: updated docs
- filesChanged: docs/README.md
`;
      const result = parseHandoffArtifact(notes);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.value.commitType).toBe('chore');
      }
    });

    it('tries second JSON block when first block is missing required fields', () => {
      const notes = `
\`\`\`json
{
  "someOtherKey": "not a handoff artifact"
}
\`\`\`

Some text in between.

\`\`\`json
{
  "commitType": "fix",
  "commitScope": "engine",
  "commitSubject": "fix(engine): correct retry logic",
  "prTitle": "fix(engine): correct retry logic",
  "prBody": "## Summary\\n- Fixed retry\\n\\n## Test plan\\n- [ ] Tests pass",
  "filesChanged": ["src/engine/retry.ts"]
}
\`\`\`
`;
      const result = parseHandoffArtifact(notes);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.value.commitType).toBe('fix');
        expect(result.value.filesChanged).toEqual(['src/engine/retry.ts']);
      }
    });
  });

  describe('line-scan fallback', () => {
    it('parses a bullet-list handoff (current fast-path prompt format)', () => {
      const notes = `
**4. Handoff note:**
- \`commitType\`: chore
- \`commitScope\`: mcp
- \`commitSubject\`: chore(mcp): update trigger config parsing
- \`prTitle\`: chore(mcp): update trigger config parsing
- \`prBody\`: ## Summary\\n- Updated parsing\\n\\n## Test plan\\n- [ ] Tests pass
- \`filesChanged\`: src/trigger/trigger-store.ts, tests/unit/trigger-store.test.ts
`;
      const result = parseHandoffArtifact(notes);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.value.commitType).toBe('chore');
        expect(result.value.commitScope).toBe('mcp');
      }
    });

    it('returns err for empty notes', () => {
      const result = parseHandoffArtifact('');
      expect(result.kind).toBe('err');
    });

    it('returns err for notes with no parseable fields', () => {
      const result = parseHandoffArtifact('This is just some freeform text with no structured fields.');
      expect(result.kind).toBe('err');
    });
  });
});

// ---------------------------------------------------------------------------
// runDelivery tests
// ---------------------------------------------------------------------------

describe('runDelivery', () => {
  describe('disabled flags', () => {
    it('skips when autoCommit is false', async () => {
      const exec = makeFakeExec();
      const result = await runDelivery(makeArtifact(), '/workspace', makeFlags({ autoCommit: false }), exec);
      expect(result._tag).toBe('skipped');
      expect(exec).not.toHaveBeenCalled();
    });

    it('skips when autoCommit is undefined', async () => {
      const exec = makeFakeExec();
      const result = await runDelivery(makeArtifact(), '/workspace', {}, exec);
      expect(result._tag).toBe('skipped');
      expect(exec).not.toHaveBeenCalled();
    });
  });

  describe('empty filesChanged', () => {
    it('skips when filesChanged is empty -- no git add -A fallback', async () => {
      const exec = makeFakeExec();
      const artifact = makeArtifact({ filesChanged: [] });
      const result = await runDelivery(artifact, '/workspace', makeFlags({ autoCommit: true }), exec);
      expect(result._tag).toBe('skipped');
      if (result._tag === 'skipped') {
        expect(result.reason).toContain('filesChanged is empty');
      }
      expect(exec).not.toHaveBeenCalled();
    });
  });

  describe('commit-only (autoOpenPR: false)', () => {
    it('runs git add + git commit as two separate calls and returns committed', async () => {
      const exec = vi.fn()
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
        .mockResolvedValueOnce({ stdout: '[main abc1234] feat(mcp): add auto-commit support\n 2 files changed', stderr: '' }) as ExecFn; // git commit

      const result = await runDelivery(
        makeArtifact(),
        '/workspace',
        makeFlags({ autoCommit: true, autoOpenPR: false }),
        exec,
      );
      expect(result._tag).toBe('committed');
      if (result._tag === 'committed') {
        expect(result.sha).toBe('abc1234');
      }

      expect(exec).toHaveBeenCalledTimes(2);

      const [addFile, addArgs, addOpts] = (exec as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[], { cwd: string }];
      expect(addFile).toBe('git');
      expect(addArgs[0]).toBe('add');
      expect(addArgs).toContain('src/trigger/delivery-action.ts');
      expect(addOpts.cwd).toBe('/workspace');

      const [commitFile, commitArgs, commitOpts] = (exec as ReturnType<typeof vi.fn>).mock.calls[1] as [string, string[], { cwd: string }];
      expect(commitFile).toBe('git');
      expect(commitArgs[0]).toBe('commit');
      expect(commitArgs[1]).toBe('-m');
      expect(commitArgs[2]).toContain('feat(mcp): add auto-commit support');
      expect(commitOpts.cwd).toBe('/workspace');
    });

    it('returns error when git commit fails', async () => {
      const exec = makeFailingExec('non-zero exit code', '', 'nothing to commit');
      const result = await runDelivery(
        makeArtifact(),
        '/workspace',
        makeFlags({ autoCommit: true }),
        exec,
      );
      expect(result._tag).toBe('error');
      if (result._tag === 'error') {
        expect(result.phase).toBe('commit');
        expect(result.details).toContain('nothing to commit');
      }
    });
  });

  describe('commit + PR (autoOpenPR: true)', () => {
    it('runs git add, git commit, then gh pr create with --body-file and returns pr_opened', async () => {
      // 5 calls: git add, git commit, gh pr create, gh label create, gh pr edit
      const exec = vi.fn()
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
        .mockResolvedValueOnce({ stdout: '[main abc5678] feat(mcp): auto-commit\n 2 files changed', stderr: '' }) // git commit
        .mockResolvedValueOnce({ stdout: 'https://github.com/owner/repo/pull/42\n', stderr: '' }) // gh pr create
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // gh label create
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) as ExecFn; // gh pr edit

      const result = await runDelivery(
        makeArtifact(),
        '/workspace',
        makeFlags({ autoCommit: true, autoOpenPR: true }),
        exec,
      );
      expect(result._tag).toBe('pr_opened');
      if (result._tag === 'pr_opened') {
        expect(result.url).toBe('https://github.com/owner/repo/pull/42');
      }

      expect(exec).toHaveBeenCalledTimes(5);

      const [prFile, prArgs] = (exec as ReturnType<typeof vi.fn>).mock.calls[2] as [string, string[]];
      expect(prFile).toBe('gh');
      expect(prArgs[0]).toBe('pr');
      expect(prArgs[1]).toBe('create');
      expect(prArgs[2]).toBe('--title');
      // Title should have [WT] prefix
      expect(prArgs[3]).toMatch(/^\[WT\] /);
      expect(prArgs[4]).toBe('--body-file');
      expect(prArgs[5]).toContain('workrail-pr-body-');
      expect(prArgs[5]).toMatch(/\.md$/);
    });

    it('returns error with phase: pr when commit succeeds but gh fails', async () => {
      const exec = vi.fn()
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
        .mockResolvedValueOnce({ stdout: '[main abc9999] feat(mcp): auto-commit', stderr: '' }) // git commit
        .mockRejectedValueOnce(Object.assign(new Error('gh: command not found'), { stdout: '', stderr: 'gh: command not found' })) as ExecFn; // gh pr create

      const result = await runDelivery(
        makeArtifact(),
        '/workspace',
        makeFlags({ autoCommit: true, autoOpenPR: true }),
        exec,
      );
      expect(result._tag).toBe('error');
      if (result._tag === 'error') {
        expect(result.phase).toBe('pr');
        expect(result.details).toContain('commit succeeded');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Attribution signal tests
  // ---------------------------------------------------------------------------

  describe('[WT] prefix on PR title', () => {
    it('prepends [WT] to PR title when not already present', async () => {
      const exec = vi.fn()
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
        .mockResolvedValueOnce({ stdout: '[main abc1234] feat(mcp): auto-commit', stderr: '' }) // git commit
        .mockResolvedValueOnce({ stdout: 'https://github.com/owner/repo/pull/1\n', stderr: '' }) // gh pr create
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // gh label create
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) as ExecFn; // gh pr edit

      await runDelivery(
        makeArtifact({ prTitle: 'feat(mcp): add auto-commit support' }),
        '/workspace',
        makeFlags({ autoCommit: true, autoOpenPR: true }),
        exec,
      );

      const [, prArgs] = (exec as ReturnType<typeof vi.fn>).mock.calls[2] as [string, string[]];
      expect(prArgs[3]).toBe('[WT] feat(mcp): add auto-commit support');
    });

    it('does not double-prefix when prTitle already starts with [WT]', async () => {
      const exec = vi.fn()
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
        .mockResolvedValueOnce({ stdout: '[main abc1234] feat(mcp): auto-commit', stderr: '' }) // git commit
        .mockResolvedValueOnce({ stdout: 'https://github.com/owner/repo/pull/1\n', stderr: '' }) // gh pr create
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // gh label create
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) as ExecFn; // gh pr edit

      await runDelivery(
        makeArtifact({ prTitle: '[WT] feat(mcp): add auto-commit support' }),
        '/workspace',
        makeFlags({ autoCommit: true, autoOpenPR: true }),
        exec,
      );

      const [, prArgs] = (exec as ReturnType<typeof vi.fn>).mock.calls[2] as [string, string[]];
      expect(prArgs[3]).toBe('[WT] feat(mcp): add auto-commit support');
    });
  });

  describe('commit trailers', () => {
    it('appends Worktrain-Session trailer when sessionId is set', async () => {
      // WHY 3 calls: sessionId triggers branch assertion (git rev-parse HEAD), then git add, git commit
      const expectedBranch = 'worktrain/test-session-uuid-123';
      const exec = vi.fn()
        .mockResolvedValueOnce({ stdout: `${expectedBranch}\n`, stderr: '' }) // git rev-parse HEAD (branch assertion)
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
        .mockResolvedValueOnce({ stdout: '[main abc1234] feat(mcp): auto-commit', stderr: '' }) as ExecFn; // git commit

      await runDelivery(
        makeArtifact(),
        '/workspace',
        makeFlags({
          autoCommit: true,
          autoOpenPR: false,
          sessionId: 'test-session-uuid-123',
          branchPrefix: 'worktrain/',
        }),
        exec,
      );

      const [, commitArgs] = (exec as ReturnType<typeof vi.fn>).mock.calls[2] as [string, string[]];
      const msgIdx = commitArgs.indexOf('-m');
      expect(msgIdx).toBeGreaterThan(-1);
      const commitMessage = commitArgs[msgIdx + 1];
      expect(commitMessage).toContain('Worktrain-Session: test-session-uuid-123');
    });

    it('always appends Co-authored-by WorkTrain trailer', async () => {
      const exec = vi.fn()
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
        .mockResolvedValueOnce({ stdout: '[main abc1234] feat(mcp): auto-commit', stderr: '' }) as ExecFn; // git commit

      await runDelivery(
        makeArtifact(),
        '/workspace',
        makeFlags({ autoCommit: true, autoOpenPR: false }),
        exec,
      );

      const [, commitArgs] = (exec as ReturnType<typeof vi.fn>).mock.calls[1] as [string, string[]];
      const msgIdx = commitArgs.indexOf('-m');
      const commitMessage = commitArgs[msgIdx + 1];
      expect(commitMessage).toContain('Co-authored-by: WorkTrain <worktrain@noreply.local>');
    });
  });

  describe('gh pr edit --add-label called after PR creation', () => {
    it('calls gh label create then gh pr edit with the PR URL after successful pr create', async () => {
      const prUrl = 'https://github.com/owner/repo/pull/99';
      const exec = vi.fn()
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
        .mockResolvedValueOnce({ stdout: '[main abc1234] feat(mcp): auto-commit', stderr: '' }) // git commit
        .mockResolvedValueOnce({ stdout: `${prUrl}\n`, stderr: '' }) // gh pr create
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // gh label create
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) as ExecFn; // gh pr edit

      await runDelivery(
        makeArtifact(),
        '/workspace',
        makeFlags({ autoCommit: true, autoOpenPR: true }),
        exec,
      );

      const [labelFile, labelArgs] = (exec as ReturnType<typeof vi.fn>).mock.calls[3] as [string, string[]];
      expect(labelFile).toBe('gh');
      expect(labelArgs[0]).toBe('label');
      expect(labelArgs[1]).toBe('create');
      expect(labelArgs[2]).toBe('worktrain:generated');

      const [editFile, editArgs] = (exec as ReturnType<typeof vi.fn>).mock.calls[4] as [string, string[]];
      expect(editFile).toBe('gh');
      expect(editArgs[0]).toBe('pr');
      expect(editArgs[1]).toBe('edit');
      expect(editArgs[2]).toBe(prUrl);
      expect(editArgs[3]).toBe('--add-label');
      expect(editArgs[4]).toBe('worktrain:generated');
    });

    it('does not call gh pr edit when prUrl is empty', async () => {
      const exec = vi.fn()
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
        .mockResolvedValueOnce({ stdout: '[main abc1234] feat(mcp): auto-commit', stderr: '' }) // git commit
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) as ExecFn; // gh pr create (empty output)

      await runDelivery(
        makeArtifact(),
        '/workspace',
        makeFlags({ autoCommit: true, autoOpenPR: true }),
        exec,
      );

      expect(exec).toHaveBeenCalledTimes(3);
    });

    it('label failure is non-fatal -- still returns pr_opened', async () => {
      const exec = vi.fn()
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
        .mockResolvedValueOnce({ stdout: '[main abc1234] feat(mcp): auto-commit', stderr: '' }) // git commit
        .mockResolvedValueOnce({ stdout: 'https://github.com/owner/repo/pull/1\n', stderr: '' }) // gh pr create
        .mockRejectedValueOnce(new Error('gh: label already exists')) // gh label create (fails)
        .mockRejectedValueOnce(new Error('gh: permission denied')) as ExecFn; // gh pr edit (fails)

      const result = await runDelivery(
        makeArtifact(),
        '/workspace',
        makeFlags({ autoCommit: true, autoOpenPR: true }),
        exec,
      );

      expect(result._tag).toBe('pr_opened');
    });
  });

  describe('per-command identity (botIdentity)', () => {
    it('passes -c user.name and -c user.email flags to git commit when botIdentity is set', async () => {
      const exec = vi.fn()
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
        .mockResolvedValueOnce({ stdout: '[main abc1234] feat(mcp): auto-commit', stderr: '' }) as ExecFn; // git commit

      await runDelivery(
        makeArtifact(),
        '/workspace',
        makeFlags({
          autoCommit: true,
          autoOpenPR: false,
          botIdentity: { name: 'WorkTrain Bot', email: 'worktrain@example.com' },
        }),
        exec,
      );

      const [commitFile, commitArgs] = (exec as ReturnType<typeof vi.fn>).mock.calls[1] as [string, string[]];
      expect(commitFile).toBe('git');
      expect(commitArgs[0]).toBe('-c');
      expect(commitArgs[1]).toBe('user.name=WorkTrain Bot');
      expect(commitArgs[2]).toBe('-c');
      expect(commitArgs[3]).toBe('user.email=worktrain@example.com');
      expect(commitArgs[4]).toBe('commit');
      expect(commitArgs[5]).toBe('-m');
    });

    it('does not pass -c flags when botIdentity is absent', async () => {
      const exec = vi.fn()
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
        .mockResolvedValueOnce({ stdout: '[main abc1234] feat(mcp): auto-commit', stderr: '' }) as ExecFn; // git commit

      await runDelivery(
        makeArtifact(),
        '/workspace',
        makeFlags({ autoCommit: true, autoOpenPR: false }),
        exec,
      );

      const [commitFile, commitArgs] = (exec as ReturnType<typeof vi.fn>).mock.calls[1] as [string, string[]];
      expect(commitFile).toBe('git');
      expect(commitArgs[0]).toBe('commit');
      expect(commitArgs[1]).toBe('-m');
      expect(commitArgs).not.toContain('-c');
    });

    it('regression: runDelivery never calls git config (no persistent worktree config writes)', async () => {
      // WHY this test: the old approach wrote `git config user.name/email` to the shared
      // .git/config (shared across worktrees). This regression test ensures we never call
      // `git config` from the delivery path.
      const exec = vi.fn()
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // git add
        .mockResolvedValueOnce({ stdout: '[main abc1234] feat(mcp): auto-commit', stderr: '' }) // git commit
        .mockResolvedValueOnce({ stdout: 'https://github.com/owner/repo/pull/1\n', stderr: '' }) // gh pr create
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) // gh label create
        .mockResolvedValueOnce({ stdout: '', stderr: '' }) as ExecFn; // gh pr edit

      await runDelivery(
        makeArtifact(),
        '/workspace',
        makeFlags({
          autoCommit: true,
          autoOpenPR: true,
          botIdentity: { name: 'WorkTrain Bot', email: 'worktrain@example.com' },
        }),
        exec,
      );

      const calls = (exec as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string[]]>;
      const hasConfigCall = calls.some(([file, args]) =>
        file === 'git' && args.includes('config'),
      );
      expect(hasConfigCall).toBe(false);
    });
  });
});
