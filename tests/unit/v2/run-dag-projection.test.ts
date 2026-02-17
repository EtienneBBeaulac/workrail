/**
 * v2 Run DAG Projection Tests
 *
 * @enforces runs-are-dags
 * @enforces preferred-tip-per-run
 * @enforces preferred-tip-algorithm
 * @enforces preferred-tip-no-timestamps
 * @enforces event-index-monotonic-contiguous
 * @enforces edge-kind-closed-set
 * @enforces edge-cause-closed-set
 */
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
    expect(run.workflow.kind).toBe('with_workflow');
    if (run.workflow.kind === 'with_workflow') {
      expect(run.workflow.workflowId).toBe('project.example');
    }
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
    expect(res._unsafeUnwrapErr().code).toBe('PROJECTION_INVARIANT_VIOLATION');
  });

  it('rejects out-of-order events by eventIndex', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_2',
        eventIndex: 5,
        sessionId: 'sess_1',
        kind: 'run_started',
        dedupeKey: 'run_started:sess_1:run_1',
        scope: { runId: 'run_1' },
        data: {
          workflowId: 'test',
          workflowHash: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
          workflowSourceKind: 'project',
          workflowSourceRef: 'test',
        },
      },
      {
        v: 1,
        eventId: 'evt_1',
        eventIndex: 3,
        sessionId: 'sess_1',
        kind: 'session_created',
        dedupeKey: 'session_created:sess_1',
        data: {},
      },
    ];

    const res = projectRunDagV2(events);
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().code).toBe('PROJECTION_INVARIANT_VIOLATION');
    expect(res._unsafeUnwrapErr().message).toContain('sorted by eventIndex');
  });

  it('handles empty event array (no runs)', () => {
    const res = projectRunDagV2([]);
    expect(res.isOk()).toBe(true);
    expect(Object.keys(res._unsafeUnwrap().runsById)).toEqual([]);
  });

  it('detects duplicate node_created with conflicting data (corruption)', () => {
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
          workflowId: 'test',
          workflowHash: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
          workflowSourceKind: 'project',
          workflowSourceRef: 'test',
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
          snapshotRef: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      },
      {
        v: 1,
        eventId: 'evt_node_a_dup',
        eventIndex: 2,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_a',
        scope: { runId: 'run_1', nodeId: 'node_a' },
        data: {
          nodeKind: 'step',
          parentNodeId: null,
          workflowHash: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
          snapshotRef: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      },
    ];

    const res = projectRunDagV2(events);
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().code).toBe('PROJECTION_CORRUPTION_DETECTED');
    expect(res._unsafeUnwrapErr().message).toContain('node_created conflict');
  });

  it('detects workflowHash mismatch on run_started (corruption)', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_run_1',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'run_started',
        dedupeKey: 'run_started:sess_1:run_1',
        scope: { runId: 'run_1' },
        data: {
          workflowId: 'test',
          workflowHash: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
          workflowSourceKind: 'project',
          workflowSourceRef: 'test',
        },
      },
      {
        v: 1,
        eventId: 'evt_run_1_dup',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'run_started',
        dedupeKey: 'run_started:sess_1:run_1',
        scope: { runId: 'run_1' },
        data: {
          workflowId: 'test',
          workflowHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          workflowSourceKind: 'project',
          workflowSourceRef: 'test',
        },
      },
    ];

    const res = projectRunDagV2(events);
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().code).toBe('PROJECTION_CORRUPTION_DETECTED');
    expect(res._unsafeUnwrapErr().message).toContain('workflowHash mismatch');
  });

  it('handles multiple runs in single session', () => {
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_run_1',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'run_started',
        dedupeKey: 'run_started:sess_1:run_1',
        scope: { runId: 'run_1' },
        data: {
          workflowId: 'wf_a',
          workflowHash: 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11',
          workflowSourceKind: 'project',
          workflowSourceRef: 'a',
        },
      },
      {
        v: 1,
        eventId: 'evt_run_2',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'run_started',
        dedupeKey: 'run_started:sess_1:run_2',
        scope: { runId: 'run_2' },
        data: {
          workflowId: 'wf_b',
          workflowHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          workflowSourceKind: 'project',
          workflowSourceRef: 'b',
        },
      },
    ];

    const res = projectRunDagV2(events);
    expect(res.isOk()).toBe(true);
    const dag = res._unsafeUnwrap();
    expect(Object.keys(dag.runsById).sort()).toEqual(['run_1', 'run_2']);
    const run1 = dag.runsById['run_1']!;
    const run2 = dag.runsById['run_2']!;
    expect(run1.workflow.kind).toBe('with_workflow');
    expect(run2.workflow.kind).toBe('with_workflow');
    if (run1.workflow.kind === 'with_workflow') {
      expect(run1.workflow.workflowId).toBe('wf_a');
    }
    if (run2.workflow.kind === 'with_workflow') {
      expect(run2.workflow.workflowId).toBe('wf_b');
    }
  });

  it('preferred tip tie-breaker: node_created eventIndex', () => {
    const wfHash = 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11';
    const snapRef = 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11';
    
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_run',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'run_started',
        dedupeKey: 'run_started:sess_1:run_1',
        scope: { runId: 'run_1' },
        data: { workflowId: 'test', workflowHash: wfHash, workflowSourceKind: 'project', workflowSourceRef: 't' },
      },
      {
        v: 1,
        eventId: 'evt_node_a',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_a',
        scope: { runId: 'run_1', nodeId: 'node_a' },
        data: { nodeKind: 'step', parentNodeId: null, workflowHash: wfHash, snapshotRef: snapRef },
      },
      {
        v: 1,
        eventId: 'evt_node_b',
        eventIndex: 2,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_b',
        scope: { runId: 'run_1', nodeId: 'node_b' },
        data: { nodeKind: 'step', parentNodeId: 'node_a', workflowHash: wfHash, snapshotRef: snapRef },
      },
      {
        v: 1,
        eventId: 'evt_edge_ab',
        eventIndex: 3,
        sessionId: 'sess_1',
        kind: 'edge_created',
        dedupeKey: 'edge_created:sess_1:run_1:node_a->node_b:acked_step',
        scope: { runId: 'run_1' },
        data: { edgeKind: 'acked_step', fromNodeId: 'node_a', toNodeId: 'node_b', cause: { kind: 'intentional_fork', eventId: 'evt_edge_ab' } },
      },
      {
        v: 1,
        eventId: 'evt_node_c',
        eventIndex: 4,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_c',
        scope: { runId: 'run_1', nodeId: 'node_c' },
        data: { nodeKind: 'step', parentNodeId: 'node_a', workflowHash: wfHash, snapshotRef: snapRef },
      },
      {
        v: 1,
        eventId: 'evt_edge_ac',
        eventIndex: 5,
        sessionId: 'sess_1',
        kind: 'edge_created',
        dedupeKey: 'edge_created:sess_1:run_1:node_a->node_c:acked_step',
        scope: { runId: 'run_1' },
        data: { edgeKind: 'acked_step', fromNodeId: 'node_a', toNodeId: 'node_c', cause: { kind: 'non_tip_advance', eventId: 'evt_edge_ac' } },
      },
    ];

    const res = projectRunDagV2(events);
    expect(res.isOk()).toBe(true);
    const run = res._unsafeUnwrap().runsById['run_1']!;
    
    expect(run.tipNodeIds.sort()).toEqual(['node_b', 'node_c']);
    expect(run.preferredTipNodeId).toBe('node_c');
  });

  it('preferred tip tie-breaker: lexical nodeId when activity tied', () => {
    const wfHash = 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11';
    const snapRef = 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11';
    
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_run',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'run_started',
        dedupeKey: 'run_started:sess_1:run_1',
        scope: { runId: 'run_1' },
        data: { workflowId: 'test', workflowHash: wfHash, workflowSourceKind: 'project', workflowSourceRef: 't' },
      },
      {
        v: 1,
        eventId: 'evt_node_root',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_root',
        scope: { runId: 'run_1', nodeId: 'node_root' },
        data: { nodeKind: 'step', parentNodeId: null, workflowHash: wfHash, snapshotRef: snapRef },
      },
      {
        v: 1,
        eventId: 'evt_node_z',
        eventIndex: 2,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_z',
        scope: { runId: 'run_1', nodeId: 'node_z' },
        data: { nodeKind: 'step', parentNodeId: 'node_root', workflowHash: wfHash, snapshotRef: snapRef },
      },
      {
        v: 1,
        eventId: 'evt_node_a',
        eventIndex: 3,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_a',
        scope: { runId: 'run_1', nodeId: 'node_a' },
        data: { nodeKind: 'step', parentNodeId: 'node_root', workflowHash: wfHash, snapshotRef: snapRef },
      },
      {
        v: 1,
        eventId: 'evt_edge_z',
        eventIndex: 4,
        sessionId: 'sess_1',
        kind: 'edge_created',
        dedupeKey: 'edge_created:sess_1:run_1:node_root->node_z:acked_step',
        scope: { runId: 'run_1' },
        data: { edgeKind: 'acked_step', fromNodeId: 'node_root', toNodeId: 'node_z', cause: { kind: 'intentional_fork', eventId: 'evt_edge_z' } },
      },
      {
        v: 1,
        eventId: 'evt_edge_a',
        eventIndex: 5,
        sessionId: 'sess_1',
        kind: 'edge_created',
        dedupeKey: 'edge_created:sess_1:run_1:node_root->node_a:acked_step',
        scope: { runId: 'run_1' },
        data: { edgeKind: 'acked_step', fromNodeId: 'node_root', toNodeId: 'node_a', cause: { kind: 'non_tip_advance', eventId: 'evt_edge_a' } },
      },
    ];

    const res = projectRunDagV2(events);
    expect(res.isOk()).toBe(true);
    const run = res._unsafeUnwrap().runsById['run_1']!;
    
    expect(run.tipNodeIds.sort()).toEqual(['node_a', 'node_z']);
    expect(run.preferredTipNodeId).toBe('node_a');
  });

  it('multiple leaf nodes (fork) → preferred tip selected by activity', () => {
    const wfHash = 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11';
    const snapRef = 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11';
    
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_run',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'run_started',
        dedupeKey: 'run_started:sess_1:run_1',
        scope: { runId: 'run_1' },
        data: { workflowId: 'test', workflowHash: wfHash, workflowSourceKind: 'project', workflowSourceRef: 't' },
      },
      {
        v: 1,
        eventId: 'evt_node_root',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_root',
        scope: { runId: 'run_1', nodeId: 'node_root' },
        data: { nodeKind: 'step', parentNodeId: null, workflowHash: wfHash, snapshotRef: snapRef },
      },
      {
        v: 1,
        eventId: 'evt_node_b1',
        eventIndex: 2,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_b1',
        scope: { runId: 'run_1', nodeId: 'node_b1' },
        data: { nodeKind: 'step', parentNodeId: 'node_root', workflowHash: wfHash, snapshotRef: snapRef },
      },
      {
        v: 1,
        eventId: 'evt_node_b2',
        eventIndex: 3,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_b2',
        scope: { runId: 'run_1', nodeId: 'node_b2' },
        data: { nodeKind: 'step', parentNodeId: 'node_root', workflowHash: wfHash, snapshotRef: snapRef },
      },
      {
        v: 1,
        eventId: 'evt_edge_b1',
        eventIndex: 4,
        sessionId: 'sess_1',
        kind: 'edge_created',
        dedupeKey: 'edge_created:sess_1:run_1:node_root->node_b1:acked_step',
        scope: { runId: 'run_1' },
        data: { edgeKind: 'acked_step', fromNodeId: 'node_root', toNodeId: 'node_b1', cause: { kind: 'intentional_fork', eventId: 'evt_edge_b1' } },
      },
      {
        v: 1,
        eventId: 'evt_edge_b2',
        eventIndex: 5,
        sessionId: 'sess_1',
        kind: 'edge_created',
        dedupeKey: 'edge_created:sess_1:run_1:node_root->node_b2:acked_step',
        scope: { runId: 'run_1' },
        data: { edgeKind: 'acked_step', fromNodeId: 'node_root', toNodeId: 'node_b2', cause: { kind: 'non_tip_advance', eventId: 'evt_edge_b2' } },
      },
      {
        v: 1,
        eventId: 'evt_gap_b2',
        eventIndex: 10,
        sessionId: 'sess_1',
        kind: 'gap_recorded',
        dedupeKey: 'gap_recorded:sess_1:gap_1',
        scope: { runId: 'run_1', nodeId: 'node_b2' },
        data: {
          gapId: 'gap_1',
          severity: 'info',
          reason: { category: 'unexpected', detail: 'invariant_violation' },
          summary: 'Some gap',
          resolution: { kind: 'unresolved' },
        },
      },
    ];

    const res = projectRunDagV2(events);
    expect(res.isOk()).toBe(true);
    const run = res._unsafeUnwrap().runsById['run_1']!;
    
    expect(run.tipNodeIds.sort()).toEqual(['node_b1', 'node_b2']);
    expect(run.preferredTipNodeId).toBe('node_b2');
  });

  it('parent linkage mismatch on edge → corruption', () => {
    const wfHash = 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11';
    const snapRef = 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11';
    
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_run',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'run_started',
        dedupeKey: 'run_started:sess_1:run_1',
        scope: { runId: 'run_1' },
        data: { workflowId: 'test', workflowHash: wfHash, workflowSourceKind: 'project', workflowSourceRef: 't' },
      },
      {
        v: 1,
        eventId: 'evt_node_a',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_a',
        scope: { runId: 'run_1', nodeId: 'node_a' },
        data: { nodeKind: 'step', parentNodeId: null, workflowHash: wfHash, snapshotRef: snapRef },
      },
      {
        v: 1,
        eventId: 'evt_node_wrong',
        eventIndex: 2,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_wrong',
        scope: { runId: 'run_1', nodeId: 'node_wrong' },
        data: { nodeKind: 'step', parentNodeId: null, workflowHash: wfHash, snapshotRef: snapRef },
      },
      {
        v: 1,
        eventId: 'evt_node_b',
        eventIndex: 3,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_b',
        scope: { runId: 'run_1', nodeId: 'node_b' },
        data: { nodeKind: 'step', parentNodeId: 'node_wrong', workflowHash: wfHash, snapshotRef: snapRef },
      },
      {
        v: 1,
        eventId: 'evt_edge_ab',
        eventIndex: 4,
        sessionId: 'sess_1',
        kind: 'edge_created',
        dedupeKey: 'edge_created:sess_1:run_1:node_a->node_b:acked_step',
        scope: { runId: 'run_1' },
        data: { edgeKind: 'acked_step', fromNodeId: 'node_a', toNodeId: 'node_b', cause: { kind: 'intentional_fork', eventId: 'evt_edge_ab' } },
      },
    ];

    const res = projectRunDagV2(events);
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().code).toBe('PROJECTION_CORRUPTION_DETECTED');
    expect(res._unsafeUnwrapErr().message).toContain('violates parent linkage');
  });

  it('node references missing parent → invariant violation', () => {
    const wfHash = 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11';
    const snapRef = 'sha256:5947229239ac2966c1099d6d74f4448c064e54ae25959eaebfd89cec073bdc11';
    
    const events: DomainEventV1[] = [
      {
        v: 1,
        eventId: 'evt_run',
        eventIndex: 0,
        sessionId: 'sess_1',
        kind: 'run_started',
        dedupeKey: 'run_started:sess_1:run_1',
        scope: { runId: 'run_1' },
        data: { workflowId: 'test', workflowHash: wfHash, workflowSourceKind: 'project', workflowSourceRef: 't' },
      },
      {
        v: 1,
        eventId: 'evt_node_orphan',
        eventIndex: 1,
        sessionId: 'sess_1',
        kind: 'node_created',
        dedupeKey: 'node_created:sess_1:run_1:node_orphan',
        scope: { runId: 'run_1', nodeId: 'node_orphan' },
        data: { nodeKind: 'step', parentNodeId: 'missing_parent', workflowHash: wfHash, snapshotRef: snapRef },
      },
    ];

    const res = projectRunDagV2(events);
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr().code).toBe('PROJECTION_INVARIANT_VIOLATION');
    expect(res._unsafeUnwrapErr().message).toContain('missing parentNodeId');
  });
});
