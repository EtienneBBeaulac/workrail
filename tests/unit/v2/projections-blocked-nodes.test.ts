import { describe, it, expect } from 'vitest';
import { projectRunDagV2 } from '../../../src/v2/projections/run-dag.js';
import { projectRunStatusSignalsV2 } from '../../../src/v2/projections/run-status-signals.js';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';

describe('Projections with blocked nodes', () => {
  it('projectRunDagV2 includes blocked_attempt nodes in nodesById', () => {
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
        eventId: 'evt_blocked',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_blocked',
        scope: { runId: 'run_1', nodeId: 'node_blocked' },
        data: { nodeKind: 'blocked_attempt', parentNodeId: null, workflowHash: 'sha256:test' as any, snapshotRef: 'sha256:snap' as any },
      } as any,
    ];

    const dagRes = projectRunDagV2(events);
    expect(dagRes.isOk()).toBe(true);
    if (!dagRes.isOk()) return;

    const dag = dagRes.value;
    const blockedNode = dag.runsById['run_1']!.nodesById['node_blocked'];

    expect(blockedNode).toBeDefined();
    expect(blockedNode!.nodeKind).toBe('blocked_attempt');
  });

  it('blocked nodes qualify as tips (no outgoing edges)', () => {
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
        eventId: 'evt_blocked',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_blocked',
        scope: { runId: 'run_1', nodeId: 'node_blocked' },
        data: { nodeKind: 'blocked_attempt', parentNodeId: null, workflowHash: 'sha256:test' as any, snapshotRef: 'sha256:snap' as any },
      } as any,
    ];

    const dagRes = projectRunDagV2(events);
    expect(dagRes.isOk()).toBe(true);
    if (!dagRes.isOk()) return;

    const dag = dagRes.value;
    const run = dag.runsById['run_1'];

    expect(run!.tipNodeIds).toContain('node_blocked');
    expect(run!.preferredTipNodeId).toBe('node_blocked');
  });

  it('projectRunStatusV2 returns isBlocked=true when tip is blocked_attempt', () => {
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
        eventId: 'evt_blocked',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_blocked',
        scope: { runId: 'run_1', nodeId: 'node_blocked' },
        data: { nodeKind: 'blocked_attempt', parentNodeId: null, workflowHash: 'sha256:test' as any, snapshotRef: 'sha256:snap' as any },
      } as any,
    ];

    const statusRes = projectRunStatusSignalsV2(events);
    expect(statusRes.isOk()).toBe(true);
    if (!statusRes.isOk()) return;

    const status = statusRes.value;
    expect(status.byRunId['run_1']!.isBlocked).toBe(true);
  });

  it('chained blocked nodes all appear in DAG with correct parent links', () => {
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
        eventId: 'evt_b1',
        eventIndex: 2,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:block1',
        scope: { runId: 'run_1', nodeId: 'block1' },
        data: { nodeKind: 'blocked_attempt', parentNodeId: 'node_root', workflowHash: 'sha256:test' as any, snapshotRef: 'sha256:s2' as any },
      } as any,
      {
        v: 1,
        eventId: 'evt_b2',
        eventIndex: 3,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:block2',
        scope: { runId: 'run_1', nodeId: 'block2' },
        data: { nodeKind: 'blocked_attempt', parentNodeId: 'block1', workflowHash: 'sha256:test' as any, snapshotRef: 'sha256:s3' as any },
      } as any,
      {
        v: 1,
        eventId: 'evt_b3',
        eventIndex: 4,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:block3',
        scope: { runId: 'run_1', nodeId: 'block3' },
        data: { nodeKind: 'blocked_attempt', parentNodeId: 'block2', workflowHash: 'sha256:test' as any, snapshotRef: 'sha256:s4' as any },
      } as any,
    ];

    const dagRes = projectRunDagV2(events);
    expect(dagRes.isOk()).toBe(true);
    if (!dagRes.isOk()) return;

    const dag = dagRes.value;

    // Verify all 3 blocked nodes exist with correct parent chain
    expect(dag.runsById['run_1']!.nodesById['block1']?.parentNodeId).toBe('node_root');
    expect(dag.runsById['run_1']!.nodesById['block2']?.parentNodeId).toBe('block1');
    expect(dag.runsById['run_1']!.nodesById['block3']?.parentNodeId).toBe('block2');
  });
});
