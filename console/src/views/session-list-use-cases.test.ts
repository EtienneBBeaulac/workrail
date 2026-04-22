/**
 * Unit tests for session-list-use-cases.ts -- buildSessionTree().
 */
import { describe, it, expect } from 'vitest';
import { buildSessionTree } from './session-list-use-cases';
import type { ConsoleSessionSummary } from '../api/types';

function makeSession(overrides: Partial<ConsoleSessionSummary> = {}): ConsoleSessionSummary {
  return {
    sessionId: `sess-${Math.random().toString(36).slice(2, 10)}`,
    sessionTitle: 'Test session',
    workflowId: 'wf-coding',
    workflowName: 'Coding Task',
    workflowHash: null,
    runId: null,
    status: 'complete',
    health: 'healthy',
    nodeCount: 3,
    edgeCount: 2,
    tipCount: 1,
    hasUnresolvedGaps: false,
    recapSnippet: null,
    gitBranch: 'main',
    repoRoot: '/repos/myapp',
    lastModifiedMs: Date.now(),
    isAutonomous: false,
    isLive: false,
    parentSessionId: null,
    metrics: null,
    ...overrides,
  };
}

describe('buildSessionTree', () => {
  it('empty input returns empty tree', () => {
    const result = buildSessionTree([]);
    expect(result.roots).toHaveLength(0);
    expect(result.orphanChildIds.size).toBe(0);
  });

  it('all root sessions -- all appear as roots with no children', () => {
    const sessions = [
      makeSession({ sessionId: 'sess-a', parentSessionId: null }),
      makeSession({ sessionId: 'sess-b', parentSessionId: null }),
    ];
    const result = buildSessionTree(sessions);
    expect(result.roots).toHaveLength(2);
    expect(result.roots.every((n) => n.children.length === 0)).toBe(true);
  });

  it('one coordinator with two children', () => {
    const coordinator = makeSession({ sessionId: 'coord', parentSessionId: null });
    const child1 = makeSession({ sessionId: 'child1', parentSessionId: 'coord' });
    const child2 = makeSession({ sessionId: 'child2', parentSessionId: 'coord' });
    const result = buildSessionTree([coordinator, child1, child2]);
    expect(result.roots).toHaveLength(1);
    expect(result.roots[0].session.sessionId).toBe('coord');
    expect(result.roots[0].children).toHaveLength(2);
  });

  it('orphaned child appears as root', () => {
    const child = makeSession({ sessionId: 'orphan', parentSessionId: 'missing-parent' });
    const result = buildSessionTree([child]);
    expect(result.roots).toHaveLength(1);
    expect(result.orphanChildIds.has('orphan')).toBe(true);
  });

  it('cycle detection: self-parent treated as root', () => {
    const cyclic = makeSession({ sessionId: 'cyclic', parentSessionId: 'cyclic' });
    const result = buildSessionTree([cyclic]);
    expect(result.roots).toHaveLength(1);
    expect(result.roots[0].session.sessionId).toBe('cyclic');
    expect(result.orphanChildIds.has('cyclic')).toBe(false);
  });

  it('multiple coordinators with independent children', () => {
    const c1 = makeSession({ sessionId: 'c1' });
    const c2 = makeSession({ sessionId: 'c2' });
    const ch1 = makeSession({ sessionId: 'ch1', parentSessionId: 'c1' });
    const ch2 = makeSession({ sessionId: 'ch2', parentSessionId: 'c2' });
    const result = buildSessionTree([c1, c2, ch1, ch2]);
    expect(result.roots).toHaveLength(2);
    const rootMap = new Map(result.roots.map((n) => [n.session.sessionId, n]));
    expect(rootMap.get('c1')?.children).toHaveLength(1);
    expect(rootMap.get('c2')?.children).toHaveLength(1);
  });

  it('input order preserved for children', () => {
    const coord = makeSession({ sessionId: 'coord' });
    const ch1 = makeSession({ sessionId: 'ch1', parentSessionId: 'coord' });
    const ch2 = makeSession({ sessionId: 'ch2', parentSessionId: 'coord' });
    const result = buildSessionTree([coord, ch2, ch1]);
    expect(result.roots[0].children.map((c) => c.sessionId)).toEqual(['ch2', 'ch1']);
  });

  it('mix of root, child, and orphan', () => {
    const root = makeSession({ sessionId: 'root' });
    const child = makeSession({ sessionId: 'child', parentSessionId: 'root' });
    const orphan = makeSession({ sessionId: 'orphan', parentSessionId: 'missing' });
    const result = buildSessionTree([root, child, orphan]);
    expect(result.roots).toHaveLength(2);
    expect(result.orphanChildIds.has('orphan')).toBe(true);
  });
});
