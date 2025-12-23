import { describe, it, expect } from 'vitest';
import { projectRunDagV2 } from '../../../src/v2/projections/run-dag.js';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';

describe('v2 run DAG projection', () => {
  it('builds nodes/edges and selects preferred tip deterministically', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_run',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'run_started',
        dedupeKey: 'run_started:sess_1:run_1',
        scope: { runId: 'run_1' },
        data: {
          workflowId: 'project.example',
          workflowHash: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
          workflowSourceKind: 'project',
          workflowSourceRef: 'workflows/example.json',
        },
      },
      {
        v: 1,
        eventId: 'evt_node_a',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_a',
        scope: { runId: 'run_1', nodeId: 'node_a' },
        data: {
          nodeKind: 'step',
          parentNodeId: null,
          workflowHash: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
          snapshotRef: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
        },
      },
      {
        v: 1,
        eventId: 'evt_node_b',
        eventIndex: 2,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_b',
        scope: { runId: 'run_1', nodeId: 'node_b' },
        data: {
          nodeKind: 'step',
          parentNodeId: 'node_a',
          workflowHash: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
          snapshotRef: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
        },
      },
      {
        v: 1,
        eventId: 'evt_edge_ab',
        eventIndex: 3,
        sessionId: 'sess_1',
        kind: 'edge_created',
        dedupeKey: 'edge_created:sess_1:run_1:node_a->node_b:acked_step',
        scope: { runId: 'run_1' },
        data: {
          edgeKind: 'acked_step',
          fromNodeId: 'node_a',
          toNodeId: 'node_b',
          cause: { kind: 'idempotent_replay', eventId: 'evt_any' },
        },
      },
    ];

    const res = projectRunDagV2(events);
    expect(res.isOk()).toBe(true);
    const dag = res._unsafeUnwrap();
    const run = dag.runsById['run_1']!;
    expect(run.workflowId).toBe('project.example');
    expect(Object.keys(run.nodesById).sort()).toEqual(['node_a', 'node_b']);
    expect(run.edges.length).toBe(1);
    expect(run.tipNodeIds).toEqual(['node_b']);
    expect(run.preferredTipNodeId).toBe('node_b');
  });

  it('fails fast if an edge references missing nodes', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_edge',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'edge_created',
        dedupeKey: 'edge_created:sess_1:run_1:x->y:acked_step',
        scope: { runId: 'run_1' },
        data: {
          edgeKind: 'acked_step',
          fromNodeId: 'x',
          toNodeId: 'y',
          cause: { kind: 'idempotent_replay', eventId: 'evt_any' },
        },
      },
    ];

    const res = projectRunDagV2(events);
    expect(res.isErr()).toBe(true);
  });
});
