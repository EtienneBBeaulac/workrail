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
import { NodeBase64UrlV2 } from '../../src/v2/infra/local/base64url/index.js';
import { NodeRandomEntropyV2 } from '../../src/v2/infra/local/random-entropy/index.js';
import { NodeTimeClockV2 } from '../../src/v2/infra/local/time-clock/index.js';
import { IdFactoryV2 } from '../../src/v2/infra/local/id-factory/index.js';
import { Bech32mAdapterV2 } from '../../src/v2/infra/local/bech32m/index.js';
import { signTokenV1Binary } from '../../src/v2/durable-core/tokens/index.js';
import { StateTokenPayloadV1Schema, AckTokenPayloadV1Schema } from '../../src/v2/durable-core/tokens/index.js';
import { asWorkflowHash, asSha256Digest } from '../../src/v2/durable-core/ids/index.js';
import { deriveWorkflowHashRef } from '../../src/v2/durable-core/ids/workflow-hash-ref.js';

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-blocked-'));
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
  const bech32m = new Bech32mAdapterV2();
  const snapshotStore = new LocalSnapshotStoreV2(dataDir, fsPort, crypto);
  const pinnedStore = new LocalPinnedWorkflowStoreV2(dataDir, fsPort);
  const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);
  const keyring = await keyringPort.loadOrCreate().match(v => v, e => { throw new Error(`keyring: ${e.code}`); });
  
  return {
    // Handler structure (V2Dependencies):
    gate: sessionGate,
    sessionStore: sessionEventLogStore,
    snapshotStore,
    pinnedStore,
    keyring,
    sha256,
    crypto,
    hmac,
    base64url,
    bech32m,
    idFactory,
    // Test convenience (aliases):
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
  const token = signTokenV1Binary(args.payload as any, args.v2.keyring, args.v2.hmac, args.v2.base64url, args.v2.bech32m);
  if (token.isErr()) throw new Error(`unexpected token sign error: ${token.error.code}`);
  return token.value;
}

describe('v2 continue_workflow: blocked outcome replay idempotency', () => {
  it('replays blocked outcome with blockers deterministically (no duplicate advance_recorded)', async () => {
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

      // Pin a v1-backed compiled snapshot (schemaVersion=1, sourceKind=v1_pinned) so v2 execution can run deterministically.
      const pinnedStore = new LocalPinnedWorkflowStoreV2(dataDir, localFsPort);
      await pinnedStore.put(workflowHash as any, {
        schemaVersion: 1,
        sourceKind: 'v1_pinned',
        workflowId: 'bug-investigation',
        name: 'Bug Investigation',
        description: 'Pinned test workflow',
        version: '1.0.0',
        definition: {
          id: 'bug-investigation',
          name: 'Bug Investigation',
          description: 'Pinned test workflow',
          version: '1.0.0',
          steps: [{ id: 'triage', title: 'Triage', prompt: 'Do triage' }],
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

      // Seed durable session + run + node + advance_recorded(blocked) state so replay ack attempts are valid.
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
                data: { workflowId: 'bug-investigation', workflowHash, workflowSourceKind: 'project', workflowSourceRef: 'workflows/bug.json' },
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
                kind: 'advance_recorded',
                dedupeKey: `advance_recorded:${sessionId}:${nodeId}:${attemptId}`,
                scope: { runId, nodeId },
                data: {
                  attemptId,
                  intent: 'ack_pending',
                  outcome: {
                    kind: 'blocked',
                    blockers: {
                      blockers: [
                        {
                          code: 'MISSING_REQUIRED_OUTPUT',
                          pointer: { kind: 'output_contract', contractRef: 'wr.contracts.test' },
                          message: 'Test output missing',
                          suggestedFix: 'Provide the test output payload'
                        }
                      ]
                    }
                  }
                }
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

      const statePayload = StateTokenPayloadV1Schema.parse({
        tokenVersion: 1,
        tokenKind: 'state',
        sessionId,
        runId,
        nodeId,
        workflowHashRef: String(workflowHashRef),
      });
      const ackPayload = AckTokenPayloadV1Schema.parse({
        tokenVersion: 1,
        tokenKind: 'ack',
        sessionId,
        runId,
        nodeId,
        attemptId,
      });

      const stateToken = await mkSignedToken({ v2, payload: statePayload });
      const ackToken = await mkSignedToken({ v2, payload: ackPayload });

      // First call - expect blocked outcome with blockers
      const first = await handleV2ContinueWorkflow({ stateToken, ackToken } as any, dummyCtx(v2));
      expect(first.type).toBe('success');
      if (first.type !== 'success') return;
      expect(first.data.kind).toBe('blocked');
      expect(first.data.blockers).toBeDefined();
      expect(Array.isArray(first.data.blockers.blockers)).toBe(true);
      expect(first.data.blockers.blockers.length).toBe(1);
      expect(first.data.blockers.blockers[0].code).toBe('MISSING_REQUIRED_OUTPUT');
      expect(first.data.blockers.blockers[0].pointer.kind).toBe('output_contract');
      expect(first.data.blockers.blockers[0].pointer.contractRef).toBe('wr.contracts.test');

      // Second call with same tokens - must return exact same response
      const second = await handleV2ContinueWorkflow({ stateToken, ackToken } as any, dummyCtx(v2));
      expect(second.type).toBe('success');
      if (second.type !== 'success') return;
      expect(second.data.kind).toBe('blocked');
      expect(second.data.blockers).toBeDefined();
      expect(second).toEqual(first);

      // Verify idempotency: load durable truth and check for exactly one advance_recorded event
      const truth = await v2.sessionEventLogStore.load(sessionId as any).match(
        (v) => v,
        (e) => {
          throw new Error(`unexpected load error: ${e.code}`);
        }
      );
      const advanceRecordedEvents = truth.events.filter((e) => e.kind === 'advance_recorded');
      expect(advanceRecordedEvents.length).toBe(1);
      expect(advanceRecordedEvents[0].data.outcome.kind).toBe('blocked');
      expect(advanceRecordedEvents[0].data.outcome.blockers).toBeDefined();
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });

  it('maintains deterministic blocker response across multiple replays', async () => {
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

      // Pin workflow
      const pinnedStore = new LocalPinnedWorkflowStoreV2(dataDir, localFsPort);
      await pinnedStore.put(workflowHash as any, {
        schemaVersion: 1,
        sourceKind: 'v1_pinned',
        workflowId: 'bug-investigation',
        name: 'Bug Investigation',
        description: 'Pinned test workflow',
        version: '1.0.0',
        definition: {
          id: 'bug-investigation',
          name: 'Bug Investigation',
          description: 'Pinned test workflow',
          version: '1.0.0',
          steps: [{ id: 'triage', title: 'Triage', prompt: 'Do triage' }],
        },
      } as any).match(
        () => undefined,
        (e) => {
          throw new Error(`unexpected pinned store put error: ${e.code}`);
        }
      );

      // Create snapshot
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

      // Seed session with multiple blockers
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
                data: { workflowId: 'bug-investigation', workflowHash, workflowSourceKind: 'project', workflowSourceRef: 'workflows/bug.json' },
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
                kind: 'advance_recorded',
                dedupeKey: `advance_recorded:${sessionId}:${nodeId}:${attemptId}`,
                scope: { runId, nodeId },
                data: {
                  attemptId,
                  intent: 'ack_pending',
                  outcome: {
                    kind: 'blocked',
                    blockers: {
                      blockers: [
                        {
                          code: 'MISSING_REQUIRED_OUTPUT',
                          pointer: { kind: 'output_contract', contractRef: 'wr.contracts.triage_result' },
                          message: 'Triage result output is required',
                          suggestedFix: 'Complete the triage analysis and provide structured output'
                        },
                        {
                          code: 'REQUIRED_CAPABILITY_UNAVAILABLE',
                          pointer: { kind: 'capability', capability: 'web_browsing' },
                          message: 'Web browsing capability is required but unavailable',
                          suggestedFix: 'Enable web browsing capability in workflow configuration'
                        }
                      ]
                    }
                  }
                }
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

      const statePayload = StateTokenPayloadV1Schema.parse({
        tokenVersion: 1,
        tokenKind: 'state',
        sessionId,
        runId,
        nodeId,
        workflowHashRef: String(workflowHashRef),
      });
      const ackPayload = AckTokenPayloadV1Schema.parse({
        tokenVersion: 1,
        tokenKind: 'ack',
        sessionId,
        runId,
        nodeId,
        attemptId,
      });

      const stateToken = await mkSignedToken({ v2, payload: statePayload });
      const ackToken = await mkSignedToken({ v2, payload: ackPayload });

      // Call three times - all must be identical
      const response1 = await handleV2ContinueWorkflow({ stateToken, ackToken } as any, dummyCtx(v2));
      expect(response1.type).toBe('success');
      if (response1.type !== 'success') return;
      expect(response1.data.kind).toBe('blocked');
      expect(response1.data.blockers.blockers.length).toBe(2);

      const response2 = await handleV2ContinueWorkflow({ stateToken, ackToken } as any, dummyCtx(v2));
      expect(response2).toEqual(response1);

      const response3 = await handleV2ContinueWorkflow({ stateToken, ackToken } as any, dummyCtx(v2));
      expect(response3).toEqual(response1);

      // Verify only one advance_recorded exists
      const truth = await v2.sessionEventLogStore.load(sessionId as any).match(
        (v) => v,
        (e) => {
          throw new Error(`unexpected load error: ${e.code}`);
        }
      );
      const advanceRecordedCount = truth.events.filter((e) => e.kind === 'advance_recorded').length;
      expect(advanceRecordedCount).toBe(1);

      // Verify blocker order and content is preserved
      const advanceEvent = truth.events.find((e) => e.kind === 'advance_recorded');
      expect(advanceEvent).toBeDefined();
      if (advanceEvent) {
        expect(advanceEvent.data.outcome.blockers.blockers[0].code).toBe('MISSING_REQUIRED_OUTPUT');
        expect(advanceEvent.data.outcome.blockers.blockers[1].code).toBe('REQUIRED_CAPABILITY_UNAVAILABLE');
      }
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });
});
