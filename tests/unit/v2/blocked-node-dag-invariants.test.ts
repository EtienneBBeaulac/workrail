import { describe, it, expect } from 'vitest';
import { projectRunDagV2 } from '../../../src/v2/projections/run-dag.js';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';

describe('Blocked node DAG topology invariants', () => {
  it('no orphaned blocked nodes - all have parent or are root', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_run',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'run_started',
        dedupeKey: 'run_started:sess_1:run_1',
        scope: { runId: 'run_1' },
        data: { workflowId: 'test', workflowHash: 'sha256:test' as any, workflowSourceKind: 'bundled', workflowSourceRef: 'test' },
      } as any,
      {
        v: 1,
        eventId: 'evt_node_root',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_root',
        scope: { runId: 'run_1', nodeId: 'node_root' },
        data: { nodeKind: 'step', parentNodeId: null, workflowHash: 'sha256:test' as any, snapshotRef: 'sha256:snap1' as any },
      } as any,
      {
        v: 1,
        eventId: 'evt_blocked',
        eventIndex: 2,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_blocked',
        scope: { runId: 'run_1', nodeId: 'node_blocked' },
        data: { nodeKind: 'blocked_attempt', parentNodeId: 'node_root', workflowHash: 'sha256:test' as any, snapshotRef: 'sha256:snap2' as any },
      } as any,
    ];

    const dagRes = projectRunDagV2(events);
    expect(dagRes.isOk()).toBe(true);
    if (!dagRes.isOk()) return;

    const dag = dagRes.value;
    const blockedNodes = Object.values(dag.runsById['run_1']!.nodesById).filter((n) => n.nodeKind === 'blocked_attempt');

    expect(blockedNodes.length).toBe(1);
    for (const node of blockedNodes) {
      expect(node.parentNodeId).not.toBeNull();
      expect(dag.runsById['run_1']!.nodesById[node.parentNodeId!]).toBeDefined();
    }
  });

  it('blocked nodes have exactly one incoming edge', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_run',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'run_started',
        dedupeKey: 'run_started:sess_1:run_1',
        scope: { runId: 'run_1' },
        data: { workflowId: 'test', workflowHash: 'sha256:test' as any, workflowSourceKind: 'bundled', workflowSourceRef: 'test' },
      } as any,
      {
        v: 1,
        eventId: 'evt_node_root',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_root',
        scope: { runId: 'run_1', nodeId: 'node_root' },
        data: { nodeKind: 'step', parentNodeId: null, workflowHash: 'sha256:test' as any, snapshotRef: 'sha256:snap1' as any },
      } as any,
      {
        v: 1,
        eventId: 'evt_blocked',
        eventIndex: 2,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_blocked',
        scope: { runId: 'run_1', nodeId: 'node_blocked' },
        data: { nodeKind: 'blocked_attempt', parentNodeId: 'node_root', workflowHash: 'sha256:test' as any, snapshotRef: 'sha256:snap2' as any },
      } as any,
      {
        v: 1,
        eventId: 'evt_edge',
        eventIndex: 3,
        sessionId: 'sess_1',
        kind: 'edge_created',
        dedupeKey: 'edge_created:sess_1:run_1:node_root->node_blocked:acked_step',
        scope: { runId: 'run_1' },
        data: { edgeKind: 'acked_step', fromNodeId: 'node_root', toNodeId: 'node_blocked', cause: { kind: 'intentional_fork', eventId: 'evt_adv' } },
      } as any,
    ];

    const dagRes = projectRunDagV2(events);
    expect(dagRes.isOk()).toBe(true);
    if (!dagRes.isOk()) return;

    const dag = dagRes.value;
    const edgesToBlocked = dag.runsById['run_1']!.edges.filter((e) => e.toNodeId === 'node_blocked');

    expect(edgesToBlocked.length).toBe(1);
  });

  it('retry chain forms valid parent-child tree (no cycles)', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_run',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'run_started',
        dedupeKey: 'run_started:sess_1:run_1',
        scope: { runId: 'run_1' },
        data: { workflowId: 'test', workflowHash: 'sha256:test' as any, workflowSourceKind: 'bundled', workflowSourceRef: 'test' },
      } as any,
      {
        v: 1,
        eventId: 'evt_root',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_root',
        scope: { runId: 'run_1', nodeId: 'node_root' },
        data: { nodeKind: 'step', parentNodeId: null, workflowHash: 'sha256:test' as any, snapshotRef: 'sha256:snap1' as any },
      } as any,
      {
        v: 1,
        eventId: 'evt_blocked1',
        eventIndex: 2,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_blocked1',
        scope: { runId: 'run_1', nodeId: 'node_blocked1' },
        data: { nodeKind: 'blocked_attempt', parentNodeId: 'node_root', workflowHash: 'sha256:test' as any, snapshotRef: 'sha256:snap2' as any },
      } as any,
      {
        v: 1,
        eventId: 'evt_blocked2',
        eventIndex: 3,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_blocked2',
        scope: { runId: 'run_1', nodeId: 'node_blocked2' },
        data: { nodeKind: 'blocked_attempt', parentNodeId: 'node_blocked1', workflowHash: 'sha256:test' as any, snapshotRef: 'sha256:snap3' as any },
      } as any,
      {
        v: 1,
        eventId: 'evt_blocked3',
        eventIndex: 4,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_blocked3',
        scope: { runId: 'run_1', nodeId: 'node_blocked3' },
        data: { nodeKind: 'blocked_attempt', parentNodeId: 'node_blocked2', workflowHash: 'sha256:test' as any, snapshotRef: 'sha256:snap4' as any },
      } as any,
    ];

    const dagRes = projectRunDagV2(events);
    expect(dagRes.isOk()).toBe(true);
    if (!dagRes.isOk()) return;

    const dag = dagRes.value;

    // Verify chain: blocked3 → blocked2 → blocked1 → root
    const blocked3 = dag.runsById['run_1']!.nodesById['node_blocked3'];
    const blocked2 = dag.runsById['run_1']!.nodesById['node_blocked2'];
    const blocked1 = dag.runsById['run_1']!.nodesById['node_blocked1'];

    expect(blocked3?.parentNodeId).toBe('node_blocked2');
    expect(blocked2?.parentNodeId).toBe('node_blocked1');
    expect(blocked1?.parentNodeId).toBe('node_root');

    // Verify no cycles (following parent chain eventually reaches null)
    let current = blocked3;
    const visited = new Set<string>();
    while (current && current.parentNodeId) {
      expect(visited.has(current.nodeId)).toBe(false); // No cycles
      visited.add(current.nodeId);
      current = dag.runsById['run_1']!.nodesById[current.parentNodeId];
    }
  });

  it('blocked nodes appear as tips until resolved', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_run',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'run_started',
        dedupeKey: 'run_started:sess_1:run_1',
        scope: { runId: 'run_1' },
        data: { workflowId: 'test', workflowHash: 'sha256:test' as any, workflowSourceKind: 'bundled', workflowSourceRef: 'test' },
      } as any,
      {
        v: 1,
        eventId: 'evt_root',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_root',
        scope: { runId: 'run_1', nodeId: 'node_root' },
        data: { nodeKind: 'step', parentNodeId: null, workflowHash: 'sha256:test' as any, snapshotRef: 'sha256:snap1' as any },
      } as any,
      {
        v: 1,
        eventId: 'evt_blocked',
        eventIndex: 2,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_blocked',
        scope: { runId: 'run_1', nodeId: 'node_blocked' },
        data: { nodeKind: 'blocked_attempt', parentNodeId: 'node_root', workflowHash: 'sha256:test' as any, snapshotRef: 'sha256:snap2' as any },
      } as any,
      {
        v: 1,
        eventId: 'evt_edge',
        eventIndex: 3,
        sessionId: 'sess_1',
        kind: 'edge_created',
        dedupeKey: 'edge_created:sess_1:run_1:node_root->node_blocked:acked_step',
        scope: { runId: 'run_1' },
        data: { edgeKind: 'acked_step', fromNodeId: 'node_root', toNodeId: 'node_blocked', cause: { kind: 'intentional_fork', eventId: 'evt_adv' } },
      } as any,
    ];

    const dagRes = projectRunDagV2(events);
    expect(dagRes.isOk()).toBe(true);
    if (!dagRes.isOk()) return;

    const dag = dagRes.value;
    const run = dag.runsById['run_1'];

    // Blocked node should be a tip (no children)
    expect(run!.tipNodeIds).toContain('node_blocked');
    expect(run!.preferredTipNodeId).toBe('node_blocked');
  });
});
