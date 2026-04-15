/**
 * Unit tests for ghost node positioning in lineage-dag-layout.ts.
 *
 * Pure function tests -- no DOM, no React, no mocks.
 *
 * Covers:
 *   - positionGhostNodes: ghost column position, vertical stacking, requiredWidth
 */
import { describe, it, expect } from 'vitest';
import {
  positionGhostNodes,
  buildLineageDagModel,
  LINEAGE_SCROLL_OVERHANG,
  LINEAGE_PADDING,
  LINEAGE_COLUMN_WIDTH,
  LINEAGE_ROW_HEIGHT,
  ACTIVE_NODE_WIDTH,
} from '../../console/src/lib/lineage-dag-layout';
import type { ConsoleDagRun, ConsoleDagNode, ConsoleGhostStep } from '../../console/src/api/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<ConsoleDagNode> & { nodeId: string }): ConsoleDagNode {
  return {
    nodeKind: 'step',
    parentNodeId: null,
    createdAtEventIndex: 0,
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
    tipNodeIds: preferredTipNodeId ? [preferredTipNodeId] : [],
    status: 'complete',
    hasUnresolvedCriticalGaps: false,
    executionTraceSummary: null,
    skippedSteps: [],
  };
}

function makeGhostStep(stepId: string, stepLabel: string | null = null): ConsoleGhostStep {
  return { stepId, stepLabel };
}

// ---------------------------------------------------------------------------
// positionGhostNodes tests
// ---------------------------------------------------------------------------

describe('positionGhostNodes', () => {
  it('returns empty layout when skippedSteps is empty', () => {
    const node = makeNode({ nodeId: 'node-1', isPreferredTip: true, isTip: true });
    const run = makeRun([node], 'node-1');
    const model = buildLineageDagModel(run);
    const layout = positionGhostNodes([], model);

    expect(layout.nodes).toHaveLength(0);
    expect(layout.requiredWidth).toBe(0);
  });

  it('returns empty layout when model has no active lineage nodes', () => {
    const run = makeRun([]);
    const model = buildLineageDagModel(run);
    const layout = positionGhostNodes([makeGhostStep('step-1')], model);

    expect(layout.nodes).toHaveLength(0);
    expect(layout.requiredWidth).toBe(0);
  });

  it('places a single ghost node at depth = maxActiveDepth + 1', () => {
    // Create a single active lineage node at depth 0
    const node = makeNode({ nodeId: 'node-1', isPreferredTip: true, isTip: true });
    const run = makeRun([node], 'node-1');
    const model = buildLineageDagModel(run);

    // maxActiveDepth = 0, ghostDepth = 1
    const ghostDepth = 1;
    const expectedX = LINEAGE_SCROLL_OVERHANG + LINEAGE_PADDING + ghostDepth * LINEAGE_COLUMN_WIDTH;
    const expectedY = LINEAGE_PADDING; // first ghost, index 0

    const layout = positionGhostNodes([makeGhostStep('skipped-step')], model);

    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0]!.x).toBe(expectedX);
    expect(layout.nodes[0]!.y).toBe(expectedY);
    expect(layout.nodes[0]!.stepId).toBe('skipped-step');
  });

  it('stacks multiple ghost nodes vertically (same X, incrementing Y)', () => {
    const node = makeNode({ nodeId: 'node-1', isPreferredTip: true, isTip: true });
    const run = makeRun([node], 'node-1');
    const model = buildLineageDagModel(run);

    const steps = [makeGhostStep('step-a'), makeGhostStep('step-b'), makeGhostStep('step-c')];
    const layout = positionGhostNodes(steps, model);

    expect(layout.nodes).toHaveLength(3);

    // All at the same X
    const xValues = layout.nodes.map((n) => n.x);
    expect(new Set(xValues).size).toBe(1);

    // Y increments by LINEAGE_ROW_HEIGHT
    expect(layout.nodes[0]!.y).toBe(LINEAGE_PADDING);
    expect(layout.nodes[1]!.y).toBe(LINEAGE_PADDING + LINEAGE_ROW_HEIGHT);
    expect(layout.nodes[2]!.y).toBe(LINEAGE_PADDING + 2 * LINEAGE_ROW_HEIGHT);
  });

  it('preserves stepId and stepLabel on positioned nodes', () => {
    const node = makeNode({ nodeId: 'node-1', isPreferredTip: true, isTip: true });
    const run = makeRun([node], 'node-1');
    const model = buildLineageDagModel(run);

    const layout = positionGhostNodes([makeGhostStep('phase-2', 'Phase 2: Explore')], model);

    expect(layout.nodes[0]!.stepId).toBe('phase-2');
    expect(layout.nodes[0]!.stepLabel).toBe('Phase 2: Explore');
  });

  it('requiredWidth accounts for the ghost column with right overhang', () => {
    const node = makeNode({ nodeId: 'node-1', isPreferredTip: true, isTip: true });
    const run = makeRun([node], 'node-1');
    const model = buildLineageDagModel(run);

    const ghostDepth = 1;
    const ghostX = LINEAGE_SCROLL_OVERHANG + LINEAGE_PADDING + ghostDepth * LINEAGE_COLUMN_WIDTH;
    const expectedRequiredWidth = ghostX + ACTIVE_NODE_WIDTH + LINEAGE_SCROLL_OVERHANG;

    const layout = positionGhostNodes([makeGhostStep('step-1')], model);
    expect(layout.requiredWidth).toBe(expectedRequiredWidth);
  });

  it('requiredWidth exceeds model graphWidth for a simple single-node active lineage', () => {
    // This verifies that callers must use Math.max(model.graphWidth, layout.requiredWidth)
    const node = makeNode({ nodeId: 'node-1', isPreferredTip: true, isTip: true });
    const run = makeRun([node], 'node-1');
    const model = buildLineageDagModel(run);

    const layout = positionGhostNodes([makeGhostStep('step-1')], model);
    expect(layout.requiredWidth).toBeGreaterThan(model.graphWidth);
  });

  it('ghost depth is anchored to maxActiveDepth (longest active lineage chain)', () => {
    // Create a 3-node active lineage: node-1 -> node-2 -> node-3 (depths 0, 1, 2)
    const node1 = makeNode({ nodeId: 'node-1', parentNodeId: null, createdAtEventIndex: 0, isTip: false, isPreferredTip: false });
    const node2 = makeNode({ nodeId: 'node-2', parentNodeId: 'node-1', createdAtEventIndex: 1, isTip: false, isPreferredTip: false });
    const node3 = makeNode({ nodeId: 'node-3', parentNodeId: 'node-2', createdAtEventIndex: 2, isTip: true, isPreferredTip: true });
    const edges = [
      { edgeKind: 'acked_step' as const, fromNodeId: 'node-1', toNodeId: 'node-2', createdAtEventIndex: 1 },
      { edgeKind: 'acked_step' as const, fromNodeId: 'node-2', toNodeId: 'node-3', createdAtEventIndex: 2 },
    ];
    const run: ConsoleDagRun = { ...makeRun([node1, node2, node3], 'node-3'), edges, tipNodeIds: ['node-3'] };
    const model = buildLineageDagModel(run);

    // maxActiveDepth = 2 (node-3), ghostDepth = 3
    const ghostDepth = 3;
    const expectedX = LINEAGE_SCROLL_OVERHANG + LINEAGE_PADDING + ghostDepth * LINEAGE_COLUMN_WIDTH;

    const layout = positionGhostNodes([makeGhostStep('skipped-phase')], model);
    expect(layout.nodes[0]!.x).toBe(expectedX);
  });

  it('handles null stepLabel gracefully', () => {
    const node = makeNode({ nodeId: 'node-1', isPreferredTip: true, isTip: true });
    const run = makeRun([node], 'node-1');
    const model = buildLineageDagModel(run);

    const layout = positionGhostNodes([makeGhostStep('step-1', null)], model);
    expect(layout.nodes[0]!.stepLabel).toBeNull();
  });
});
