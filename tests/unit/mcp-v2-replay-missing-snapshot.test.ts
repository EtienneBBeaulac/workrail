import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { handleV2ContinueWorkflow } from '../../src/mcp/handlers/v2-execution.js';
import type { ToolContext } from '../../src/mcp/types.js';

import { ExecutionSessionGateV2 } from '../../src/v2/usecases/execution-session-gate.js';
import { LocalDataDirV2 } from '../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../src/v2/infra/local/fs/index.js';
import { NodeSha256V2 } from '../../src/v2/infra/local/sha256/index.js';
import { LocalSessionEventLogStoreV2 } from '../../src/v2/infra/local/session-store/index.js';
import { LocalSessionLockV2 } from '../../src/v2/infra/local/session-lock/index.js';
import { LocalSnapshotStoreV2 } from '../../src/v2/infra/local/snapshot-store/index.js';
import { NodeCryptoV2 } from '../../src/v2/infra/local/crypto/index.js';
import { LocalPinnedWorkflowStoreV2 } from '../../src/v2/infra/local/pinned-workflow-store/index.js';

import { ExecutionSnapshotFileV1Schema } from '../../src/v2/durable-core/schemas/execution-snapshot/index.js';

import { NodeHmacSha256V2 } from '../../src/v2/infra/local/hmac-sha256/index.js';
import { LocalKeyringV2 } from '../../src/v2/infra/local/keyring/index.js';
import { encodeTokenPayloadV1, signTokenV1 } from '../../src/v2/durable-core/tokens/index.js';
import { StateTokenPayloadV1Schema, AckTokenPayloadV1Schema } from '../../src/v2/durable-core/tokens/index.js';

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-replay-'));
}

function dummyCtx(): ToolContext {
  return {
    workflowService: null as any,
    featureFlags: null as any,
    sessionManager: null,
    httpServer: null,
  };
}

async function mkSignedToken(args: { unsignedPrefix: 'st.v1.' | 'ack.v1.'; payload: unknown }): Promise<string> {
  const dataDir = new LocalDataDirV2(process.env);
  const fsPort = new NodeFileSystemV2();
  const hmac = new NodeHmacSha256V2();
  const keyringPort = new LocalKeyringV2(dataDir, fsPort);
  const keyring = await keyringPort.loadOrCreate().match(
    (v) => v,
    (e) => {
      throw new Error(`unexpected keyring error: ${e.code}`);
    }
  );

  const payloadBytes = encodeTokenPayloadV1(args.payload as any).match(
    (v) => v,
    (e) => {
      throw new Error(`unexpected token payload encode error: ${e.code}`);
    }
  );

  const token = signTokenV1(args.unsignedPrefix, payloadBytes, keyring, hmac).match(
    (v) => v,
    (e) => {
      throw new Error(`unexpected token sign error: ${e.code}`);
    }
  );
  return String(token);
}

describe('v2 replay fail-closed: missing snapshot', () => {
  it('returns INTERNAL_ERROR when advance_recorded(advanced) exists but toNode snapshot is missing from CAS', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {
      const dataDir = new LocalDataDirV2(process.env);
      const fsPort = new NodeFileSystemV2();
      const sha256 = new NodeSha256V2();
      const store = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha256);
      const lock = new LocalSessionLockV2(dataDir, fsPort);
      const gate = new ExecutionSessionGateV2(lock, store);
      const crypto = new NodeCryptoV2();
      const snapshotStore = new LocalSnapshotStoreV2(dataDir, fsPort, crypto);

      const sessionId = 'sess_test_missing_snap';
      const runId = 'run_2';
      const nodeId = 'node_1';
      const nodeId2 = 'node_2';
      const workflowHash = 'sha256:5b2d9fb885d0adc6565e1fd59e6abb3769b69e4dba5a02b6eea750137a5c0be2';

      // Pin a v1-backed compiled snapshot so the ack handler can load compiled workflow.
      const pinnedStore = new LocalPinnedWorkflowStoreV2(dataDir);
      await pinnedStore
        .put(workflowHash as any, {
          schemaVersion: 1,
          sourceKind: 'v1_pinned',
          workflowId: 'test-wf',
          name: 'Test WF',
          description: 'Test',
          version: '1.0.0',
          definition: {
            id: 'test-wf',
            name: 'Test WF',
            description: 'Test',
            version: '1.0.0',
            steps: [{ id: 'triage', title: 'Triage', prompt: 'Do triage' }],
          },
        } as any)
        .match(
          () => undefined,
          (e) => {
            throw new Error(`unexpected pinned store put error: ${e.code}`);
          }
        );

      // Create snapshot for node_1 and store it
      const snapshot1 = ExecutionSnapshotFileV1Schema.parse({
        v: 1,
        kind: 'execution_snapshot',
        enginePayload: {
          v: 1,
          engineState: { kind: 'running', completed: { kind: 'set', values: [] }, loopStack: [], pending: { kind: 'some', step: { stepId: 'triage', loopPath: [] } } },
        },
      });
      const snapshotRef1 = await snapshotStore.putExecutionSnapshotV1(snapshot1).match(
        (v) => v,
        (e) => {
          throw new Error(`unexpected snapshot put error for node_1: ${e.code}`);
        }
      );

      // Create snapshot for node_2 but DO NOT store it in CAS (simulate missing snapshot)
      // Use a valid sha256 format but with a ref that doesn't exist in the store
      const snapshotRef2 = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

      // Seed session/run/node_1/node_2 + advance_recorded(advanced)
      await gate
        .withHealthySessionLock(sessionId as any, (witness) =>
          store.append(witness, {
            events: [
              { v: 1, eventId: 'evt_0', eventIndex: 0, sessionId, kind: 'session_created', dedupeKey: `session_created:${sessionId}`, data: {} },
              {
                v: 1,
                eventId: 'evt_1',
                eventIndex: 1,
                sessionId,
                kind: 'run_started',
                dedupeKey: `run_started:${sessionId}:${runId}`,
                scope: { runId },
                data: { workflowId: 'test-wf', workflowHash, workflowSourceKind: 'project', workflowSourceRef: 'workflows/test.json' },
              },
              {
                v: 1,
                eventId: 'evt_2',
                eventIndex: 2,
                sessionId,
                kind: 'node_created',
                dedupeKey: `node_created:${sessionId}:${runId}:${nodeId}`,
                scope: { runId, nodeId },
                data: { nodeKind: 'step', parentNodeId: null, workflowHash, snapshotRef: snapshotRef1 },
              },
              {
                v: 1,
                eventId: 'evt_3',
                eventIndex: 3,
                sessionId,
                kind: 'node_created',
                dedupeKey: `node_created:${sessionId}:${runId}:${nodeId2}`,
                scope: { runId, nodeId: nodeId2 },
                data: { nodeKind: 'step', parentNodeId: nodeId, workflowHash, snapshotRef: snapshotRef2 },
              },
              {
                v: 1,
                eventId: 'evt_4',
                eventIndex: 4,
                sessionId,
                kind: 'edge_created',
                dedupeKey: `edge_created:${sessionId}:${runId}:${nodeId}:${nodeId2}`,
                scope: { runId, nodeId },
                data: { edgeKind: 'acked_step', fromNodeId: nodeId, toNodeId: nodeId2, cause: { kind: 'idempotent_replay', eventId: 'evt_5' } },
              },
              {
                v: 1,
                eventId: 'evt_5',
                eventIndex: 5,
                sessionId,
                kind: 'advance_recorded',
                dedupeKey: `advance_recorded:${sessionId}:${nodeId}:attempt_1`,
                scope: { runId, nodeId },
                data: { attemptId: 'attempt_1', intent: 'ack_pending', outcome: { kind: 'advanced', toNodeId: nodeId2 } },
              },
            ] as any,
            snapshotPins: [
              { snapshotRef: snapshotRef1, eventIndex: 2, createdByEventId: 'evt_2' },
              { snapshotRef: snapshotRef2, eventIndex: 3, createdByEventId: 'evt_3' },
            ],
          })
        )
        .match(
          () => undefined,
          (e) => {
            throw new Error(`unexpected seed append error: ${String((e as any).code ?? e)}`);
          }
        );

      const statePayload = StateTokenPayloadV1Schema.parse({
        tokenVersion: 1,
        tokenKind: 'state',
        sessionId,
        runId,
        nodeId,
        workflowHash,
      });
      const ackPayload = AckTokenPayloadV1Schema.parse({
        tokenVersion: 1,
        tokenKind: 'ack',
        sessionId,
        runId,
        nodeId,
        attemptId: 'attempt_1',
      });

      const stateToken = await mkSignedToken({ unsignedPrefix: 'st.v1.', payload: statePayload });
      const ackToken = await mkSignedToken({ unsignedPrefix: 'ack.v1.', payload: ackPayload });

      const res = await handleV2ContinueWorkflow({ stateToken, ackToken } as any, dummyCtx());
      expect(res.type).toBe('error');
      if (res.type !== 'error') return;
      expect(res.code).toBe('INTERNAL_ERROR');
      expect(res.message).toContain('Missing execution snapshot');
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });
});
