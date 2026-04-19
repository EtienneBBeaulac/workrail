/**
 * Unit tests for the context-assembly module.
 *
 * Uses fake deps (in-memory functions). No vi.mock() -- follows repo pattern
 * of "prefer fakes over mocks".
 */

import { describe, it, expect } from 'vitest';
import { createContextAssembler, renderContextBundle } from '../../src/context-assembly/index.js';
import type { ContextAssemblerDeps } from '../../src/context-assembly/deps.js';
import type { SessionNote, AssemblyTask, ContextBundle } from '../../src/context-assembly/types.js';

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function makeFakeDeps(overrides: Partial<ContextAssemblerDeps> = {}): ContextAssemblerDeps {
  return {
    execGit: async (_args, _cwd) => ({ kind: 'ok', value: 'src/foo.ts | 5 ++\n1 file changed' }),
    execGh: async (_args, _cwd) => ({ kind: 'err', error: 'gh not available' }),
    listRecentSessions: async (_workspacePath, _limit) => ({ kind: 'ok', value: [] }),
    nowIso: () => '2026-04-19T00:00:00.000Z',
    ...overrides,
  };
}

const prReviewTask: AssemblyTask = {
  kind: 'pr_review',
  prNumber: 42,
  workspacePath: '/workspace/my-repo',
};

const sampleNote: SessionNote = {
  sessionId: 'ses_abc123def456',
  recapSnippet: 'Fixed the login bug and updated tests.',
  sessionTitle: 'Fix login regression',
  gitBranch: 'fix/login-regression',
  lastModifiedMs: 1713456789000,
};

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('createContextAssembler', () => {
  describe('assemble()', () => {
    it('returns bundle with ok results when both sources succeed', async () => {
      const deps = makeFakeDeps({
        execGh: async () => ({ kind: 'ok', value: 'src/auth.ts\nsrc/login.tsx' }),
        listRecentSessions: async () => ({ kind: 'ok', value: [sampleNote] }),
      });
      const assembler = createContextAssembler(deps);

      const bundle = await assembler.assemble(prReviewTask);

      expect(bundle.gitDiff.kind).toBe('ok');
      expect(bundle.priorSessionNotes.kind).toBe('ok');
      expect(bundle.assembledAt).toBe('2026-04-19T00:00:00.000Z');
      expect(bundle.task).toEqual(prReviewTask);
    });

    it('returns priorNotes ok when gitSummary fails (partial failure)', async () => {
      const deps = makeFakeDeps({
        execGit: async () => ({ kind: 'err', error: 'detached HEAD' }),
        execGh: async () => ({ kind: 'err', error: 'gh not found' }),
        listRecentSessions: async () => ({ kind: 'ok', value: [sampleNote] }),
      });
      const assembler = createContextAssembler(deps);

      const bundle = await assembler.assemble(prReviewTask);

      expect(bundle.gitDiff.kind).toBe('err');
      expect(bundle.priorSessionNotes.kind).toBe('ok');
      if (bundle.priorSessionNotes.kind === 'ok') {
        expect(bundle.priorSessionNotes.value).toHaveLength(1);
      }
    });

    it('falls back to git diff when gh pr diff fails', async () => {
      const deps = makeFakeDeps({
        execGh: async () => ({ kind: 'err', error: 'gh not installed' }),
        execGit: async (_args, _cwd) => ({ kind: 'ok', value: 'src/bar.ts | 3 ++\n1 file changed' }),
      });
      const assembler = createContextAssembler(deps);

      const bundle = await assembler.assemble(prReviewTask);

      expect(bundle.gitDiff.kind).toBe('ok');
      if (bundle.gitDiff.kind === 'ok') {
        expect(bundle.gitDiff.value).toContain('src/bar.ts');
      }
    });
  });
});

describe('renderContextBundle', () => {
  it('produces correct markdown sections when both sources succeed', () => {
    const bundle: ContextBundle = {
      task: prReviewTask,
      gitDiff: { kind: 'ok', value: 'src/auth.ts | 5 ++\n1 file changed' },
      priorSessionNotes: { kind: 'ok', value: [sampleNote] },
      assembledAt: '2026-04-19T00:00:00.000Z',
    };

    const rendered = renderContextBundle(bundle);

    expect(rendered).toContain('### Recent session notes for this workspace');
    expect(rendered).toContain('Fix login regression');
    expect(rendered).toContain('branch: fix/login-regression');
    expect(rendered).toContain('Fixed the login bug and updated tests.');
    expect(rendered).toContain('### Changed files');
    expect(rendered).toContain('```');
    expect(rendered).toContain('src/auth.ts | 5 ++');
  });

  it('returns empty string when both sources fail (nothing to inject)', () => {
    const bundle: ContextBundle = {
      task: prReviewTask,
      gitDiff: { kind: 'err', error: 'git failed' },
      priorSessionNotes: { kind: 'err', error: 'sessions failed' },
      assembledAt: '2026-04-19T00:00:00.000Z',
    };

    const rendered = renderContextBundle(bundle);

    expect(rendered).toBe('');
  });

  it('omits prior notes section when no sessions exist', () => {
    const bundle: ContextBundle = {
      task: prReviewTask,
      gitDiff: { kind: 'ok', value: 'src/foo.ts | 2 +\n1 file changed' },
      priorSessionNotes: { kind: 'ok', value: [] },
      assembledAt: '2026-04-19T00:00:00.000Z',
    };

    const rendered = renderContextBundle(bundle);

    expect(rendered).not.toContain('Recent session notes');
    expect(rendered).toContain('### Changed files');
  });

  it('uses sessionId prefix as title when sessionTitle is null', () => {
    const noteWithoutTitle: SessionNote = {
      sessionId: 'ses_xyz987654321',
      recapSnippet: 'Some work was done.',
      sessionTitle: null,
      gitBranch: null,
      lastModifiedMs: 1713456789000,
    };

    const bundle: ContextBundle = {
      task: prReviewTask,
      gitDiff: { kind: 'err', error: 'git failed' },
      priorSessionNotes: { kind: 'ok', value: [noteWithoutTitle] },
      assembledAt: '2026-04-19T00:00:00.000Z',
    };

    const rendered = renderContextBundle(bundle);

    // Should use first 12 chars of sessionId as fallback title
    expect(rendered).toContain('ses_xyz98765');
  });
});
