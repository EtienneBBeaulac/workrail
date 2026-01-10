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
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-concurrent-'));
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

describe('Blocked node concurrent retries (idempotency + race safety)', () => {
  afterEach(() => {
    delete process.env.WORKRAIL_DATA_DIR;
  });

  it('parallel retries with same retryAckToken → one advances, one gets TOKEN_SESSION_LOCKED', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {
      const workflowId = 'parallel-retry-test';
      const ctx = await mkCtxWithWorkflow(workflowId, {
        id: workflowId,
        name: 'Parallel retry test',
        description: 'Tests parallel retries with same token',
        version: '1.0.0',
        steps: [
          {
            id: 'step_validated',
            title: 'Validated step',
            prompt: 'Return output with "status" keyword.',
            validationCriteria: [
              { type: 'contains', value: 'status', message: 'Must contain status' },
            ],
          },
          { id: 'step_next', title: 'Next', prompt: 'Next' },
        ],
      });

      const startRes = await handleV2StartWorkflow({ workflowId } as V2StartWorkflowInput, ctx);
      expect(startRes.type).toBe('success');
      if (startRes.type !== 'success') return;

      // Block
      const blockRes = await handleV2ContinueWorkflow(
        { stateToken: startRes.data.stateToken, ackToken: startRes.data.ackToken!, output: { notesMarkdown: 'invalid' } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(blockRes.type).toBe('success');
      if (blockRes.type !== 'success') return;
      expect(blockRes.data.kind).toBe('blocked');
      if (blockRes.data.kind !== 'blocked') return;

      const retryToken = blockRes.data.retryAckToken!;
      const blockedState = blockRes.data.stateToken;

      // Parallel retries with Promise.all (simulates concurrent agent calls)
      const [retry1Res, retry2Res] = await Promise.all([
        handleV2ContinueWorkflow(
          { stateToken: blockedState, ackToken: retryToken, output: { notesMarkdown: 'has status now' } } as V2ContinueWorkflowInput,
          ctx
        ),
        handleV2ContinueWorkflow(
          { stateToken: blockedState, ackToken: retryToken, output: { notesMarkdown: 'also has status' } } as V2ContinueWorkflowInput,
          ctx
        ),
      ]);

      // One succeeds, one gets lock busy error (order non-deterministic)
      const results = [retry1Res, retry2Res];
      const successResults = results.filter((r) => r.type === 'success');
      const errorResults = results.filter((r) => r.type === 'error');

      expect(successResults.length).toBe(1);
      expect(errorResults.length).toBe(1);

      const successRes = successResults[0]!;
      const errorRes = errorResults[0]!;

      // Success result should be 'ok' (advanced)
      expect(successRes.type).toBe('success');
      if (successRes.type === 'success') {
        expect(successRes.data.kind).toBe('ok');
      }

      // Error result should be TOKEN_SESSION_LOCKED (retryable)
      expect(errorRes.type).toBe('error');
      if (errorRes.type === 'error') {
        expect(errorRes.code).toBe('TOKEN_SESSION_LOCKED');
        expect(errorRes.retry.kind).toBe('retryable_after_ms');
      }

      // Verify: only ONE step node created (winner advances, loser didn't)
      const sessionStore = ctx.v2!.sessionEventLogStore as any;
      const bech32m = new Bech32mAdapterV2();
      const base32 = new Base32AdapterV2();
      const parsedState = parseTokenV1Binary(startRes.data.stateToken, { bech32m, base32 })._unsafeUnwrap();
      const sessionId = asSessionId(parsedState.payload.sessionId);
      const loadRes = await sessionStore.load(sessionId);
      if (loadRes.isErr()) throw new Error(`Unexpected load error: ${loadRes.error.code}`);
      const truth = loadRes.value;

      const stepNodes = truth.events.filter((e) => e.kind === 'node_created' && e.data.nodeKind === 'step');
      expect(stepNodes.length).toBe(2); // Root + advanced step (not duplicate)
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });

  it('retry with original ackToken (not retryAckToken) after block → replays blocked state', async () => {
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
          {
            id: 'step_val',
            title: 'Validated',
            prompt: 'Return "ok".',
            validationCriteria: [{ type: 'contains', value: 'ok', message: 'Must contain ok' }],
          },
          { id: 'step_next', title: 'Next', prompt: 'Next' },
        ],
      });

      const startRes = await handleV2StartWorkflow({ workflowId } as V2StartWorkflowInput, ctx);
      expect(startRes.type).toBe('success');
      if (startRes.type !== 'success') return;

      const originalAck = startRes.data.ackToken!;

      // Block
      const blockRes = await handleV2ContinueWorkflow(
        { stateToken: startRes.data.stateToken, ackToken: originalAck, output: { notesMarkdown: 'bad' } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(blockRes.type).toBe('success');
      if (blockRes.type !== 'success') return;
      expect(blockRes.data.kind).toBe('blocked');
      if (blockRes.data.kind !== 'blocked') return;

      const retryToken = blockRes.data.retryAckToken!;

      // Retry succeeds with retryAckToken
      const retryRes = await handleV2ContinueWorkflow(
        { stateToken: blockRes.data.stateToken, ackToken: retryToken, output: { notesMarkdown: 'ok' } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(retryRes.type).toBe('success');
      if (retryRes.type !== 'success') return;
      expect(retryRes.data.kind).toBe('ok');

      // Now use original ackToken again → should replay blocked state (not advance)
      const replayOriginalRes = await handleV2ContinueWorkflow(
        { stateToken: startRes.data.stateToken, ackToken: originalAck, output: { notesMarkdown: 'different' } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(replayOriginalRes.type).toBe('success');
      if (replayOriginalRes.type !== 'success') return;
      expect(replayOriginalRes.data.kind).toBe('blocked');
      if (replayOriginalRes.data.kind !== 'blocked') return;

      // Should return same retryAckToken (fact-returning replay)
      expect(replayOriginalRes.data.retryAckToken).toBe(retryToken);
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });

  it('dedupeKey prevents duplicate advances: retry twice sequentially with same token → idempotent', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {
      const workflowId = 'dedupe-test';
      const ctx = await mkCtxWithWorkflow(workflowId, {
        id: workflowId,
        name: 'Dedupe test',
        description: 'Tests dedupeKey idempotency',
        version: '1.0.0',
        steps: [
          {
            id: 'step_validated',
            title: 'Validated step',
            prompt: 'Return output with "status" keyword.',
            validationCriteria: [
              { type: 'contains', value: 'status', message: 'Must contain status' },
            ],
          },
          { id: 'step_next', title: 'Next', prompt: 'Next' },
        ],
      });

      const startRes = await handleV2StartWorkflow({ workflowId } as V2StartWorkflowInput, ctx);
      expect(startRes.type).toBe('success');
      if (startRes.type !== 'success') return;

      const blockRes = await handleV2ContinueWorkflow(
        { stateToken: startRes.data.stateToken, ackToken: startRes.data.ackToken!, output: { notesMarkdown: 'invalid' } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(blockRes.type).toBe('success');
      if (blockRes.type !== 'success') return;
      expect(blockRes.data.kind).toBe('blocked');
      if (blockRes.data.kind !== 'blocked') return;

      const retryToken = blockRes.data.retryAckToken!;

      // First retry (advances)
      const retry1Res = await handleV2ContinueWorkflow(
        { stateToken: blockRes.data.stateToken, ackToken: retryToken, output: { notesMarkdown: 'has status A' } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(retry1Res.type).toBe('success');
      if (retry1Res.type !== 'success') return;
      expect(retry1Res.data.kind).toBe('ok');

      // Second retry with same token (should replay, not create duplicate)
      const retry2Res = await handleV2ContinueWorkflow(
        { stateToken: blockRes.data.stateToken, ackToken: retryToken, output: { notesMarkdown: 'has status B' } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(retry2Res.type).toBe('success');
      if (retry2Res.type !== 'success') return;
      expect(retry2Res.data.kind).toBe('ok');

      // Both see same final state
      expect(retry1Res.data.stateToken).toBe(retry2Res.data.stateToken);

      // Verify: only ONE step node created (dedupeKey prevented duplicate)
      const sessionStore = ctx.v2!.sessionEventLogStore as any;
      const bech32m = new Bech32mAdapterV2();
      const base32 = new Base32AdapterV2();
      const parsedState = parseTokenV1Binary(startRes.data.stateToken, { bech32m, base32 })._unsafeUnwrap();
      const sessionId = asSessionId(parsedState.payload.sessionId);
      const loadRes = await sessionStore.load(sessionId);
      if (loadRes.isErr()) throw new Error(`Unexpected load error: ${loadRes.error.code}`);
      const truth = loadRes.value;

      const stepNodes = truth.events.filter((e) => e.kind === 'node_created' && e.data.nodeKind === 'step');
      expect(stepNodes.length).toBe(2); // Root + advanced step (not duplicate)

      const outputs = truth.events.filter((e) => e.kind === 'node_output_appended');
      expect(outputs.length).toBeLessThanOrEqual(1); // At most one output from first advance
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });
});
