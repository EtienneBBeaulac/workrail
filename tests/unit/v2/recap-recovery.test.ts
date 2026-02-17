import { describe, it, expect } from 'vitest';
import { collectAncestryRecap, collectDownstreamRecap, buildChildSummary } from '../../../src/v2/durable-core/domain/recap-recovery.js';

describe('recap-recovery', () => {
  it('buildChildSummary returns empty for no children', () => {
    const dag = { edges: [], preferredTipNodeId: null, nodesById: {}, runId: 'run_1', workflowId: null, workflowHash: null, tipNodeIds: [] };
    const result = buildChildSummary({ nodeId: 'node_1', dag });
    expect(result).toBe('');
  });

  it('buildChildSummary shows count and preferred tip', () => {
    const dag = {
      edges: [{ fromNodeId: 'node_1', toNodeId: 'node_2', edgeKind: 'acked_step' as const, cause: { kind: 'idempotent_replay', eventId: 'e1' }, createdAtEventIndex: 1 }],
      preferredTipNodeId: 'node_2',
      nodesById: {},
      runId: 'run_1',
      workflowId: null,
      workflowHash: null,
      tipNodeIds: ['node_2'],
    };
    const result = buildChildSummary({ nodeId: 'node_1', dag });
    expect(result).toContain('1 child');
    expect(result).toContain('node_2');
  });

  it('collectAncestryRecap returns empty for root node', () => {
    const dag = { nodesById: { node_1: { nodeId: 'node_1', parentNodeId: null, nodeKind: 'step' as const, workflowHash: 'sha256:abc', snapshotRef: 'sha256:def', createdAtEventIndex: 0 } }, edges: [], preferredTipNodeId: null, runId: 'run_1', workflowId: null, workflowHash: null, tipNodeIds: [] };
    const outputs = { nodesById: {} };
    const result = collectAncestryRecap({ nodeId: 'node_1', dag, outputs, includeCurrentNode: false });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual([]);
    }
  });

  it('collectDownstreamRecap walks forward from fromNodeId to toNodeId', () => {
    // Setup: node_1 -> node_2 -> node_3 (linear chain)
    const dag = {
      nodesById: {
        node_1: { nodeId: 'node_1', parentNodeId: null, nodeKind: 'step' as const, workflowHash: 'sha256:abc', snapshotRef: 'sha256:1', createdAtEventIndex: 0 },
        node_2: { nodeId: 'node_2', parentNodeId: 'node_1', nodeKind: 'step' as const, workflowHash: 'sha256:abc', snapshotRef: 'sha256:2', createdAtEventIndex: 1 },
        node_3: { nodeId: 'node_3', parentNodeId: 'node_2', nodeKind: 'step' as const, workflowHash: 'sha256:abc', snapshotRef: 'sha256:3', createdAtEventIndex: 2 },
      },
      edges: [
        { fromNodeId: 'node_1', toNodeId: 'node_2', edgeKind: 'acked_step' as const, cause: { kind: 'idempotent_replay', eventId: 'e1' }, createdAtEventIndex: 1 },
        { fromNodeId: 'node_2', toNodeId: 'node_3', edgeKind: 'acked_step' as const, cause: { kind: 'idempotent_replay', eventId: 'e2' }, createdAtEventIndex: 2 },
      ],
      preferredTipNodeId: 'node_3',
      runId: 'run_1',
      workflowId: null,
      workflowHash: null,
      tipNodeIds: ['node_3'],
    };

    const outputs = {
      nodesById: {
        node_2: {
          historyByChannel: { recap: [{ outputId: 'out_2', outputChannel: 'recap' as const, payload: { payloadKind: 'notes' as const, notesMarkdown: 'Step 2 complete' }, createdAtEventIndex: 1 }], artifact: [] },
          currentByChannel: { recap: [{ outputId: 'out_2', outputChannel: 'recap' as const, payload: { payloadKind: 'notes' as const, notesMarkdown: 'Step 2 complete' }, createdAtEventIndex: 1 }], artifact: [] },
        },
        node_3: {
          historyByChannel: { recap: [{ outputId: 'out_3', outputChannel: 'recap' as const, payload: { payloadKind: 'notes' as const, notesMarkdown: 'Step 3 complete' }, createdAtEventIndex: 2 }], artifact: [] },
          currentByChannel: { recap: [{ outputId: 'out_3', outputChannel: 'recap' as const, payload: { payloadKind: 'notes' as const, notesMarkdown: 'Step 3 complete' }, createdAtEventIndex: 2 }], artifact: [] },
        },
      },
    };

    const result = collectDownstreamRecap({ fromNodeId: 'node_1', toNodeId: 'node_3', dag, outputs });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // Should collect in CHRONOLOGICAL order: node_2 then node_3
      expect(result.value).toEqual(['Step 2 complete', 'Step 3 complete']);
    }
  });

  it('collectDownstreamRecap returns empty when fromNodeId equals toNodeId', () => {
    const dag = {
      nodesById: { node_1: { nodeId: 'node_1', parentNodeId: null, nodeKind: 'step' as const, workflowHash: 'sha256:abc', snapshotRef: 'sha256:1', createdAtEventIndex: 0 } },
      edges: [],
      preferredTipNodeId: 'node_1',
      runId: 'run_1',
      workflowId: null,
      workflowHash: null,
      tipNodeIds: ['node_1'],
    };
    const outputs = { nodesById: {} };

    const result = collectDownstreamRecap({ fromNodeId: 'node_1', toNodeId: 'node_1', dag, outputs });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual([]);
    }
  });

  it('collectDownstreamRecap follows edges not parentNodeId (branch case)', () => {
    // Setup: node_1 has TWO children (node_2 and node_3)
    //        node_2 -> node_4 (preferred tip is node_4)
    //        node_3 (abandoned branch)
    // Current algorithm walks BACKWARDS from node_4 via parentNodeId, which works for linear chains
    // but this test verifies it follows the CORRECT path via edges
    const dag = {
      nodesById: {
        node_1: { nodeId: 'node_1', parentNodeId: null, nodeKind: 'step' as const, workflowHash: 'sha256:abc', snapshotRef: 'sha256:1', createdAtEventIndex: 0 },
        node_2: { nodeId: 'node_2', parentNodeId: 'node_1', nodeKind: 'step' as const, workflowHash: 'sha256:abc', snapshotRef: 'sha256:2', createdAtEventIndex: 1 },
        node_3: { nodeId: 'node_3', parentNodeId: 'node_1', nodeKind: 'step' as const, workflowHash: 'sha256:abc', snapshotRef: 'sha256:3', createdAtEventIndex: 2 },
        node_4: { nodeId: 'node_4', parentNodeId: 'node_2', nodeKind: 'step' as const, workflowHash: 'sha256:abc', snapshotRef: 'sha256:4', createdAtEventIndex: 3 },
      },
      edges: [
        { fromNodeId: 'node_1', toNodeId: 'node_2', edgeKind: 'acked_step' as const, cause: { kind: 'idempotent_replay', eventId: 'e1' }, createdAtEventIndex: 1 },
        { fromNodeId: 'node_1', toNodeId: 'node_3', edgeKind: 'acked_step' as const, cause: { kind: 'intentional_fork', eventId: 'e2' }, createdAtEventIndex: 2 },
        { fromNodeId: 'node_2', toNodeId: 'node_4', edgeKind: 'acked_step' as const, cause: { kind: 'idempotent_replay', eventId: 'e3' }, createdAtEventIndex: 3 },
      ],
      preferredTipNodeId: 'node_4',
      runId: 'run_1',
      workflowId: null,
      workflowHash: null,
      tipNodeIds: ['node_3', 'node_4'],
    };

    const outputs = {
      nodesById: {
        node_2: {
          historyByChannel: { recap: [{ outputId: 'out_2', outputChannel: 'recap' as const, payload: { payloadKind: 'notes' as const, notesMarkdown: 'Preferred path: Step 2' }, createdAtEventIndex: 1 }], artifact: [] },
          currentByChannel: { recap: [{ outputId: 'out_2', outputChannel: 'recap' as const, payload: { payloadKind: 'notes' as const, notesMarkdown: 'Preferred path: Step 2' }, createdAtEventIndex: 1 }], artifact: [] },
        },
        node_3: {
          historyByChannel: { recap: [{ outputId: 'out_3', outputChannel: 'recap' as const, payload: { payloadKind: 'notes' as const, notesMarkdown: 'WRONG BRANCH: Step 3' }, createdAtEventIndex: 2 }], artifact: [] },
          currentByChannel: { recap: [{ outputId: 'out_3', outputChannel: 'recap' as const, payload: { payloadKind: 'notes' as const, notesMarkdown: 'WRONG BRANCH: Step 3' }, createdAtEventIndex: 2 }], artifact: [] },
        },
        node_4: {
          historyByChannel: { recap: [{ outputId: 'out_4', outputChannel: 'recap' as const, payload: { payloadKind: 'notes' as const, notesMarkdown: 'Preferred path: Step 4' }, createdAtEventIndex: 3 }], artifact: [] },
          currentByChannel: { recap: [{ outputId: 'out_4', outputChannel: 'recap' as const, payload: { payloadKind: 'notes' as const, notesMarkdown: 'Preferred path: Step 4' }, createdAtEventIndex: 3 }], artifact: [] },
        },
      },
    };

    const result = collectDownstreamRecap({ fromNodeId: 'node_1', toNodeId: 'node_4', dag, outputs });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // Should get: node_2, node_4 (following the preferred path)
      // Should NOT get: node_3 (wrong branch)
      expect(result.value).toEqual(['Preferred path: Step 2', 'Preferred path: Step 4']);
      expect(result.value).not.toContain('WRONG BRANCH');
    }
  });

  it('collectDownstreamRecap collects only nodes on path to preferred tip', () => {
    // More complex branch: verify it doesn't collect from sibling branches
    // node_1 -> node_2 -> node_4 (preferred)
    //        -> node_3 -> node_5 (abandoned)
    const dag = {
      nodesById: {
        node_1: { nodeId: 'node_1', parentNodeId: null, nodeKind: 'step' as const, workflowHash: 'sha256:abc', snapshotRef: 'sha256:1', createdAtEventIndex: 0 },
        node_2: { nodeId: 'node_2', parentNodeId: 'node_1', nodeKind: 'step' as const, workflowHash: 'sha256:abc', snapshotRef: 'sha256:2', createdAtEventIndex: 1 },
        node_3: { nodeId: 'node_3', parentNodeId: 'node_1', nodeKind: 'step' as const, workflowHash: 'sha256:abc', snapshotRef: 'sha256:3', createdAtEventIndex: 2 },
        node_4: { nodeId: 'node_4', parentNodeId: 'node_2', nodeKind: 'step' as const, workflowHash: 'sha256:abc', snapshotRef: 'sha256:4', createdAtEventIndex: 3 },
        node_5: { nodeId: 'node_5', parentNodeId: 'node_3', nodeKind: 'step' as const, workflowHash: 'sha256:abc', snapshotRef: 'sha256:5', createdAtEventIndex: 4 },
      },
      edges: [
        { fromNodeId: 'node_1', toNodeId: 'node_2', edgeKind: 'acked_step' as const, cause: { kind: 'idempotent_replay', eventId: 'e1' }, createdAtEventIndex: 1 },
        { fromNodeId: 'node_1', toNodeId: 'node_3', edgeKind: 'acked_step' as const, cause: { kind: 'intentional_fork', eventId: 'e2' }, createdAtEventIndex: 2 },
        { fromNodeId: 'node_2', toNodeId: 'node_4', edgeKind: 'acked_step' as const, cause: { kind: 'idempotent_replay', eventId: 'e3' }, createdAtEventIndex: 3 },
        { fromNodeId: 'node_3', toNodeId: 'node_5', edgeKind: 'acked_step' as const, cause: { kind: 'idempotent_replay', eventId: 'e4' }, createdAtEventIndex: 4 },
      ],
      preferredTipNodeId: 'node_4',
      runId: 'run_1',
      workflowId: null,
      workflowHash: null,
      tipNodeIds: ['node_4', 'node_5'],
    };

    const outputs = {
      nodesById: {
        node_2: { historyByChannel: { recap: [{ outputId: 'out_2', outputChannel: 'recap' as const, payload: { payloadKind: 'notes' as const, notesMarkdown: 'Preferred: Step 2' }, createdAtEventIndex: 1 }], artifact: [] }, currentByChannel: { recap: [{ outputId: 'out_2', outputChannel: 'recap' as const, payload: { payloadKind: 'notes' as const, notesMarkdown: 'Preferred: Step 2' }, createdAtEventIndex: 1 }], artifact: [] } },
        node_3: { historyByChannel: { recap: [{ outputId: 'out_3', outputChannel: 'recap' as const, payload: { payloadKind: 'notes' as const, notesMarkdown: 'Abandoned: Step 3' }, createdAtEventIndex: 2 }], artifact: [] }, currentByChannel: { recap: [{ outputId: 'out_3', outputChannel: 'recap' as const, payload: { payloadKind: 'notes' as const, notesMarkdown: 'Abandoned: Step 3' }, createdAtEventIndex: 2 }], artifact: [] } },
        node_4: { historyByChannel: { recap: [{ outputId: 'out_4', outputChannel: 'recap' as const, payload: { payloadKind: 'notes' as const, notesMarkdown: 'Preferred: Step 4' }, createdAtEventIndex: 3 }], artifact: [] }, currentByChannel: { recap: [{ outputId: 'out_4', outputChannel: 'recap' as const, payload: { payloadKind: 'notes' as const, notesMarkdown: 'Preferred: Step 4' }, createdAtEventIndex: 3 }], artifact: [] } },
        node_5: { historyByChannel: { recap: [{ outputId: 'out_5', outputChannel: 'recap' as const, payload: { payloadKind: 'notes' as const, notesMarkdown: 'Abandoned: Step 5' }, createdAtEventIndex: 4 }], artifact: [] }, currentByChannel: { recap: [{ outputId: 'out_5', outputChannel: 'recap' as const, payload: { payloadKind: 'notes' as const, notesMarkdown: 'Abandoned: Step 5' }, createdAtEventIndex: 4 }], artifact: [] } },
      },
    };

    const result = collectDownstreamRecap({ fromNodeId: 'node_1', toNodeId: 'node_4', dag, outputs });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // Should collect from preferred path only: node_2, node_4
      expect(result.value.length).toBe(2);
      expect(result.value).toEqual(['Preferred: Step 2', 'Preferred: Step 4']);
      
      // Should NOT include abandoned branch (node_3, node_5)
      expect(result.value.join(' ')).not.toContain('Abandoned');
    }
  });

  it('collectDownstreamRecap handles missing recap outputs gracefully', () => {
    const dag = {
      nodesById: {
        node_1: { nodeId: 'node_1', parentNodeId: null, nodeKind: 'step' as const, workflowHash: 'sha256:abc', snapshotRef: 'sha256:1', createdAtEventIndex: 0 },
        node_2: { nodeId: 'node_2', parentNodeId: 'node_1', nodeKind: 'step' as const, workflowHash: 'sha256:abc', snapshotRef: 'sha256:2', createdAtEventIndex: 1 },
      },
      edges: [{ fromNodeId: 'node_1', toNodeId: 'node_2', edgeKind: 'acked_step' as const, cause: { kind: 'idempotent_replay', eventId: 'e1' }, createdAtEventIndex: 1 }],
      preferredTipNodeId: 'node_2',
      runId: 'run_1',
      workflowId: null,
      workflowHash: null,
      tipNodeIds: ['node_2'],
    };
    const outputs = { nodesById: {} }; // No outputs

    const result = collectDownstreamRecap({ fromNodeId: 'node_1', toNodeId: 'node_2', dag, outputs });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual([]);
    }
  });
});
