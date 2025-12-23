import { describe, it, expect } from 'vitest';
import { projectSessionHealthV2 } from '../../../src/v2/projections/session-health.js';
import type { LoadedSessionTruthV2 } from '../../../src/v2/ports/session-event-log-store.port.js';
import type { DomainEventV1, ManifestRecordV1 } from '../../../src/v2/durable-core/schemas/session/index.js';

describe('v2 session health projection', () => {
  it('is healthy when run DAG projection succeeds', () => {
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
    ];

    const truth: LoadedSessionTruthV2 = { manifest: [] as ManifestRecordV1[], events };
    const res = projectSessionHealthV2(truth);
    expect(res.isOk()).toBe(true);
    expect(res._unsafeUnwrap().kind).toBe('healthy');
  });

  it('is corrupt_tail when run DAG projection fails', () => {
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

    const truth: LoadedSessionTruthV2 = { manifest: [] as ManifestRecordV1[], events };
    const res = projectSessionHealthV2(truth);
    expect(res.isOk()).toBe(true);
    const health = res._unsafeUnwrap();
    expect(health.kind).toBe('corrupt_tail');
    if (health.kind === 'corrupt_tail') {
      expect(health.reason.code).toBe('non_contiguous_indices');
    }
  });
});
