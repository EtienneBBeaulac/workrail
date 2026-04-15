/**
 * Unit tests for session-list-use-cases.ts pure functions.
 *
 * Pure function tests -- no DOM, no React, no mocks.
 * Pattern follows console-workflows-use-cases.test.ts.
 *
 * Covers:
 *   - filterSessions: status + search filtering
 *   - sortSessions: all 4 sort axes
 *   - groupSessions: all 4 group axes
 *   - computeStatusCounts: full list invariant
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  filterSessions,
  sortSessions,
  groupSessions,
  computeStatusCounts,
} from '../../console/src/views/session-list-use-cases';
import type { ConsoleSessionSummary } from '../../console/src/api/types';

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

let idCounter = 0;

beforeEach(() => { idCounter = 0; });

function makeSession(overrides: Partial<ConsoleSessionSummary> = {}): ConsoleSessionSummary {
  idCounter += 1;
  return {
    sessionId: `sess-${idCounter}`,
    sessionTitle: `Session ${idCounter}`,
    workflowId: `wf-${idCounter}`,
    workflowName: `Workflow ${idCounter}`,
    workflowHash: null,
    runId: null,
    status: 'complete',
    health: 'healthy',
    nodeCount: idCounter,
    edgeCount: idCounter,
    tipCount: 1,
    hasUnresolvedGaps: false,
    recapSnippet: null,
    gitBranch: `feature/branch-${idCounter}`,
    repoRoot: '/repo',
    lastModifiedMs: idCounter * 1000,
    isAutonomous: false,
    isLive: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// filterSessions
// ---------------------------------------------------------------------------

describe('filterSessions', () => {
  it('returns all sessions when statusFilter is all and search is empty', () => {
    const sessions = [makeSession(), makeSession(), makeSession()];
    expect(filterSessions(sessions, '', 'all')).toHaveLength(3);
  });

  it('filters by status', () => {
    const sessions = [
      makeSession({ status: 'in_progress' }),
      makeSession({ status: 'complete' }),
      makeSession({ status: 'blocked' }),
    ];
    const result = filterSessions(sessions, '', 'in_progress');
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe('in_progress');
  });

  it('filters by dormant status', () => {
    const sessions = [
      makeSession({ status: 'dormant' }),
      makeSession({ status: 'complete' }),
    ];
    const result = filterSessions(sessions, '', 'dormant');
    expect(result).toHaveLength(1);
  });

  it('matches search against sessionTitle', () => {
    const sessions = [
      makeSession({ sessionTitle: 'Fix the login bug' }),
      makeSession({ sessionTitle: 'Add dark mode' }),
    ];
    const result = filterSessions(sessions, 'login', 'all');
    expect(result).toHaveLength(1);
    expect(result[0]!.sessionTitle).toBe('Fix the login bug');
  });

  it('matches search against workflowName', () => {
    const sessions = [
      makeSession({ workflowName: 'coding-task-workflow' }),
      makeSession({ workflowName: 'mr-review-workflow' }),
    ];
    const result = filterSessions(sessions, 'mr-review', 'all');
    expect(result).toHaveLength(1);
  });

  it('matches search against workflowId', () => {
    const sessions = [
      makeSession({ workflowId: 'wf-abc-123', workflowName: null }),
      makeSession({ workflowId: 'wf-def-456', workflowName: null }),
    ];
    const result = filterSessions(sessions, 'abc-123', 'all');
    expect(result).toHaveLength(1);
  });

  it('matches search against sessionId', () => {
    const sessions = [
      makeSession({ sessionId: 'unique-id-xyz' }),
      makeSession({ sessionId: 'other-session' }),
    ];
    const result = filterSessions(sessions, 'unique-id', 'all');
    expect(result).toHaveLength(1);
  });

  it('matches search against gitBranch', () => {
    const sessions = [
      makeSession({ gitBranch: 'feature/acei-1234' }),
      makeSession({ gitBranch: 'main' }),
    ];
    const result = filterSessions(sessions, 'acei-1234', 'all');
    expect(result).toHaveLength(1);
  });

  it('search is case-insensitive', () => {
    const sessions = [makeSession({ sessionTitle: 'Fix Login Bug' })];
    expect(filterSessions(sessions, 'fix login', 'all')).toHaveLength(1);
    expect(filterSessions(sessions, 'FIX LOGIN', 'all')).toHaveLength(1);
  });

  it('combines status and search (AND logic)', () => {
    const sessions = [
      makeSession({ status: 'in_progress', sessionTitle: 'Feature work', gitBranch: 'main', workflowName: 'coding', workflowId: 'wf-1' }),
      makeSession({ status: 'complete', sessionTitle: 'Feature done', gitBranch: 'main', workflowName: 'coding', workflowId: 'wf-2' }),
      makeSession({ status: 'in_progress', sessionTitle: 'Other task', gitBranch: 'main', workflowName: 'coding', workflowId: 'wf-3' }),
    ];
    const result = filterSessions(sessions, 'feature', 'in_progress');
    expect(result).toHaveLength(1);
    expect(result[0]!.sessionTitle).toBe('Feature work');
  });

  it('returns empty array when no sessions match', () => {
    const sessions = [makeSession({ status: 'complete' })];
    expect(filterSessions(sessions, '', 'in_progress')).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(filterSessions([], 'foo', 'all')).toHaveLength(0);
  });

  it('does not mutate the input array', () => {
    const sessions = [makeSession(), makeSession()];
    const originalLength = sessions.length;
    filterSessions(sessions, 'foo', 'complete');
    expect(sessions).toHaveLength(originalLength);
  });

  it('ignores whitespace-only search', () => {
    const sessions = [makeSession(), makeSession()];
    expect(filterSessions(sessions, '   ', 'all')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// sortSessions
// ---------------------------------------------------------------------------

describe('sortSessions', () => {
  it("sorts by recent (lastModifiedMs descending)", () => {
    const s1 = makeSession({ lastModifiedMs: 1000 });
    const s2 = makeSession({ lastModifiedMs: 3000 });
    const s3 = makeSession({ lastModifiedMs: 2000 });
    const result = sortSessions([s1, s2, s3], 'recent');
    expect(result[0]!.lastModifiedMs).toBe(3000);
    expect(result[1]!.lastModifiedMs).toBe(2000);
    expect(result[2]!.lastModifiedMs).toBe(1000);
  });

  it('sorts by status (in_progress first, complete last)', () => {
    const s1 = makeSession({ status: 'complete', lastModifiedMs: 100 });
    const s2 = makeSession({ status: 'in_progress', lastModifiedMs: 100 });
    const s3 = makeSession({ status: 'blocked', lastModifiedMs: 100 });
    const result = sortSessions([s1, s2, s3], 'status');
    expect(result[0]!.status).toBe('in_progress');
    expect(result[1]!.status).toBe('blocked');
    expect(result[2]!.status).toBe('complete');
  });

  it('sorts by status with tiebreak by lastModifiedMs descending', () => {
    const s1 = makeSession({ status: 'complete', lastModifiedMs: 1000 });
    const s2 = makeSession({ status: 'complete', lastModifiedMs: 3000 });
    const result = sortSessions([s1, s2], 'status');
    expect(result[0]!.lastModifiedMs).toBe(3000);
  });

  it('sorts by workflow name alphabetically', () => {
    const s1 = makeSession({ workflowName: 'zebra-workflow', workflowId: null });
    const s2 = makeSession({ workflowName: 'apple-workflow', workflowId: null });
    const result = sortSessions([s1, s2], 'workflow');
    expect(result[0]!.workflowName).toBe('apple-workflow');
  });

  it('uses workflowId when workflowName is null for workflow sort', () => {
    const s1 = makeSession({ workflowName: null, workflowId: 'zzz-workflow' });
    const s2 = makeSession({ workflowName: null, workflowId: 'aaa-workflow' });
    const result = sortSessions([s1, s2], 'workflow');
    expect(result[0]!.workflowId).toBe('aaa-workflow');
  });

  it('sorts by nodeCount descending', () => {
    const s1 = makeSession({ nodeCount: 5 });
    const s2 = makeSession({ nodeCount: 20 });
    const s3 = makeSession({ nodeCount: 1 });
    const result = sortSessions([s1, s2, s3], 'nodes');
    expect(result[0]!.nodeCount).toBe(20);
    expect(result[1]!.nodeCount).toBe(5);
    expect(result[2]!.nodeCount).toBe(1);
  });

  it('does not mutate the input array', () => {
    const sessions = [makeSession({ lastModifiedMs: 1000 }), makeSession({ lastModifiedMs: 3000 })];
    const originalFirst = sessions[0]!.sessionId;
    sortSessions(sessions, 'recent');
    expect(sessions[0]!.sessionId).toBe(originalFirst);
  });

  it('returns empty array for empty input', () => {
    expect(sortSessions([], 'recent')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// groupSessions
// ---------------------------------------------------------------------------

describe('groupSessions', () => {
  it("returns single group with empty label when groupBy is 'none'", () => {
    const sessions = [makeSession(), makeSession()];
    const result = groupSessions(sessions, 'none');
    expect(result).toHaveLength(1);
    expect(result[0]!.label).toBe('');
    expect(result[0]!.sessions).toHaveLength(2);
  });

  it("groups by workflow name", () => {
    const sessions = [
      makeSession({ workflowName: 'workflow-a' }),
      makeSession({ workflowName: 'workflow-b' }),
      makeSession({ workflowName: 'workflow-a' }),
    ];
    const result = groupSessions(sessions, 'workflow');
    expect(result).toHaveLength(2);
    const groupA = result.find((g) => g.label === 'workflow-a');
    expect(groupA?.sessions).toHaveLength(2);
  });

  it("uses workflowId as fallback when workflowName is null for workflow grouping", () => {
    const sessions = [
      makeSession({ workflowName: null, workflowId: 'wf-123' }),
    ];
    const result = groupSessions(sessions, 'workflow');
    expect(result[0]!.label).toBe('wf-123');
  });

  it("uses 'Unknown workflow' when both workflowName and workflowId are null", () => {
    const sessions = [
      makeSession({ workflowName: null, workflowId: null }),
    ];
    const result = groupSessions(sessions, 'workflow');
    expect(result[0]!.label).toBe('Unknown workflow');
  });

  it("groups by status and sorts by STATUS_SORT_ORDER (in_progress first)", () => {
    const sessions = [
      makeSession({ status: 'complete' }),
      makeSession({ status: 'in_progress' }),
      makeSession({ status: 'blocked' }),
    ];
    const result = groupSessions(sessions, 'status');
    expect(result[0]!.label).toBe('in_progress');
    expect(result[1]!.label).toBe('blocked');
    expect(result[2]!.label).toBe('complete');
  });

  it("groups by branch", () => {
    const sessions = [
      makeSession({ gitBranch: 'main' }),
      makeSession({ gitBranch: 'feature/foo' }),
      makeSession({ gitBranch: 'main' }),
    ];
    const result = groupSessions(sessions, 'branch');
    expect(result).toHaveLength(2);
    const mainGroup = result.find((g) => g.label === 'main');
    expect(mainGroup?.sessions).toHaveLength(2);
  });

  it("uses 'No branch' when gitBranch is null", () => {
    const sessions = [makeSession({ gitBranch: null })];
    const result = groupSessions(sessions, 'branch');
    expect(result[0]!.label).toBe('No branch');
  });

  it('groups are sorted alphabetically for workflow grouping', () => {
    const sessions = [
      makeSession({ workflowName: 'zzz' }),
      makeSession({ workflowName: 'aaa' }),
    ];
    const result = groupSessions(sessions, 'workflow');
    expect(result[0]!.label).toBe('aaa');
    expect(result[1]!.label).toBe('zzz');
  });

  it('does not mutate the input array', () => {
    const sessions = [makeSession(), makeSession()];
    const originalIds = sessions.map((s) => s.sessionId);
    groupSessions(sessions, 'status');
    expect(sessions.map((s) => s.sessionId)).toEqual(originalIds);
  });

  it('returns single group for empty input with groupBy none', () => {
    const result = groupSessions([], 'none');
    expect(result).toHaveLength(1);
    expect(result[0]!.sessions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// computeStatusCounts
// ---------------------------------------------------------------------------

describe('computeStatusCounts', () => {
  it("'all' count equals the total session count", () => {
    const sessions = [makeSession(), makeSession(), makeSession()];
    const counts = computeStatusCounts(sessions);
    expect(counts['all']).toBe(3);
  });

  it('counts each status correctly', () => {
    const sessions = [
      makeSession({ status: 'in_progress' }),
      makeSession({ status: 'in_progress' }),
      makeSession({ status: 'complete' }),
      makeSession({ status: 'blocked' }),
    ];
    const counts = computeStatusCounts(sessions);
    expect(counts['in_progress']).toBe(2);
    expect(counts['complete']).toBe(1);
    expect(counts['blocked']).toBe(1);
  });

  it("statuses not present are 0 via ?? fallback", () => {
    const sessions = [makeSession({ status: 'complete' })];
    const counts = computeStatusCounts(sessions);
    // in_progress not present -- should be undefined (falsy), not explicitly 0
    expect(counts['in_progress'] ?? 0).toBe(0);
  });

  it('returns { all: 0 } for empty list', () => {
    const counts = computeStatusCounts([]);
    expect(counts['all']).toBe(0);
  });

  it('includes dormant status', () => {
    const sessions = [makeSession({ status: 'dormant' })];
    const counts = computeStatusCounts(sessions);
    expect(counts['dormant']).toBe(1);
    expect(counts['all']).toBe(1);
  });

  it('includes complete_with_gaps status', () => {
    const sessions = [makeSession({ status: 'complete_with_gaps' })];
    const counts = computeStatusCounts(sessions);
    expect(counts['complete_with_gaps']).toBe(1);
  });

  it('does not mutate the input array', () => {
    const sessions = [makeSession(), makeSession()];
    const originalIds = sessions.map((s) => s.sessionId);
    computeStatusCounts(sessions);
    expect(sessions.map((s) => s.sessionId)).toEqual(originalIds);
  });
});
