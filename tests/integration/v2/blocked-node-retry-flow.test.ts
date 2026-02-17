import 'reflect-metadata';
import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { handleV2StartWorkflow, handleV2ContinueWorkflow } from '../../../src/mcp/handlers/v2-execution.js';
import type { ToolContext } from '../../../src/mcp/types.js';
import type { V2StartWorkflowInput, V2ContinueWorkflowInput } from '../../../src/mcp/v2/tools.js';

import { createWorkflow } from '../../../src/types/workflow.js';
import { createProjectDirectorySource } from '../../../src/types/workflow-source.js';

import { LocalDataDirV2 } from '../../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../../src/v2/infra/local/fs/index.js';
import { NodeSha256V2 } from '../../../src/v2/infra/local/sha256/index.js';
import { LocalSessionEventLogStoreV2 } from '../../../src/v2/infra/local/session-store/index.js';
import { LocalSessionLockV2 } from '../../../src/v2/infra/local/session-lock/index.js';
import { NodeCryptoV2 } from '../../../src/v2/infra/local/crypto/index.js';
import { LocalSnapshotStoreV2 } from '../../../src/v2/infra/local/snapshot-store/index.js';
import { LocalPinnedWorkflowStoreV2 } from '../../../src/v2/infra/local/pinned-workflow-store/index.js';
import { ExecutionSessionGateV2 } from '../../../src/v2/usecases/execution-session-gate.js';

import { unsafeTokenCodecPorts, parseTokenV1Binary } from '../../../src/v2/durable-core/tokens/index.js';
import { NodeHmacSha256V2 } from '../../../src/v2/infra/local/hmac-sha256/index.js';
import { NodeBase64UrlV2 } from '../../../src/v2/infra/local/base64url/index.js';
import { LocalKeyringV2 } from '../../../src/v2/infra/local/keyring/index.js';
import { NodeRandomEntropyV2 } from '../../../src/v2/infra/local/random-entropy/index.js';
import { NodeTimeClockV2 } from '../../../src/v2/infra/local/time-clock/index.js';
import { IdFactoryV2 } from '../../../src/v2/infra/local/id-factory/index.js';
import { Bech32mAdapterV2 } from '../../../src/v2/infra/local/bech32m/index.js';
import { Base32AdapterV2 } from '../../../src/v2/infra/local/base32/index.js';
import { asSessionId } from '../../../src/v2/durable-core/ids/index.js';

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-retry-'));
}

async function mkCtxWithWorkflow(workflowId: string, definition: any): Promise<ToolContext> {
  const wf = createWorkflow(
    definition as any,
    createProjectDirectorySource(path.join(os.tmpdir(), 'workrail-project'))
  );

  const dataDir = new LocalDataDirV2(process.env);
  const fsPort = new NodeFileSystemV2();
  const sha256 = new NodeSha256V2();
  const crypto = new NodeCryptoV2();
  const sessionStore = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha256);
  const clock = new NodeTimeClockV2();
  const lockPort = new LocalSessionLockV2(dataDir, fsPort, clock);
  const gate = new ExecutionSessionGateV2(lockPort, sessionStore);
  const snapshotStore = new LocalSnapshotStoreV2(dataDir, fsPort, crypto);
  const pinnedStore = new LocalPinnedWorkflowStoreV2(dataDir, fsPort);
  const hmac = new NodeHmacSha256V2();
  const base64url = new NodeBase64UrlV2();
  const entropy = new NodeRandomEntropyV2();
  const idFactory = new IdFactoryV2(entropy);
  const base32 = new Base32AdapterV2();
  const bech32m = new Bech32mAdapterV2();
  const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);
  const keyringRes = await keyringPort.loadOrCreate();
  if (keyringRes.isErr()) throw new Error(`keyring load failed: ${keyringRes.error.code}`);

  const tokenCodecPorts = unsafeTokenCodecPorts({
    keyring: keyringRes.value,
    hmac,
    base64url,
    base32,
    bech32m,
  });

  return {
    workflowService: {
      listWorkflowSummaries: async () => [],
      getWorkflowById: async (id: string) => (id === workflowId ? wf : null),
      getNextStep: async () => {
        throw new Error('not used');
      },
      validateStepOutput: async () => ({ valid: true, issues: [], suggestions: [] }),
    } as any,
    featureFlags: null as any,
    sessionManager: null,
    httpServer: null,
    v2: {
      gate,
      sessionStore,
      snapshotStore,
      pinnedStore,
      sha256,
      crypto,
      idFactory,
      tokenCodecPorts,
      sessionEventLogStore: sessionStore,
    },
  };
}

describe('Blocked node retry flow (end-to-end)', () => {
  afterEach(() => {
    delete process.env.WORKRAIL_DATA_DIR;
  });

  it('blocks on invalid output → replays blocked → retries with retryAckToken → advances', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {
      const workflowId = 'retry-test';
      const ctx = await mkCtxWithWorkflow(workflowId, {
        id: workflowId,
        name: 'Retry test',
        description: 'Tests retry flow',
        version: '1.0.0',
        steps: [
          {
            id: 'step_with_validation',
            title: 'Step with validation',
            prompt: 'Return JSON with status field.',
            validationCriteria: [
              { type: 'contains', value: 'status', message: 'Output must contain "status"' },
            ],
          },
          { id: 'step_next', title: 'Next step', prompt: 'Next step prompt' },
        ],
      });

      // 1. Start workflow
      const startRes = await handleV2StartWorkflow(
        { workflowId } as V2StartWorkflowInput,
        ctx
      );
      expect(startRes.type).toBe('success');
      if (startRes.type !== 'success') return;

      const { stateToken, ackToken } = startRes.data;
      expect(ackToken).toBeDefined();

      // 2. Advance with invalid output (missing "status") → should block
      const blockRes = await handleV2ContinueWorkflow(
        { stateToken, ackToken: ackToken!, output: { notesMarkdown: 'invalid output' } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(blockRes.type).toBe('success');
      if (blockRes.type !== 'success') return;

      expect(blockRes.data.kind).toBe('blocked');
      if (blockRes.data.kind !== 'blocked') return;
      
      expect(blockRes.data.retryable).toBe(true);
      expect(blockRes.data.retryAckToken).toBeDefined();
      expect(blockRes.data.validation).toBeDefined();
      expect(blockRes.data.validation?.issues.length).toBeGreaterThan(0);

      const blockedStateToken = blockRes.data.stateToken;
      const retryAckToken = blockRes.data.retryAckToken!;

      // 3. Verify event log: validation_performed event exists with eventIndex < node eventIndex.
      const sessionStore = ctx.v2!.sessionEventLogStore as any;
      const bech32m = new Bech32mAdapterV2();
      const base32 = new Base32AdapterV2();
      const parsedState = parseTokenV1Binary(stateToken, { bech32m, base32 })._unsafeUnwrap();
      const sessionId = asSessionId(parsedState.payload.sessionId);
      const loadRes = await sessionStore.load(sessionId);
      if (loadRes.isErr()) throw new Error(`Unexpected load error: ${loadRes.error.code}`);
      const truth1 = loadRes.value;
      
      const validationEvents = truth1.events.filter((e) => e.kind === 'validation_performed');
      const blockedNodes = truth1.events.filter((e) => e.kind === 'node_created' && e.data.nodeKind === 'blocked_attempt');
      expect(validationEvents.length).toBe(1);
      expect(blockedNodes.length).toBe(1);
      expect(validationEvents[0]!.eventIndex).toBeLessThan(blockedNodes[0]!.eventIndex);

      // 4. Replay original ackToken → should return same blocked response (idempotency).
      const replayRes = await handleV2ContinueWorkflow(
        { stateToken, ackToken: ackToken! } as V2ContinueWorkflowInput,
        ctx
      );
      expect(replayRes.type).toBe('success');
      if (replayRes.type !== 'success') return;
      
      expect(replayRes.data.kind).toBe('blocked');
      if (replayRes.data.kind !== 'blocked') return;
      expect(replayRes.data.retryAckToken).toBe(retryAckToken);

      // 5. Retry with retryAckToken + valid output → should advance successfully.
      const retryRes = await handleV2ContinueWorkflow(
        { stateToken: blockedStateToken, ackToken: retryAckToken, output: { notesMarkdown: 'valid with status' } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(retryRes.type).toBe('success');
      if (retryRes.type !== 'success') return;

      expect(retryRes.data.kind).toBe('ok');
      if (retryRes.data.kind !== 'ok') return;
      
      // 6. Verify edge created: from blocked node to next step.
      const loadRes2 = await sessionStore.load(sessionId);
      if (loadRes2.isErr()) throw new Error(`Unexpected load error: ${loadRes2.error.code}`);
      const truth2 = loadRes2.value;
      
      const edges = truth2.events.filter((e) => e.kind === 'edge_created');
      const fromBlocked = edges.find((e) => e.data.fromNodeId === blockedNodes[0]!.scope.nodeId);
      expect(fromBlocked).toBeDefined();
      expect(fromBlocked!.data.edgeKind).toBe('acked_step');
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });

  it.skip('terminal block (from evaluation error) has no retryAckToken - TODO: ValidationEngine errors need terminal block path', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {
      const workflowId = 'terminal-eval-error-test';
      const ctx = await mkCtxWithWorkflow(workflowId, {
        id: workflowId,
        name: 'Terminal eval error test',
        description: 'Tests terminal block from validation engine error',
        version: '1.0.0',
        steps: [
          {
            id: 'step_bad_schema',
            title: 'Bad schema step',
            prompt: 'Return JSON.',
            validationCriteria: [
              {
                type: 'schema',
                schema: { type: 'invalid_type_triggers_error' }, // Invalid schema → triggers evaluation_threw
                message: 'Must match schema',
              },
            ],
          },
          { id: 'step_next', title: 'Next', prompt: 'Next' },
        ],
      });

      const startRes = await handleV2StartWorkflow({ workflowId } as V2StartWorkflowInput, ctx);
      expect(startRes.type).toBe('success');
      if (startRes.type !== 'success') return;

      // Advance with any output → ValidationEngine throws on bad schema → should create terminal block
      const blockRes = await handleV2ContinueWorkflow(
        { stateToken: startRes.data.stateToken, ackToken: startRes.data.ackToken!, output: { notesMarkdown: '{"test": true}' } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(blockRes.type).toBe('success');
      if (blockRes.type !== 'success') return;

      expect(blockRes.data.kind).toBe('blocked');
      if (blockRes.data.kind !== 'blocked') return;

      // Terminal block: retryable=false, no retryAckToken
      expect(blockRes.data.retryable).toBe(false);
      expect(blockRes.data.retryAckToken).toBeUndefined();

      // Verify blocked_attempt node was created (terminal blocks ARE nodes)
      const sessionStore = ctx.v2!.sessionEventLogStore as any;
      const bech32m = new Bech32mAdapterV2();
      const base32 = new Base32AdapterV2();
      const parsedState = parseTokenV1Binary(startRes.data.stateToken, { bech32m, base32 })._unsafeUnwrap();
      const sessionId = asSessionId(parsedState.payload.sessionId);
      const loadRes = await sessionStore.load(sessionId);
      if (loadRes.isErr()) throw new Error(`Unexpected load error: ${loadRes.error.code}`);
      const truth = loadRes.value;

      const blockedNodes = truth.events.filter((e) => e.kind === 'node_created' && e.data.nodeKind === 'blocked_attempt');
      expect(blockedNodes.length).toBe(1);

      // Load snapshot and verify it's terminal_block kind
      const snapshotStore = ctx.v2!.snapshotStore as any;
      const blockedNode = blockedNodes[0]!;
      const snapRes = await snapshotStore.getExecutionSnapshotV1(blockedNode.data.snapshotRef);
      if (snapRes.isErr()) throw new Error(`Snapshot load error: ${snapRes.error.code}`);
      const snap = snapRes.value;

      expect(snap?.enginePayload.engineState.kind).toBe('blocked');
      if (snap?.enginePayload.engineState.kind === 'blocked') {
        expect(snap.enginePayload.engineState.blocked.kind).toBe('terminal_block');
        expect(snap.enginePayload.engineState.blocked.reason.kind).toBe('evaluation_error');
      }
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });

  it('retry that blocks again creates chained blocked nodes', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {
      const workflowId = 'chain-test';
      const ctx = await mkCtxWithWorkflow(workflowId, {
        id: workflowId,
        name: 'Chain test',
        description: 'Tests chained blocks',
        version: '1.0.0',
        steps: [
          {
            id: 'step_strict',
            title: 'Strict validation',
            prompt: 'Return JSON with both status and code.',
            validationCriteria: [
              { type: 'contains', value: 'status', message: 'Must contain status' },
              { type: 'contains', value: 'code', message: 'Must contain code' },
            ],
          },
          { id: 'step_next', title: 'Next', prompt: 'Next' },
        ],
      });

      const startRes = await handleV2StartWorkflow(
        { workflowId } as V2StartWorkflowInput,
        ctx
      );
      expect(startRes.type).toBe('success');
      if (startRes.type !== 'success') return;

      const { stateToken: st1, ackToken: ack1 } = startRes.data;

      // Block 1: missing both status and code.
      const block1Res = await handleV2ContinueWorkflow(
        { stateToken: st1, ackToken: ack1!, output: { notesMarkdown: 'invalid' } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(block1Res.type).toBe('success');
      if (block1Res.type !== 'success') return;
      expect(block1Res.data.kind).toBe('blocked');
      if (block1Res.data.kind !== 'blocked') return;

      const retry1Token = block1Res.data.retryAckToken!;
      expect(retry1Token).toBeDefined();

      // Retry 1: has "status" but still missing "code" → should block again (chained).
      const block2Res = await handleV2ContinueWorkflow(
        { stateToken: block1Res.data.stateToken, ackToken: retry1Token, output: { notesMarkdown: 'has status' } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(block2Res.type).toBe('success');
      if (block2Res.type !== 'success') return;
      expect(block2Res.data.kind).toBe('blocked');
      if (block2Res.data.kind !== 'blocked') return;

      const retry2Token = block2Res.data.retryAckToken!;
      expect(retry2Token).toBeDefined();
      expect(retry2Token).not.toBe(retry1Token);

      // Verify DAG: 2 blocked nodes chained.
      const sessionStore = ctx.v2!.sessionEventLogStore as any;
      const bech32m = new Bech32mAdapterV2();
      const base32 = new Base32AdapterV2();
      const parsedState = parseTokenV1Binary(st1, { bech32m, base32 })._unsafeUnwrap();
      const sessionId = asSessionId(parsedState.payload.sessionId);
      const loadRes = await sessionStore.load(sessionId);
      if (loadRes.isErr()) throw new Error(`Unexpected load error: ${loadRes.error.code}`);
      const truth = loadRes.value;

      const blockedNodes = truth.events.filter((e) => e.kind === 'node_created' && e.data.nodeKind === 'blocked_attempt');
      expect(blockedNodes.length).toBe(2);
      expect(blockedNodes[1]!.data.parentNodeId).toBe(blockedNodes[0]!.scope.nodeId);

      // Retry 2: has both "status" and "code" → should advance.
      const retrySuccessRes = await handleV2ContinueWorkflow(
        { stateToken: block2Res.data.stateToken, ackToken: retry2Token, output: { notesMarkdown: 'has status and code' } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(retrySuccessRes.type).toBe('success');
      if (retrySuccessRes.type !== 'success') return;
      expect(retrySuccessRes.data.kind).toBe('ok');
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });
});
