/**
 * Unit tests for workspace-types.ts pure functions.
 *
 * Covers:
 *   - joinSessionsAndWorktrees: session/worktree joining by branch name
 *   - sortItemsForRepo: visibility filtering and sort ordering
 *   - itemVisibility: per-item visibility logic
 *   - countNeedsAttention: aggregation helper
 */

import { describe, it, expect } from 'vitest';
import {
  joinSessionsAndWorktrees,
  sortItemsForRepo,
  itemVisibility,
  countNeedsAttention,
  selectPrimarySession,
} from '../../console/src/views/workspace-types.js';
import type { WorkspaceItem } from '../../console/src/views/workspace-types.js';
import type {
  ConsoleSessionSummary,
  ConsoleWorktreeSummary,
  ConsoleRepoWorktrees,
} from '../../console/src/api/types.js';

// ---------------------------------------------------------------------------
// Test fixtures / builders
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = 1_700_000_000_000; // fixed reference time for deterministic tests

function makeSession(overrides: Partial<ConsoleSessionSummary> = {}): ConsoleSessionSummary {
  return {
    sessionId: 'sess_test_000000000000000000000001',
    sessionTitle: null,
    workflowId: 'test-workflow',
    workflowName: 'Test Workflow',
    workflowHash: null,
    runId: null,
    status: 'complete',
    health: 'healthy',
    nodeCount: 5,
    edgeCount: 4,
    tipCount: 1,
    hasUnresolvedGaps: false,
    recapSnippet: null,
    gitBranch: 'feature/foo',
    repoRoot: null,
    lastModifiedMs: NOW_MS - DAY_MS,
    ...overrides,
  };
}

function makeWorktree(overrides: Partial<ConsoleWorktreeSummary> = {}): ConsoleWorktreeSummary {
  return {
    path: '/home/user/my-repo',
    name: 'my-repo',
    branch: 'feature/foo',
    headHash: 'abc1234',
    headMessage: 'fix: something',
    headTimestampMs: NOW_MS - 2 * DAY_MS,
    changedCount: 0,
    changedFiles: [],
    aheadCount: 0,
    unpushedCommits: [],
    isMerged: false,
    activeSessionCount: 0,
    enrichment: null,
    ...overrides,
  };
}

function makeRepo(
  repoRoot: string,
  worktrees: ConsoleWorktreeSummary[],
): ConsoleRepoWorktrees {
  return {
    repoName: repoRoot.split('/').at(-1) ?? repoRoot,
    repoRoot,
    worktrees,
  };
}

// ---------------------------------------------------------------------------
// joinSessionsAndWorktrees -- join logic
// ---------------------------------------------------------------------------

describe('joinSessionsAndWorktrees', () => {
  it('joins a session and worktree sharing the same branch', () => {
    const session = makeSession({ gitBranch: 'feature/foo' });
    const worktree = makeWorktree({ branch: 'feature/foo', path: '/repo/main' });
    const repo = makeRepo('/repo/main', [worktree]);

    const items = joinSessionsAndWorktrees([session], [repo]);

    expect(items).toHaveLength(1);
    expect(items[0]!.branch).toBe('feature/foo');
    expect(items[0]!.repoRoot).toBe('/repo/main');
    expect(items[0]!.worktree).toBeDefined();
    expect(items[0]!.allSessions).toHaveLength(1);
  });

  it('uses worktree repoRoot (not session data) as the group key', () => {
    // Session has no repoRoot field -- repoRoot comes entirely from the worktrees API
    const session = makeSession({ gitBranch: 'feature/bar' });
    const worktree = makeWorktree({ branch: 'feature/bar', path: '/repo/main' });
    const repo = makeRepo('/repo/main', [worktree]);

    const items = joinSessionsAndWorktrees([session], [repo]);

    expect(items).toHaveLength(1);
    expect(items[0]!.repoRoot).toBe('/repo/main');
    expect(items[0]!.worktree).toBeDefined();
  });

  it('includes worktree-only branches (no sessions) as items with no session', () => {
    const worktree = makeWorktree({ branch: 'feature/no-session', path: '/repo' });
    const repo = makeRepo('/repo', [worktree]);

    const items = joinSessionsAndWorktrees([], [repo]);

    expect(items).toHaveLength(1);
    expect(items[0]!.branch).toBe('feature/no-session');
    expect(items[0]!.primarySession).toBeUndefined();
    expect(items[0]!.allSessions).toHaveLength(0);
    expect(items[0]!.worktree).toBeDefined();
  });

  it('excludes sessions with no matching worktree and no repoRoot (archive only)', () => {
    // Session has a branch but no worktree and no repoRoot -- cannot be grouped, excluded
    const session = makeSession({ gitBranch: 'feature/no-worktree', repoRoot: null });
    const items = joinSessionsAndWorktrees([session], []);
    expect(items).toHaveLength(0);
  });

  it('includes sessions with no matching worktree but a known repoRoot (degraded mode)', () => {
    // Session has a repoRoot but no matching worktree (e.g. worktrees API slow/unavailable)
    // -- grouped under a synthetic repo so it remains visible without git badge data
    const session = makeSession({ gitBranch: 'feature/no-worktree', repoRoot: '/repo/main' });
    const items = joinSessionsAndWorktrees([session], []);
    expect(items).toHaveLength(1);
    expect(items[0]!.branch).toBe('feature/no-worktree');
    expect(items[0]!.repoRoot).toBe('/repo/main');
    expect(items[0]!.worktree).toBeUndefined();
  });

  it('excludes sessions with null gitBranch', () => {
    const session = makeSession({ gitBranch: null });

    const items = joinSessionsAndWorktrees([session], []);

    expect(items).toHaveLength(0);
  });

  it('groups multiple sessions for the same branch into one item', () => {
    const session1 = makeSession({ sessionId: 'sess_0000000000000000000000001', gitBranch: 'feature/shared' });
    const session2 = makeSession({ sessionId: 'sess_0000000000000000000000002', gitBranch: 'feature/shared' });
    const worktree = makeWorktree({ branch: 'feature/shared', path: '/repo' });
    const repo = makeRepo('/repo', [worktree]);

    const items = joinSessionsAndWorktrees([session1, session2], [repo]);

    expect(items).toHaveLength(1);
    expect(items[0]!.allSessions).toHaveLength(2);
  });

  it('correctly separates same branch name across different repos', () => {
    // Two repos each have a 'feature/x' branch -- sessions appear in both
    const session1 = makeSession({ sessionId: 'sess_0000000000000000000000001', gitBranch: 'feature/x' });
    const session2 = makeSession({ sessionId: 'sess_0000000000000000000000002', gitBranch: 'feature/x' });
    const wt1 = makeWorktree({ branch: 'feature/x', path: '/repo-a' });
    const wt2 = makeWorktree({ branch: 'feature/x', path: '/repo-b' });
    const repo1 = makeRepo('/repo-a', [wt1]);
    const repo2 = makeRepo('/repo-b', [wt2]);

    const items = joinSessionsAndWorktrees([session1, session2], [repo1, repo2]);

    // Sessions appear in both repos since we can't determine which repo they belong to
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items.map(i => i.repoRoot).sort()).toContain('/repo-a');
    expect(items.map(i => i.repoRoot).sort()).toContain('/repo-b');
  });

  it('excludes detached HEAD worktrees (null branch) from items', () => {
    const detachedWorktree = makeWorktree({ branch: null, path: '/repo' });
    const repo = makeRepo('/repo', [detachedWorktree]);

    const items = joinSessionsAndWorktrees([], [repo]);

    expect(items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// itemVisibility
// ---------------------------------------------------------------------------

describe('itemVisibility', () => {
  function makeItem(overrides: Partial<WorkspaceItem> = {}): WorkspaceItem {
    return {
      branch: 'feature/test',
      repoRoot: '/repo',
      repoName: 'repo',
      worktree: undefined,
      primarySession: undefined,
      allSessions: [],
      activityMs: NOW_MS - 10 * DAY_MS,
      ...overrides,
    };
  }

  it('always visible when session is in_progress', () => {
    const item = makeItem({ primarySession: makeSession({ status: 'in_progress' }) });
    expect(itemVisibility(item, 'active', NOW_MS)).toBe('visible');
  });

  it('always visible when session is blocked', () => {
    const item = makeItem({ primarySession: makeSession({ status: 'blocked' }) });
    expect(itemVisibility(item, 'active', NOW_MS)).toBe('visible');
  });

  it('hidden in active scope when session is dormant and no git changes', () => {
    // Dormant sessions without uncommitted/unpushed work are hidden in Active scope
    const item = makeItem({ primarySession: makeSession({ status: 'dormant' }) });
    expect(itemVisibility(item, 'active', NOW_MS)).toBe('hidden');
  });

  it('visible in all scope when session is dormant', () => {
    const item = makeItem({ primarySession: makeSession({ status: 'dormant' }) });
    expect(itemVisibility(item, 'all', NOW_MS)).toBe('visible');
  });

  it('visible in active scope when session is dormant but branch has uncommitted changes', () => {
    const worktree = makeWorktree({ changedCount: 2 });
    const item = makeItem({ primarySession: makeSession({ status: 'dormant' }), worktree });
    expect(itemVisibility(item, 'active', NOW_MS)).toBe('visible');
  });

  it('visible when uncommitted changes exist', () => {
    const worktree = makeWorktree({ changedCount: 3 });
    const item = makeItem({ worktree, activityMs: NOW_MS - 60 * DAY_MS });
    expect(itemVisibility(item, 'active', NOW_MS)).toBe('visible');
  });

  it('visible when unpushed commits exist', () => {
    const worktree = makeWorktree({ aheadCount: 2 });
    const item = makeItem({ worktree, activityMs: NOW_MS - 60 * DAY_MS });
    expect(itemVisibility(item, 'active', NOW_MS)).toBe('visible');
  });

  it('visible when activity is within 30 days in active scope', () => {
    const item = makeItem({ activityMs: NOW_MS - 15 * DAY_MS });
    expect(itemVisibility(item, 'active', NOW_MS)).toBe('visible');
  });

  it('hidden when old, clean, and done in active scope', () => {
    const worktree = makeWorktree({ changedCount: 0, aheadCount: 0 });
    const item = makeItem({
      worktree,
      primarySession: makeSession({ status: 'complete' }),
      activityMs: NOW_MS - 60 * DAY_MS,
    });
    expect(itemVisibility(item, 'active', NOW_MS)).toBe('hidden');
  });

  it('visible in all scope even when old, clean, and done', () => {
    const worktree = makeWorktree({ changedCount: 0, aheadCount: 0 });
    const item = makeItem({
      worktree,
      primarySession: makeSession({ status: 'complete' }),
      activityMs: NOW_MS - 60 * DAY_MS,
    });
    expect(itemVisibility(item, 'all', NOW_MS)).toBe('visible');
  });
});

// ---------------------------------------------------------------------------
// sortItemsForRepo
// ---------------------------------------------------------------------------

describe('sortItemsForRepo', () => {
  function makeItem(overrides: Partial<WorkspaceItem> = {}): WorkspaceItem {
    return {
      branch: 'feature/test',
      repoRoot: '/repo',
      repoName: 'repo',
      worktree: undefined,
      primarySession: undefined,
      allSessions: [],
      activityMs: NOW_MS - DAY_MS,
      ...overrides,
    };
  }

  it('puts in_progress sessions first', () => {
    const inProgress = makeItem({ branch: 'b', primarySession: makeSession({ status: 'in_progress' }) });
    const complete = makeItem({ branch: 'a', primarySession: makeSession({ status: 'complete' }) });

    const result = sortItemsForRepo([complete, inProgress], 'active', NOW_MS);

    expect(result[0]!.branch).toBe('b');
  });

  it('puts blocked before dormant', () => {
    const blocked = makeItem({ branch: 'blocked', primarySession: makeSession({ status: 'blocked' }) });
    const dormant = makeItem({ branch: 'dormant', primarySession: makeSession({ status: 'dormant' }) });

    const result = sortItemsForRepo([dormant, blocked], 'active', NOW_MS);

    expect(result[0]!.branch).toBe('blocked');
  });

  it('filters out hidden items in active scope', () => {
    const worktree = makeWorktree({ changedCount: 0, aheadCount: 0 });
    const old = makeItem({
      branch: 'old',
      worktree,
      primarySession: makeSession({ status: 'complete' }),
      activityMs: NOW_MS - 60 * DAY_MS,
    });
    const recent = makeItem({
      branch: 'recent',
      primarySession: makeSession({ status: 'in_progress' }),
      activityMs: NOW_MS - DAY_MS,
    });

    const result = sortItemsForRepo([old, recent], 'active', NOW_MS);

    expect(result.map(i => i.branch)).toEqual(['recent']);
  });

  it('returns new array, does not mutate input', () => {
    const items = [
      makeItem({ branch: 'b', activityMs: NOW_MS }),
      makeItem({ branch: 'a', activityMs: NOW_MS }),
    ];
    const original = [...items];

    sortItemsForRepo(items, 'all', NOW_MS);

    expect(items[0]!.branch).toBe(original[0]!.branch);
  });
});

// ---------------------------------------------------------------------------
// countNeedsAttention
// ---------------------------------------------------------------------------

describe('countNeedsAttention', () => {
  function makeItem(status: string): WorkspaceItem {
    return {
      branch: 'b',
      repoRoot: '/r',
      repoName: 'r',
      worktree: undefined,
      primarySession: makeSession({ status: status as ConsoleSessionSummary['status'] }),
      allSessions: [],
      activityMs: NOW_MS,
    };
  }

  it('counts blocked sessions', () => {
    const items = [makeItem('blocked'), makeItem('complete')];
    expect(countNeedsAttention(items)).toBe(1);
  });

  it('does not count dormant sessions (dormant is hidden in Active scope, not an attention signal)', () => {
    const items = [makeItem('dormant'), makeItem('complete')];
    expect(countNeedsAttention(items)).toBe(0);
  });

  it('counts blocked but not dormant', () => {
    const items = [makeItem('blocked'), makeItem('dormant'), makeItem('in_progress')];
    expect(countNeedsAttention(items)).toBe(1);
  });

  it('returns 0 when no items need attention', () => {
    const items = [makeItem('complete'), makeItem('in_progress')];
    expect(countNeedsAttention(items)).toBe(0);
  });

  it('returns 0 for empty list', () => {
    expect(countNeedsAttention([])).toBe(0);
  });

  it('does not count items with no session', () => {
    const noSession: WorkspaceItem = {
      branch: 'b',
      repoRoot: '/r',
      repoName: 'r',
      worktree: undefined,
      primarySession: undefined,
      allSessions: [],
      activityMs: NOW_MS,
    };
    expect(countNeedsAttention([noSession])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// selectPrimarySession
// ---------------------------------------------------------------------------

describe('selectPrimarySession', () => {
  it('returns undefined for empty array', () => {
    expect(selectPrimarySession([])).toBeUndefined();
  });

  it('prefers in_progress over complete', () => {
    const inProgress = makeSession({ sessionId: 'sess_0000000000000000000000001', status: 'in_progress' });
    const complete = makeSession({ sessionId: 'sess_0000000000000000000000002', status: 'complete' });
    expect(selectPrimarySession([complete, inProgress])!.status).toBe('in_progress');
  });

  it('prefers blocked over complete_with_gaps', () => {
    const blocked = makeSession({ sessionId: 'sess_0000000000000000000000001', status: 'blocked' });
    const gaps = makeSession({ sessionId: 'sess_0000000000000000000000002', status: 'complete_with_gaps' });
    expect(selectPrimarySession([gaps, blocked])!.status).toBe('blocked');
  });

  it('uses recency as tiebreaker within same priority', () => {
    const older = makeSession({ sessionId: 'sess_0000000000000000000000001', status: 'complete', lastModifiedMs: NOW_MS - 2 * DAY_MS });
    const newer = makeSession({ sessionId: 'sess_0000000000000000000000002', status: 'complete', lastModifiedMs: NOW_MS - DAY_MS });
    expect(selectPrimarySession([older, newer])!.sessionId).toBe('sess_0000000000000000000000002');
  });
});
