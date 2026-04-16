/**
 * Tests for src/trigger/delivery-action.ts
 *
 * Covers:
 * - parseHandoffArtifact: JSON fenced block, line-scan fallback, missing fields, empty input
 * - runDelivery: disabled flags, empty filesChanged, commit-only, commit+PR, exec failures
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
  return { autoCommit: false, autoOpenPR: false, ...overrides };
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
      // With matchAll: the block fails assembleArtifact (missing commitType),
      // falls through to line-scan which also finds no key:value lines -- so err is returned.
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
      // With matchAll: the block fails assembleArtifact (empty filesChanged),
      // falls through to line-scan which also finds no key:value lines.
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
      // Invalid JSON in the block -- should fall through to line-scan and succeed.
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
      // Must succeed via line-scan after the invalid JSON block is skipped
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') {
        expect(result.value.commitType).toBe('chore');
      }
    });

    it('tries second JSON block when first block is missing required fields', () => {
      // First block is valid JSON but missing required fields.
      // Second block is a complete handoff artifact. matchAll ensures both are tried.
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
      // Critical safety invariant: exec must NOT be called (no git add -A)
      expect(exec).not.toHaveBeenCalled();
    });
  });

  describe('commit-only (autoOpenPR: false)', () => {
    it('runs git add + git commit as two separate calls and returns committed', async () => {
      // Two calls: git add (empty output), then git commit (output with SHA).
      // WHY two calls: execFile does not invoke /bin/sh, so && chaining is impossible.
      const exec = vi.fn()
        // Call 0: git add
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        // Call 1: git commit (output contains SHA)
        .mockResolvedValueOnce({ stdout: '[main abc1234] feat(mcp): add auto-commit support\n 2 files changed', stderr: '' }) as ExecFn;

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

      // Must have been called exactly twice: git add, then git commit
      expect(exec).toHaveBeenCalledTimes(2);

      // Call 0: git add <files...>
      const [addFile, addArgs, addOpts] = (exec as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[], { cwd: string }];
      expect(addFile).toBe('git');
      expect(addArgs[0]).toBe('add');
      expect(addArgs).toContain('src/trigger/delivery-action.ts');
      expect(addOpts.cwd).toBe('/workspace');

      // Call 1: git commit -m <message>
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
      // Three calls: git add, git commit, gh pr create.
      // prBody is written to a temp file; gh receives --body-file <path>.
      const exec = vi.fn()
        // Call 0: git add
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        // Call 1: git commit
        .mockResolvedValueOnce({ stdout: '[main abc5678] feat(mcp): auto-commit\n 2 files changed', stderr: '' })
        // Call 2: gh pr create
        .mockResolvedValueOnce({ stdout: 'https://github.com/owner/repo/pull/42\n', stderr: '' }) as ExecFn;

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

      // Must have been called exactly 3 times: add, commit, pr create
      expect(exec).toHaveBeenCalledTimes(3);

      // Call 2: gh pr create --title <title> --body-file <tmpfile>
      const [prFile, prArgs] = (exec as ReturnType<typeof vi.fn>).mock.calls[2] as [string, string[]];
      expect(prFile).toBe('gh');
      expect(prArgs[0]).toBe('pr');
      expect(prArgs[1]).toBe('create');
      expect(prArgs[2]).toBe('--title');
      expect(prArgs[3]).toBe('feat(mcp): add auto-commit support');
      expect(prArgs[4]).toBe('--body-file');
      expect(prArgs[5]).toContain('workrail-pr-body-');
      expect(prArgs[5]).toMatch(/\.md$/);
    });

    it('returns error with phase: pr when commit succeeds but gh fails', async () => {
      const exec = vi.fn()
        // Call 0: git add (success)
        .mockResolvedValueOnce({ stdout: '', stderr: '' })
        // Call 1: git commit (success)
        .mockResolvedValueOnce({ stdout: '[main abc9999] feat(mcp): auto-commit', stderr: '' })
        // Call 2: gh pr create (fails)
        .mockRejectedValueOnce(Object.assign(new Error('gh: command not found'), { stdout: '', stderr: 'gh: command not found' })) as ExecFn;

      const result = await runDelivery(
        makeArtifact(),
        '/workspace',
        makeFlags({ autoCommit: true, autoOpenPR: true }),
        exec,
      );
      expect(result._tag).toBe('error');
      if (result._tag === 'error') {
        expect(result.phase).toBe('pr');
        // Must mention that commit succeeded
        expect(result.details).toContain('commit succeeded');
      }
    });
  });
});
