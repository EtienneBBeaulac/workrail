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
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-idempotency-'));
}

async function mkCtxWithWorkflow(workflowId: string, definition: any): Promise<ToolContext> {
  const wf = createWorkflow(definition as any, createProjectDirectorySource(path.join(os.tmpdir(), 'workrail-project')));
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
  const tokenCodecPorts = unsafeTokenCodecPorts({ keyring: keyringRes.value, hmac, base64url, base32, bech32m });

  return {
    workflowService: {
      listWorkflowSummaries: async () => [],
      getWorkflowById: async (id: string) => (id === workflowId ? wf : null),
      getNextStep: async () => { throw new Error('not used'); },
      validateStepOutput: async () => ({ valid: true, issues: [], suggestions: [] }),
    } as any,
    featureFlags: null as any,
    sessionManager: null,
    httpServer: null,
    v2: { gate, sessionStore, snapshotStore, pinnedStore, sha256, crypto, idFactory, tokenCodecPorts, sessionEventLogStore: sessionStore },
  };
}

describe('Blocked node idempotency (dedupeKey enforcement)', () => {
  afterEach(() => {
    delete process.env.WORKRAIL_DATA_DIR;
  });

  it('retry with same retryAckToken twice is idempotent', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {
      const workflowId = 'idempotent-test';
      const ctx = await mkCtxWithWorkflow(workflowId, {
        id: workflowId,
        name: 'Idempotent test',
        description: 'Tests idempotency',
        version: '1.0.0',
        steps: [
          { id: 'step1', title: 'Step 1', prompt: 'Return "result".', validationCriteria: [{ type: 'contains', value: 'result', message: 'Must contain result' }] },
          { id: 'step2', title: 'Step 2', prompt: 'Step 2' },
        ],
      });

      const startRes = await handleV2StartWorkflow({ workflowId } as V2StartWorkflowInput, ctx);
      expect(startRes.type).toBe('success');
      if (startRes.type !== 'success') return;

      const blockRes = await handleV2ContinueWorkflow(
        { intent: 'advance', stateToken: startRes.data.stateToken, ackToken: startRes.data.ackToken!, output: { notesMarkdown: 'invalid' } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(blockRes.type).toBe('success');
      if (blockRes.type !== 'success') return;
      expect(blockRes.data.kind).toBe('blocked');
      if (blockRes.data.kind !== 'blocked') return;

      const retryToken = blockRes.data.retryAckToken!;

      // First retry (advances)
      const retry1Res = await handleV2ContinueWorkflow(
        { intent: 'advance', stateToken: blockRes.data.stateToken, ackToken: retryToken, output: { notesMarkdown: 'result A' } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(retry1Res.type).toBe('success');
      if (retry1Res.type !== 'success') return;
      expect(retry1Res.data.kind).toBe('ok');

      // Second retry with same token (should replay)
      const retry2Res = await handleV2ContinueWorkflow(
        { intent: 'advance', stateToken: blockRes.data.stateToken, ackToken: retryToken, output: { notesMarkdown: 'result B' } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(retry2Res.type).toBe('success');
      if (retry2Res.type !== 'success') return;
      expect(retry2Res.data.kind).toBe('ok');

      // Both return same stateToken (idempotent)
      expect(retry1Res.data.stateToken).toBe(retry2Res.data.stateToken);

      // Verify: only ONE advance_recorded event for retry
      const sessionStore = ctx.v2!.sessionEventLogStore as any;
      const bech32m = new Bech32mAdapterV2();
      const base32 = new Base32AdapterV2();
      const parsedState = parseTokenV1Binary(startRes.data.stateToken, { bech32m, base32 })._unsafeUnwrap();
      const sessionId = asSessionId(parsedState.payload.sessionId);
      const loadRes = await sessionStore.load(sessionId);
      if (loadRes.isErr()) throw new Error(`Unexpected load error: ${loadRes.error.code}`);
      const truth = loadRes.value;

      const advanceEvents = truth.events.filter((e) => e.kind === 'advance_recorded');
      // Should have: initial block + retry (not duplicate retry)
      expect(advanceEvents.length).toBe(2);
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });

  it('original ackToken still works after retry succeeds (replays old blocked state)', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {
      const workflowId = 'original-ack-test';
      const ctx = await mkCtxWithWorkflow(workflowId, {
        id: workflowId,
        name: 'Original ack test',
        description: 'Tests original ack replay',
        version: '1.0.0',
        steps: [
          { id: 'step1', title: 'Step 1', prompt: 'Return "done".', validationCriteria: [{ type: 'contains', value: 'done', message: 'Must contain done' }] },
          { id: 'step2', title: 'Step 2', prompt: 'Step 2' },
        ],
      });

      const startRes = await handleV2StartWorkflow({ workflowId } as V2StartWorkflowInput, ctx);
      expect(startRes.type).toBe('success');
      if (startRes.type !== 'success') return;

      const originalAck = startRes.data.ackToken!;

      // Block
      const blockRes = await handleV2ContinueWorkflow(
        { intent: 'advance', stateToken: startRes.data.stateToken, ackToken: originalAck, output: { notesMarkdown: 'bad' } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(blockRes.type).toBe('success');
      if (blockRes.type !== 'success') return;
      expect(blockRes.data.kind).toBe('blocked');
      if (blockRes.data.kind !== 'blocked') return;

      // Retry successfully
      const retryRes = await handleV2ContinueWorkflow(
        { intent: 'advance', stateToken: blockRes.data.stateToken, ackToken: blockRes.data.retryAckToken!, output: { notesMarkdown: 'done' } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(retryRes.type).toBe('success');
      if (retryRes.type !== 'success') return;
      expect(retryRes.data.kind).toBe('ok');

      // Use original ackToken again (should replay blocked state, not advance)
      const replayOriginalRes = await handleV2ContinueWorkflow(
        { intent: 'advance', stateToken: startRes.data.stateToken, ackToken: originalAck, output: { notesMarkdown: 'different' } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(replayOriginalRes.type).toBe('success');
      if (replayOriginalRes.type !== 'success') return;
      expect(replayOriginalRes.data.kind).toBe('blocked');
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });
});
