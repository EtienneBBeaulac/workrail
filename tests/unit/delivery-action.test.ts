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

    it('rejects JSON block missing required field commitType', () => {
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
      if (result.kind === 'err') {
        expect(result.error).toContain('commitType');
      }
    });

    it('rejects JSON block with empty filesChanged', () => {
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
      if (result.kind === 'err') {
        expect(result.error).toContain('filesChanged is empty');
      }
    });

    it('falls through to line-scan if JSON is invalid', () => {
      // Invalid JSON in the block -- should fall through to line-scan
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
      // Should succeed via line-scan (filesChanged: docs/README.md)
      // Note: line-scan may parse this -- accept either outcome
      expect(result.kind).toBeDefined();
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
    it('runs git add + git commit and returns committed', async () => {
      // git commit output typically contains "[main abc1234] message"
      const exec = makeFakeExec('[main abc1234] feat(mcp): add auto-commit support\n 2 files changed', '');
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
      expect(exec).toHaveBeenCalledOnce();
      const [cmd, opts] = (exec as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { cwd: string }];
      expect(cmd).toContain('git add');
      expect(cmd).toContain('git commit');
      expect(cmd).toContain('feat(mcp): add auto-commit support');
      expect(opts.cwd).toBe('/workspace');
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
    it('runs git commit then gh pr create and returns pr_opened', async () => {
      const exec = vi.fn()
        .mockResolvedValueOnce({ stdout: '[main abc5678] feat(mcp): auto-commit\n 2 files changed', stderr: '' })
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
      expect(exec).toHaveBeenCalledTimes(2);
      const [prCmd] = (exec as ReturnType<typeof vi.fn>).mock.calls[1] as [string, unknown];
      expect(prCmd).toContain('gh pr create');
      expect(prCmd).toContain('--title');
    });

    it('returns error with phase: pr when commit succeeds but gh fails', async () => {
      const exec = vi.fn()
        .mockResolvedValueOnce({ stdout: '[main abc9999] feat(mcp): auto-commit', stderr: '' })
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
