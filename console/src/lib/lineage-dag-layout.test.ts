import { describe, it, expect } from 'vitest';
import {
  buildLineageDagModel,
  shortNodeId,
  LINEAGE_COLUMN_WIDTH,
  LINEAGE_PADDING,
  LINEAGE_SCROLL_OVERHANG,
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
    hasRecap: false,
    hasFailedValidations: false,
    hasGaps: false,
    hasArtifacts: false,
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
    skippedSteps: [],
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

    expect(byId.get('a')!.x).toBe(LINEAGE_SCROLL_OVERHANG + LINEAGE_PADDING);
    expect(byId.get('b')!.x).toBe(LINEAGE_SCROLL_OVERHANG + LINEAGE_PADDING + LINEAGE_COLUMN_WIDTH);
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
// All nodes rendered (no windowing)
// ---------------------------------------------------------------------------

describe('all nodes rendered', () => {
  it('renders all active-lineage nodes regardless of run length', () => {
    _eventIndex = 0;
    const nodes: ConsoleDagNode[] = [];
    let prev: string | null = null;
    for (let i = 0; i < 37; i++) {
      nodes.push(makeNode(`n${i}`, prev));
      prev = `n${i}`;
    }
    nodes[36] = { ...nodes[36], isTip: true };
    const model = buildLineageDagModel(makeRun(nodes, 'n36'));
    const renderedIds = new Set(model.nodes.map((n) => n.node.nodeId));

    for (let i = 0; i < 37; i++) {
      expect(renderedIds.has(`n${i}`)).toBe(true);
    }
  });

  it('renders side branches of any active-lineage node', () => {
    _eventIndex = 0;
    const nodes: ConsoleDagNode[] = [];
    let prev: string | null = null;
    for (let i = 0; i < 10; i++) {
      nodes.push(makeNode(`n${i}`, prev));
      prev = `n${i}`;
    }
    nodes[9] = { ...nodes[9], isTip: true };
    const side = makeNode('side-of-n1', 'n1');
    const model = buildLineageDagModel(makeRun([...nodes, side], 'n9'));
    const renderedIds = new Set(model.nodes.map((n) => n.node.nodeId));

    expect(renderedIds.has('side-of-n1')).toBe(true);
  });

  it('active-lineage nodes have monotonically increasing x (regression: edges-from-both-sides bug)', () => {
    _eventIndex = 0;
    const nodes: ConsoleDagNode[] = [];
    let prev: string | null = null;
    for (let i = 0; i < 37; i++) {
      nodes.push(makeNode(`n${i}`, prev));
      prev = `n${i}`;
    }
    nodes[36] = { ...nodes[36], isTip: true };
    const model = buildLineageDagModel(makeRun(nodes, 'n36'));
    const activeNodes = model.nodes
      .filter((n) => n.isActiveLineage)
      .sort((a, b) => a.depth - b.depth);

    for (let i = 1; i < activeNodes.length; i++) {
      expect(activeNodes[i]!.x).toBeGreaterThan(activeNodes[i - 1]!.x);
    }
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

  it('side branch x == parent active-lineage x + COLUMN_WIDTH (long run)', () => {
    // 10-node lineage, side branch off n5
    _eventIndex = 0;
    const lineage: ConsoleDagNode[] = [];
    let prev: string | null = null;
    for (let i = 0; i < 10; i++) {
      const id = `n${i}`;
      lineage.push(makeNode(id, prev));
      prev = id;
    }
    lineage[9] = { ...lineage[9], isTip: true, isPreferredTip: true };

    const side = makeNode('side', 'n5');
    const model = buildLineageDagModel(makeRun([...lineage, side], 'n9'));
    const byId = nodeByIdMap(model);

    // side branch must be exactly one column to the right of n5
    expect(byId.get('side')!.depth).toBe(byId.get('n5')!.depth + 1);
    expect(byId.get('side')!.x).toBe(byId.get('n5')!.x + LINEAGE_COLUMN_WIDTH);
  });

  it('deeply nested side subtree aligns correctly', () => {
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
    const model = buildLineageDagModel(makeRun([...lineage, s1, s2, s3], 'n9'));
    const byId = nodeByIdMap(model);

    expect(byId.get('s2')!.depth).toBe(byId.get('s1')!.depth + 1);
    expect(byId.get('s3')!.depth).toBe(byId.get('s2')!.depth + 1);
    expect(byId.get('s3')!.x).toBe(byId.get('s2')!.x + LINEAGE_COLUMN_WIDTH);
  });
});

// ---------------------------------------------------------------------------
// No windowing -- all nodes rendered
// ---------------------------------------------------------------------------

describe('no windowing', () => {
  it('node depths equal raw depths (no offset applied)', () => {
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

    for (let i = 0; i < 10; i++) {
      expect(byId.get(`n${i}`)!.depth).toBe(i);
    }
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
    const a: ConsoleDagNode = { nodeId: 'a', nodeKind: 'step', parentNodeId: 'b', createdAtEventIndex: 0, isPreferredTip: false, isTip: false, stepLabel: null, hasRecap: false, hasFailedValidations: false, hasGaps: false, hasArtifacts: false };
    const b: ConsoleDagNode = { nodeId: 'b', nodeKind: 'step', parentNodeId: 'a', createdAtEventIndex: 1, isPreferredTip: true, isTip: true, stepLabel: null, hasRecap: false, hasFailedValidations: false, hasGaps: false, hasArtifacts: false };
    // Should complete without stack overflow
    expect(() => buildLineageDagModel(makeRun([a, b], 'b'))).not.toThrow();
  });

  it('does not hang when parentNodeId forms a cycle (resolveDepth)', () => {
    _eventIndex = 0;
    const x: ConsoleDagNode = { nodeId: 'x', nodeKind: 'step', parentNodeId: 'y', createdAtEventIndex: 0, isPreferredTip: false, isTip: false, stepLabel: null, hasRecap: false, hasFailedValidations: false, hasGaps: false, hasArtifacts: false };
    const y: ConsoleDagNode = { nodeId: 'y', nodeKind: 'step', parentNodeId: 'x', createdAtEventIndex: 1, isPreferredTip: true, isTip: true, stepLabel: null, hasRecap: false, hasFailedValidations: false, hasGaps: false, hasArtifacts: false };
    expect(() => buildLineageDagModel(makeRun([x, y], 'y'))).not.toThrow();
  });

  it('does not hang when side branch has a parentNodeId cycle (resolveSideDepth)', () => {
    // Active: a -> b -> c. Side branch: s1 -> s2 -> s1 (cycle among side nodes)
    _eventIndex = 0;
    const a = makeNode('a', null);
    const b = makeNode('b', 'a');
    const c = makeNode('c', 'b', { isTip: true });
    const s1: ConsoleDagNode = { nodeId: 's1', nodeKind: 'step', parentNodeId: 's2', createdAtEventIndex: _eventIndex++, isPreferredTip: false, isTip: false, stepLabel: null, hasRecap: false, hasFailedValidations: false, hasGaps: false, hasArtifacts: false };
    const s2: ConsoleDagNode = { nodeId: 's2', nodeKind: 'step', parentNodeId: 's1', createdAtEventIndex: _eventIndex++, isPreferredTip: false, isTip: false, stepLabel: null, hasRecap: false, hasFailedValidations: false, hasGaps: false, hasArtifacts: false };
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
