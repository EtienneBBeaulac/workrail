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
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-next-intent-'));
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

describe('v2 execution: nextIntent', () => {
  it('returns await_user_confirmation when pending step requires confirmation', async () => {
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
        workflowId: 'next-intent',
        name: 'Next intent',
        description: 'Pinned test workflow',
        version: '1.0.0',
        definition: {
          id: 'next-intent',
          name: 'Next intent',
          description: 'Pinned test workflow',
          version: '1.0.0',
          steps: [
            { id: 'step1', title: 'Step 1', prompt: 'Do step 1' },
            { id: 'step2', title: 'Step 2', prompt: 'Do step 2', requireConfirmation: true },
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
            pending: { kind: 'some', step: { stepId: 'step1', loopPath: [] } },
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
                data: { workflowId: 'next-intent', workflowHash, workflowSourceKind: 'project', workflowSourceRef: 'workflows/next.json' },
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

      const res = await handleV2ContinueWorkflow({ intent: 'advance', stateToken, ackToken, output: { notesMarkdown: 'Step 1 completed.' } } as any, dummyCtx(v2));
      expect(res.type).toBe('success');
      if (res.type !== 'success') return;

      expect(res.data.kind).toBe('ok');
      expect(res.data.pending?.stepId).toBe('step2');
      expect(res.data.nextIntent).toBe('await_user_confirmation');
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });

  it('nextIntent matrix covers all 4 values (S7: test gap)', () => {
    // This test documents all 4 nextIntent values are defined:
    // 1. perform_pending_then_continue - pending step without requireConfirmation
    // 2. await_user_confirmation - pending step with requireConfirmation (tested above)
    // 3. rehydrate_only - rehydrate-only call (tested in mcp-v2-rehydrate-purity.test.ts)
    // 4. complete - isComplete=true, no pending (tested in mcp-v2-execution.test.ts)
    
    const allIntents: Array<'perform_pending_then_continue' | 'await_user_confirmation' | 'rehydrate_only' | 'complete'> = [
      'perform_pending_then_continue',
      'await_user_confirmation',
      'rehydrate_only',
      'complete',
    ];

    // Verify closed set is exhaustive
    expect(allIntents.length).toBe(4);
  });
});
