/**
 * Unit tests for workflow-enricher.ts.
 *
 * Strategy: inject fake deps for all I/O. Tests are synchronous-ish (vitest
 * handles async). No fs access, no git subprocess, no session store.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  enrichTriggerContext,
  shouldEnrich,
  type WorkflowEnricherDeps,
} from '../../src/daemon/workflow-enricher.js';
import type { WorkflowTrigger } from '../../src/daemon/types.js';
import type { SessionNote } from '../../src/context-assembly/types.js';

const baseTrigger: WorkflowTrigger = {
  workflowId: 'wr.coding-task',
  goal: 'implement feature',
  workspacePath: '/workspace',
};

const sampleNotes: readonly SessionNote[] = [
  {
    sessionId: 'sess_abc',
    sessionTitle: 'Prior review session',
    recapSnippet: 'Reviewed PR and found 2 issues',
    gitBranch: 'main',
    lastModifiedMs: Date.now() - 3600_000,
  },
];

function makeFakeDeps(overrides: Partial<WorkflowEnricherDeps> = {}): WorkflowEnricherDeps {
  return {
    execGit: vi.fn().mockResolvedValue({ kind: 'ok', value: 'src/foo.ts | 5 ++\n1 file changed' }),
    listRecentSessions: vi.fn().mockResolvedValue({ kind: 'ok', value: sampleNotes }),
    ...overrides,
  };
}

describe('shouldEnrich()', () => {
  it('returns true for root sessions (no spawnDepth)', () => {
    expect(shouldEnrich(baseTrigger)).toBe(true);
  });

  it('returns true for spawnDepth === 0', () => {
    expect(shouldEnrich({ ...baseTrigger, spawnDepth: 0 })).toBe(true);
  });

  it('returns false for spawn_agent children (spawnDepth > 0)', () => {
    expect(shouldEnrich({ ...baseTrigger, spawnDepth: 1 })).toBe(false);
    expect(shouldEnrich({ ...baseTrigger, spawnDepth: 3 })).toBe(false);
  });
});

describe('enrichTriggerContext()', () => {
  it('returns prior notes and gitDiffStat for a root session', async () => {
    const deps = makeFakeDeps();
    const result = await enrichTriggerContext(baseTrigger, deps, false);

    expect(result.priorSessionNotes).toHaveLength(1);
    expect(result.priorSessionNotes[0]?.sessionTitle).toBe('Prior review session');
    expect(result.gitDiffStat).toContain('src/foo.ts');
  });

  it('skips prior notes when skipPriorNotes is true (assembledContextSummary present)', async () => {
    const deps = makeFakeDeps();
    const result = await enrichTriggerContext(baseTrigger, deps, true);

    expect(result.priorSessionNotes).toHaveLength(0);
    expect(deps.listRecentSessions).not.toHaveBeenCalled();
    // gitDiffStat is still injected
    expect(result.gitDiffStat).toBeTruthy();
  });

  it('still injects gitDiffStat when assembledContextSummary present (skipPriorNotes=true)', async () => {
    const triggerWithCtx: WorkflowTrigger = {
      ...baseTrigger,
      context: { assembledContextSummary: 'Coordinator assembled context' },
    };
    const deps = makeFakeDeps();
    const result = await enrichTriggerContext(triggerWithCtx, deps, true);

    expect(result.priorSessionNotes).toHaveLength(0);
    expect(result.gitDiffStat).toBeTruthy();
  });

  it('returns empty priorSessionNotes when listRecentSessions times out', async () => {
    const slowListSessions: WorkflowEnricherDeps['listRecentSessions'] = () =>
      new Promise((resolve) => setTimeout(() => resolve({ kind: 'ok', value: sampleNotes }), 5000));
    const deps = makeFakeDeps({ listRecentSessions: slowListSessions });

    const result = await enrichTriggerContext(baseTrigger, deps, false);

    // Timeout fires before the slow promise resolves
    expect(result.priorSessionNotes).toHaveLength(0);
    // gitDiffStat is independent and should still resolve
    expect(result.gitDiffStat).toBeTruthy();
  }, 3000); // 3s timeout -- enricher times out at 1s

  it('returns null gitDiffStat when git command fails', async () => {
    const deps = makeFakeDeps({
      execGit: vi.fn().mockResolvedValue({ kind: 'err', error: 'not a git repository' }),
    });
    const result = await enrichTriggerContext(baseTrigger, deps, false);

    expect(result.gitDiffStat).toBeNull();
    expect(result.priorSessionNotes).toHaveLength(1);
  });

  it('returns empty result when listRecentSessions fails', async () => {
    const deps = makeFakeDeps({
      listRecentSessions: vi.fn().mockResolvedValue({ kind: 'err', error: 'store unavailable' }),
    });
    const result = await enrichTriggerContext(baseTrigger, deps, false);

    expect(result.priorSessionNotes).toHaveLength(0);
    expect(result.gitDiffStat).toBeTruthy(); // git still ran
  });
});
