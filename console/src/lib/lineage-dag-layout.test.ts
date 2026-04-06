import { describe, it, expect } from 'vitest';
import {
  buildLineageDagModel,
  shortNodeId,
  LINEAGE_COLUMN_WIDTH,
  LINEAGE_PADDING,
} from './lineage-dag-layout';
import type { ConsoleDagNode, ConsoleDagRun } from '../api/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _eventIndex = 0;

function makeNode(
  nodeId: string,
  parentNodeId: string | null,
  overrides: Partial<ConsoleDagNode> = {},
): ConsoleDagNode {
  return {
    nodeId,
    nodeKind: 'step',
    parentNodeId,
    createdAtEventIndex: _eventIndex++,
    isPreferredTip: false,
    isTip: false,
    stepLabel: null,
    ...overrides,
  };
}

function makeRun(nodes: ConsoleDagNode[], preferredTipNodeId: string | null = null): ConsoleDagRun {
  return {
    runId: 'run-1',
    workflowId: null,
    workflowName: null,
    workflowHash: null,
    preferredTipNodeId,
    nodes,
    edges: [],
    tipNodeIds: [],
    status: 'complete',
    hasUnresolvedCriticalGaps: false,
    executionTraceSummary: null,
  };
}

function nodeByIdMap(model: ReturnType<typeof buildLineageDagModel>) {
  return new Map(model.nodes.map((n) => [n.node.nodeId, n]));
}

// ---------------------------------------------------------------------------
// Empty run
// ---------------------------------------------------------------------------

describe('empty run', () => {
  it('returns a zero-node model with null IDs', () => {
    const model = buildLineageDagModel(makeRun([]));
    expect(model.nodes).toHaveLength(0);
    expect(model.currentNodeId).toBeNull();
    expect(model.startNodeId).toBeNull();
    expect(model.summary.lineageNodeCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Linear lineage (no branches)
// ---------------------------------------------------------------------------

describe('linear lineage', () => {
  it('places nodes left-to-right at depth 0,1,2 on lane 0', () => {
    _eventIndex = 0;
    const a = makeNode('a', null);
    const b = makeNode('b', 'a');
    const c = makeNode('c', 'b', { isPreferredTip: true, isTip: true });
    const model = buildLineageDagModel(makeRun([a, b, c], 'c'));
    const byId = nodeByIdMap(model);

    expect(byId.get('a')!.depth).toBe(0);
    expect(byId.get('b')!.depth).toBe(1);
    expect(byId.get('c')!.depth).toBe(2);

    expect(byId.get('a')!.lane).toBe(0);
    expect(byId.get('b')!.lane).toBe(0);
    expect(byId.get('c')!.lane).toBe(0);

    expect(byId.get('a')!.isActiveLineage).toBe(true);
    expect(byId.get('c')!.isCurrent).toBe(true);
  });

  it('computes x positions as PADDING + depth * COLUMN_WIDTH', () => {
    _eventIndex = 0;
    const nodes = [makeNode('a', null), makeNode('b', 'a', { isTip: true })];
    const model = buildLineageDagModel(makeRun(nodes, 'b'));
    const byId = nodeByIdMap(model);

    expect(byId.get('a')!.x).toBe(LINEAGE_PADDING);
    expect(byId.get('b')!.x).toBe(LINEAGE_PADDING + LINEAGE_COLUMN_WIDTH);
  });

  it('sets correct summary counts for a linear run', () => {
    _eventIndex = 0;
    const nodes = [makeNode('a', null), makeNode('b', 'a'), makeNode('c', 'b', { isTip: true })];
    const model = buildLineageDagModel(makeRun(nodes, 'c'));

    expect(model.summary.lineageNodeCount).toBe(3);
    expect(model.summary.sideNodeCount).toBe(0);
    expect(model.summary.alternateBranchCount).toBe(0);
    expect(model.summary.blockedAttemptCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Side branches (alternate and blocked)
// ---------------------------------------------------------------------------

describe('side branches', () => {
  it('assigns alternate branches to non-zero lanes', () => {
    _eventIndex = 0;
    // a -> b (active) and a -> alt (alternate branch)
    const a = makeNode('a', null);
    const b = makeNode('b', 'a', { isTip: true });
    const alt = makeNode('alt', 'a', { nodeKind: 'step' });
    const model = buildLineageDagModel(makeRun([a, b, alt], 'b'));
    const byId = nodeByIdMap(model);

    expect(byId.get('b')!.lane).toBe(0);
    expect(byId.get('alt')!.lane).not.toBe(0);
    expect(byId.get('alt')!.branchKind).toBe('alternate');
    expect(byId.get('alt')!.isActiveLineage).toBe(false);
  });

  it('marks blocked_attempt nodes as branchKind blocked', () => {
    _eventIndex = 0;
    const a = makeNode('a', null);
    const b = makeNode('b', 'a', { isTip: true });
    const blocked = makeNode('blocked', 'a', { nodeKind: 'blocked_attempt' });
    const model = buildLineageDagModel(makeRun([a, b, blocked], 'b'));
    const byId = nodeByIdMap(model);

    expect(byId.get('blocked')!.branchKind).toBe('blocked');
  });

  it('counts branches correctly in summary', () => {
    _eventIndex = 0;
    const a = makeNode('a', null);
    const b = makeNode('b', 'a', { isTip: true });
    const alt = makeNode('alt', 'a');
    const blocked = makeNode('bl', 'a', { nodeKind: 'blocked_attempt' });
    const model = buildLineageDagModel(makeRun([a, b, alt, blocked], 'b'));

    expect(model.summary.alternateBranchCount).toBe(1);
    expect(model.summary.blockedAttemptCount).toBe(1);
    expect(model.summary.sideNodeCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Side branch x alignment (F1 bug -- the critical regression)
// ---------------------------------------------------------------------------

describe('side branch x alignment with compression', () => {
  it('side branch x == parent active-lineage x + COLUMN_WIDTH (no compression)', () => {
    // a -> b -> c (active), b -> side
    // With 3 nodes there is no compression. side should be at depth 2 (parent b is depth 1).
    _eventIndex = 0;
    const a = makeNode('a', null);
    const b = makeNode('b', 'a');
    const c = makeNode('c', 'b', { isTip: true });
    const side = makeNode('side', 'b');
    const model = buildLineageDagModel(makeRun([a, b, c, side], 'c'));
    const byId = nodeByIdMap(model);

    // b is at visible depth 1, so side should be at visible depth 2
    expect(byId.get('side')!.depth).toBe(byId.get('b')!.depth + 1);
    expect(byId.get('side')!.x).toBe(byId.get('b')!.x + LINEAGE_COLUMN_WIDTH);
  });

  it('side branch x aligns to compressed parent, not raw depth (F1)', () => {
    // Build a lineage longer than the 8-node window so compression kicks in.
    // Then attach a side branch to a node that gets compressed away from its raw depth.
    _eventIndex = 0;
    const lineage: ConsoleDagNode[] = [];
    let prev: string | null = null;
    for (let i = 0; i < 10; i++) {
      const id = `n${i}`;
      lineage.push(makeNode(id, prev));
      prev = id;
    }
    // Mark last node as current
    lineage[9] = { ...lineage[9], isTip: true, isPreferredTip: true };

    // Attach a side branch to node n5 (raw depth 5, which will be compressed)
    const side = makeNode('side', 'n5');
    const run = makeRun([...lineage, side], 'n9');
    const model = buildLineageDagModel(run);
    const byId = nodeByIdMap(model);

    expect(model.compressedBeforeCount).toBeGreaterThan(0);

    // side branch must be exactly one column to the right of its parent n5
    const n5Depth = byId.get('n5')!.depth;
    const sideDepth = byId.get('side')!.depth;
    expect(sideDepth).toBe(n5Depth + 1);
    expect(byId.get('side')!.x).toBe(byId.get('n5')!.x + LINEAGE_COLUMN_WIDTH);
  });

  it('deeply nested side subtree aligns correctly under compression', () => {
    // 10-node lineage (triggers compression) + 3-node side chain hanging off n4
    _eventIndex = 0;
    const lineage: ConsoleDagNode[] = [];
    let prev: string | null = null;
    for (let i = 0; i < 10; i++) {
      const id = `n${i}`;
      lineage.push(makeNode(id, prev));
      prev = id;
    }
    lineage[9] = { ...lineage[9], isTip: true, isPreferredTip: true };

    const s1 = makeNode('s1', 'n4');
    const s2 = makeNode('s2', 's1');
    const s3 = makeNode('s3', 's2');
    const run = makeRun([...lineage, s1, s2, s3], 'n9');
    const model = buildLineageDagModel(run);
    const byId = nodeByIdMap(model);

    expect(byId.get('s2')!.depth).toBe(byId.get('s1')!.depth + 1);
    expect(byId.get('s3')!.depth).toBe(byId.get('s2')!.depth + 1);
    expect(byId.get('s3')!.x).toBe(byId.get('s2')!.x + LINEAGE_COLUMN_WIDTH);
  });
});

// ---------------------------------------------------------------------------
// Lineage compression (window = 8)
// ---------------------------------------------------------------------------

describe('lineage compression', () => {
  it('compressedBeforeCount is 0 for runs with <= 8 active nodes', () => {
    _eventIndex = 0;
    const nodes: ConsoleDagNode[] = [];
    let prev: string | null = null;
    for (let i = 0; i < 8; i++) {
      nodes.push(makeNode(`n${i}`, prev));
      prev = `n${i}`;
    }
    nodes[7] = { ...nodes[7], isTip: true };
    const model = buildLineageDagModel(makeRun(nodes, 'n7'));
    expect(model.compressedBeforeCount).toBe(0);
  });

  it('compressedBeforeCount = lineageLength - 8 for runs longer than 8', () => {
    _eventIndex = 0;
    const nodes: ConsoleDagNode[] = [];
    let prev: string | null = null;
    for (let i = 0; i < 12; i++) {
      nodes.push(makeNode(`n${i}`, prev));
      prev = `n${i}`;
    }
    nodes[11] = { ...nodes[11], isTip: true };
    const model = buildLineageDagModel(makeRun(nodes, 'n11'));
    expect(model.compressedBeforeCount).toBe(4);
  });

  it('visible nodes start at depth 1 (not raw depth) when compressed', () => {
    _eventIndex = 0;
    const nodes: ConsoleDagNode[] = [];
    let prev: string | null = null;
    for (let i = 0; i < 10; i++) {
      nodes.push(makeNode(`n${i}`, prev));
      prev = `n${i}`;
    }
    nodes[9] = { ...nodes[9], isTip: true };
    const model = buildLineageDagModel(makeRun(nodes, 'n9'));
    const byId = nodeByIdMap(model);

    // With 10 nodes, compressedBeforeCount = 2.
    // n2 is the first visible active node -- its visible depth should be 1.
    expect(model.compressedBeforeCount).toBe(2);
    expect(byId.get('n2')!.depth).toBe(1);
    expect(byId.get('n9')!.depth).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Current node selection
// ---------------------------------------------------------------------------

describe('current node selection', () => {
  it('uses preferredTipNodeId when set on run', () => {
    _eventIndex = 0;
    const nodes = [makeNode('a', null), makeNode('b', 'a'), makeNode('c', 'b')];
    const model = buildLineageDagModel(makeRun(nodes, 'b'));
    expect(model.currentNodeId).toBe('b');
  });

  it('falls back to isPreferredTip node when preferredTipNodeId is null', () => {
    _eventIndex = 0;
    const nodes = [
      makeNode('a', null),
      makeNode('b', 'a', { isPreferredTip: true, isTip: true }),
      makeNode('c', 'b'),
    ];
    const model = buildLineageDagModel(makeRun(nodes, null));
    expect(model.currentNodeId).toBe('b');
  });

  it('marks the current node with isCurrent=true', () => {
    _eventIndex = 0;
    const nodes = [makeNode('a', null), makeNode('b', 'a', { isTip: true })];
    const model = buildLineageDagModel(makeRun(nodes, 'b'));
    const byId = nodeByIdMap(model);
    expect(byId.get('a')!.isCurrent).toBe(false);
    expect(byId.get('b')!.isCurrent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cycle safety
// ---------------------------------------------------------------------------

describe('cycle safety', () => {
  it('does not hang when parentNodeId forms a cycle (collectActiveLineageIds)', () => {
    // a -> b -> a  (cycle)
    _eventIndex = 0;
    const a: ConsoleDagNode = { nodeId: 'a', nodeKind: 'step', parentNodeId: 'b', createdAtEventIndex: 0, isPreferredTip: false, isTip: false, stepLabel: null };
    const b: ConsoleDagNode = { nodeId: 'b', nodeKind: 'step', parentNodeId: 'a', createdAtEventIndex: 1, isPreferredTip: true, isTip: true, stepLabel: null };
    // Should complete without stack overflow
    expect(() => buildLineageDagModel(makeRun([a, b], 'b'))).not.toThrow();
  });

  it('does not hang when parentNodeId forms a cycle (resolveDepth)', () => {
    _eventIndex = 0;
    const x: ConsoleDagNode = { nodeId: 'x', nodeKind: 'step', parentNodeId: 'y', createdAtEventIndex: 0, isPreferredTip: false, isTip: false, stepLabel: null };
    const y: ConsoleDagNode = { nodeId: 'y', nodeKind: 'step', parentNodeId: 'x', createdAtEventIndex: 1, isPreferredTip: true, isTip: true, stepLabel: null };
    expect(() => buildLineageDagModel(makeRun([x, y], 'y'))).not.toThrow();
  });

  it('does not hang when side branch has a parentNodeId cycle (resolveSideDepth)', () => {
    // Active: a -> b -> c. Side branch: s1 -> s2 -> s1 (cycle among side nodes)
    _eventIndex = 0;
    const a = makeNode('a', null);
    const b = makeNode('b', 'a');
    const c = makeNode('c', 'b', { isTip: true });
    const s1: ConsoleDagNode = { nodeId: 's1', nodeKind: 'step', parentNodeId: 's2', createdAtEventIndex: _eventIndex++, isPreferredTip: false, isTip: false, stepLabel: null };
    const s2: ConsoleDagNode = { nodeId: 's2', nodeKind: 'step', parentNodeId: 's1', createdAtEventIndex: _eventIndex++, isPreferredTip: false, isTip: false, stepLabel: null };
    expect(() => buildLineageDagModel(makeRun([a, b, c, s1, s2], 'c'))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Graph dimensions
// ---------------------------------------------------------------------------

describe('graph dimensions', () => {
  it('graphWidth grows with more nodes', () => {
    _eventIndex = 0;
    const short = [makeNode('a', null), makeNode('b', 'a', { isTip: true })];
    const long = [...short, makeNode('c', 'b'), makeNode('d', 'c', { isTip: true })];
    const shortModel = buildLineageDagModel(makeRun(short, 'b'));
    // reset so long nodes get fresh indices
    const longModel = buildLineageDagModel(makeRun(long, 'd'));
    expect(longModel.graphWidth).toBeGreaterThan(shortModel.graphWidth);
  });
});

// ---------------------------------------------------------------------------
// shortNodeId
// ---------------------------------------------------------------------------

describe('shortNodeId', () => {
  it('returns last 8 characters', () => {
    expect(shortNodeId('abc-def-ghijklmn')).toBe('ghijklmn');
    expect(shortNodeId('abcdefgh')).toBe('abcdefgh');
    expect(shortNodeId('123456789')).toBe('23456789');
  });
});
