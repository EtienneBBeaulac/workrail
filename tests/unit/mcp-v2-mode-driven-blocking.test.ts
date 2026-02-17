import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { handleV2ContinueWorkflow } from '../../src/mcp/handlers/v2-execution.js';
import type { ToolContext, V2Dependencies } from '../../src/mcp/types.js';

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
import { NodeBase64UrlV2 } from '../../src/v2/infra/local/base64url/index.js';
import { NodeRandomEntropyV2 } from '../../src/v2/infra/local/random-entropy/index.js';
import { NodeTimeClockV2 } from '../../src/v2/infra/local/time-clock/index.js';
import { IdFactoryV2 } from '../../src/v2/infra/local/id-factory/index.js';
import { Bech32mAdapterV2 } from '../../src/v2/infra/local/bech32m/index.js';
import { Base32AdapterV2 } from '../../src/v2/infra/local/base32/index.js';
import { signTokenV1Binary, unsafeTokenCodecPorts } from '../../src/v2/durable-core/tokens/index.js';
import { StateTokenPayloadV1Schema, AckTokenPayloadV1Schema } from '../../src/v2/durable-core/tokens/index.js';
import { asWorkflowHash, asSha256Digest } from '../../src/v2/durable-core/ids/index.js';
import { deriveWorkflowHashRef } from '../../src/v2/durable-core/ids/workflow-hash-ref.js';

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-mode-block-'));
}

async function mkV2Deps(dataDir: LocalDataDirV2): Promise<V2Dependencies> {
  const fsPort = new NodeFileSystemV2();
  const sha256 = new NodeSha256V2();
  const sessionEventLogStore = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha256);
  const clock = new NodeTimeClockV2();
  const sessionLock = new LocalSessionLockV2(dataDir, fsPort, clock);
  const sessionGate = new ExecutionSessionGateV2(sessionLock, sessionEventLogStore);
  const crypto = new NodeCryptoV2();
  const hmac = new NodeHmacSha256V2();
  const base64url = new NodeBase64UrlV2();
  const entropy = new NodeRandomEntropyV2();
  const idFactory = new IdFactoryV2(entropy);
  const base32 = new Base32AdapterV2();
  const bech32m = new Bech32mAdapterV2();
  const snapshotStore = new LocalSnapshotStoreV2(dataDir, fsPort, crypto);
  const pinnedStore = new LocalPinnedWorkflowStoreV2(dataDir, fsPort);
  const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);
  const keyring = await keyringPort.loadOrCreate().match((v) => v, (e) => {
    throw new Error(`keyring: ${e.code}`);
  });
  const tokenCodecPorts = unsafeTokenCodecPorts({ keyring, hmac, base64url, base32, bech32m });

  return {
    gate: sessionGate,
    sessionStore: sessionEventLogStore,
    snapshotStore,
    pinnedStore,
    sha256,
    crypto,
    tokenCodecPorts,
    idFactory,
    sessionGate,
    sessionEventLogStore,
  } as any;
}

function dummyCtx(v2?: any): ToolContext {
  return {
    workflowService: null as any,
    featureFlags: null as any,
    sessionManager: null,
    httpServer: null,
    ...(v2 && { v2 }),
  };
}

async function mkSignedToken(args: { v2: any; payload: unknown }): Promise<string> {
  const token = signTokenV1Binary(args.payload as any, args.v2.tokenCodecPorts);
  if (token.isErr()) throw new Error(`unexpected token sign error: ${token.error.code}`);
  return token.value;
}

describe('v2 continue_workflow: validationCriteria enforcement (mode-driven)', () => {
  it('blocks on missing required output in guided mode', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {
      const dataDir = new LocalDataDirV2(process.env);
      const localFsPort = new NodeFileSystemV2();
      const v2 = await mkV2Deps(dataDir);

      const sessionId = v2.idFactory.mintSessionId();
      const runId = v2.idFactory.mintRunId();
      const nodeId = v2.idFactory.mintNodeId();
      const attemptId = v2.idFactory.mintAttemptId();
      const workflowHash = asWorkflowHash(
        asSha256Digest('sha256:5b2d9fb885d0adc6565e1fd59e6abb3769b69e4dba5a02b6eea750137a5c0be2')
      );
      const workflowHashRef = deriveWorkflowHashRef(workflowHash)._unsafeUnwrap();

      const pinnedStore = new LocalPinnedWorkflowStoreV2(dataDir, localFsPort);
      await pinnedStore.put(workflowHash as any, {
        schemaVersion: 1,
        sourceKind: 'v1_pinned',
        workflowId: 'mode-blocking',
        name: 'Mode blocking',
        description: 'Pinned test workflow',
        version: '1.0.0',
        definition: {
          id: 'mode-blocking',
          name: 'Mode blocking',
          description: 'Pinned test workflow',
          version: '1.0.0',
          steps: [
            {
              id: 'triage',
              title: 'Triage',
              prompt: 'Do triage',
              validationCriteria: {
                type: 'contains',
                value: 'OK',
                message: 'Must contain OK',
              },
            },
          ],
        },
      } as any).match(
        () => undefined,
        (e) => {
          throw new Error(`unexpected pinned store put error: ${e.code}`);
        }
      );

      const snapshot = ExecutionSnapshotFileV1Schema.parse({
        v: 1,
        kind: 'execution_snapshot',
        enginePayload: {
          v: 1,
          engineState: {
            kind: 'running',
            completed: { kind: 'set', values: [] },
            loopStack: [],
            pending: { kind: 'some', step: { stepId: 'triage', loopPath: [] } },
          },
        },
      });
      const snapshotRef = await v2.snapshotStore.putExecutionSnapshotV1(snapshot).match(
        (v) => v,
        (e) => {
          throw new Error(`unexpected snapshot put error: ${e.code}`);
        }
      );

      await v2.sessionGate
        .withHealthySessionLock(sessionId as any, (witness) =>
          v2.sessionEventLogStore.append(witness, {
            events: [
              {
                v: 1,
                eventId: 'evt_0',
                eventIndex: 0,
                sessionId,
                kind: 'session_created',
                dedupeKey: `session_created:${sessionId}`,
                data: {},
              },
              {
                v: 1,
                eventId: 'evt_1',
                eventIndex: 1,
                sessionId,
                kind: 'run_started',
                dedupeKey: `run_started:${sessionId}:${runId}`,
                scope: { runId },
                data: { workflowId: 'mode-blocking', workflowHash, workflowSourceKind: 'project', workflowSourceRef: 'workflows/mode.json' },
              },
              {
                v: 1,
                eventId: 'evt_2',
                eventIndex: 2,
                sessionId,
                kind: 'node_created',
                dedupeKey: `node_created:${sessionId}:${runId}:${nodeId}`,
                scope: { runId, nodeId },
                data: { nodeKind: 'step', parentNodeId: null, workflowHash, snapshotRef },
              },
            ] as any,
            snapshotPins: [{ snapshotRef, eventIndex: 2, createdByEventId: 'evt_2' }],
          })
        )
        .match(
          () => undefined,
          (e) => {
            throw new Error(`unexpected seed append error: ${String((e as any).code ?? e)}`);
          }
        );

      const stateToken = await mkSignedToken({
        v2,
        payload: StateTokenPayloadV1Schema.parse({
          tokenVersion: 1,
          tokenKind: 'state',
          sessionId,
          runId,
          nodeId,
          workflowHashRef: String(workflowHashRef),
        }),
      });
      const ackToken = await mkSignedToken({
        v2,
        payload: AckTokenPayloadV1Schema.parse({
          tokenVersion: 1,
          tokenKind: 'ack',
          sessionId,
          runId,
          nodeId,
          attemptId,
        }),
      });

      const res = await handleV2ContinueWorkflow({ intent: 'advance', stateToken, ackToken } as any, dummyCtx(v2));
      expect(res.type).toBe('success');
      if (res.type !== 'success') return;

      expect(res.data.kind).toBe('blocked');
      expect(res.data.blockers.blockers[0]!.code).toBe('MISSING_REQUIRED_OUTPUT');
      expect(res.data.blockers.blockers[0]!.pointer.kind).toBe('output_contract');
      expect(res.data.blockers.blockers[0]!.pointer.contractRef).toBe('wr.validationCriteria');

      const truth = await v2.sessionEventLogStore.load(sessionId as any).match((v) => v, (e) => {
        throw new Error(`unexpected load error: ${e.code}`);
      });
      const nodes = truth.events.filter((e) => e.kind === 'node_created');
      expect(nodes.length).toBe(2);
      expect(nodes.some((e) => e.data.nodeKind === 'blocked_attempt')).toBe(true);
      expect(truth.events.filter((e) => e.kind === 'advance_recorded').length).toBe(1);
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });

  it('never-stop records gap and continues advancing (no blocked response)', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {
      const dataDir = new LocalDataDirV2(process.env);
      const localFsPort = new NodeFileSystemV2();
      const v2 = await mkV2Deps(dataDir);

      const sessionId = v2.idFactory.mintSessionId();
      const runId = v2.idFactory.mintRunId();
      const nodeId = v2.idFactory.mintNodeId();
      const attemptId = v2.idFactory.mintAttemptId();
      const workflowHash = asWorkflowHash(
        asSha256Digest('sha256:5b2d9fb885d0adc6565e1fd59e6abb3769b69e4dba5a02b6eea750137a5c0be2')
      );
      const workflowHashRef = deriveWorkflowHashRef(workflowHash)._unsafeUnwrap();

      const pinnedStore = new LocalPinnedWorkflowStoreV2(dataDir, localFsPort);
      await pinnedStore.put(workflowHash as any, {
        schemaVersion: 1,
        sourceKind: 'v1_pinned',
        workflowId: 'mode-blocking',
        name: 'Mode blocking',
        description: 'Pinned test workflow',
        version: '1.0.0',
        definition: {
          id: 'mode-blocking',
          name: 'Mode blocking',
          description: 'Pinned test workflow',
          version: '1.0.0',
          steps: [
            {
              id: 'triage',
              title: 'Triage',
              prompt: 'Do triage',
              validationCriteria: {
                type: 'contains',
                value: 'OK',
                message: 'Must contain OK',
              },
            },
          ],
        },
      } as any).match(
        () => undefined,
        (e) => {
          throw new Error(`unexpected pinned store put error: ${e.code}`);
        }
      );

      const snapshot = ExecutionSnapshotFileV1Schema.parse({
        v: 1,
        kind: 'execution_snapshot',
        enginePayload: {
          v: 1,
          engineState: {
            kind: 'running',
            completed: { kind: 'set', values: [] },
            loopStack: [],
            pending: { kind: 'some', step: { stepId: 'triage', loopPath: [] } },
          },
        },
      });
      const snapshotRef = await v2.snapshotStore.putExecutionSnapshotV1(snapshot).match(
        (v) => v,
        (e) => {
          throw new Error(`unexpected snapshot put error: ${e.code}`);
        }
      );

      await v2.sessionGate
        .withHealthySessionLock(sessionId as any, (witness) =>
          v2.sessionEventLogStore.append(witness, {
            events: [
              {
                v: 1,
                eventId: 'evt_0',
                eventIndex: 0,
                sessionId,
                kind: 'session_created',
                dedupeKey: `session_created:${sessionId}`,
                data: {},
              },
              {
                v: 1,
                eventId: 'evt_1',
                eventIndex: 1,
                sessionId,
                kind: 'run_started',
                dedupeKey: `run_started:${sessionId}:${runId}`,
                scope: { runId },
                data: { workflowId: 'mode-blocking', workflowHash, workflowSourceKind: 'project', workflowSourceRef: 'workflows/mode.json' },
              },
              {
                v: 1,
                eventId: 'evt_2',
                eventIndex: 2,
                sessionId,
                kind: 'node_created',
                dedupeKey: `node_created:${sessionId}:${runId}:${nodeId}`,
                scope: { runId, nodeId },
                data: { nodeKind: 'step', parentNodeId: null, workflowHash, snapshotRef },
              },
              {
                v: 1,
                eventId: 'evt_3',
                eventIndex: 3,
                sessionId,
                kind: 'preferences_changed',
                dedupeKey: `preferences_changed:${sessionId}:chg_01jh_test`,
                scope: { runId, nodeId },
                data: {
                  changeId: 'chg_01jh_test',
                  source: 'system',
                  delta: [{ key: 'autonomy', value: 'full_auto_never_stop' }],
                  effective: { autonomy: 'full_auto_never_stop', riskPolicy: 'conservative' },
                },
              },
            ] as any,
            snapshotPins: [{ snapshotRef, eventIndex: 2, createdByEventId: 'evt_2' }],
          })
        )
        .match(
          () => undefined,
          (e) => {
            throw new Error(`unexpected seed append error: ${String((e as any).code ?? e)}`);
          }
        );

      const stateToken = await mkSignedToken({
        v2,
        payload: StateTokenPayloadV1Schema.parse({
          tokenVersion: 1,
          tokenKind: 'state',
          sessionId,
          runId,
          nodeId,
          workflowHashRef: String(workflowHashRef),
        }),
      });
      const ackToken = await mkSignedToken({
        v2,
        payload: AckTokenPayloadV1Schema.parse({
          tokenVersion: 1,
          tokenKind: 'ack',
          sessionId,
          runId,
          nodeId,
          attemptId,
        }),
      });

      const res = await handleV2ContinueWorkflow({ intent: 'advance', stateToken, ackToken } as any, dummyCtx(v2));
      expect(res.type).toBe('success');
      if (res.type !== 'success') return;

      expect(res.data.kind).toBe('ok');
      expect(res.data.isComplete).toBe(true);

      const truth = await v2.sessionEventLogStore.load(sessionId as any).match((v) => v, (e) => {
        throw new Error(`unexpected load error: ${e.code}`);
      });
      expect(truth.events.some((e) => e.kind === 'gap_recorded')).toBe(true);

      const gap = truth.events.find((e: any) => e.kind === 'gap_recorded') as any;
      expect(gap.data.reason.category).toBe('contract_violation');
      expect(gap.data.reason.detail).toBe('missing_required_output');
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });
});
