import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { handleV2ContinueWorkflow, handleV2StartWorkflow } from '../../src/mcp/handlers/v2-execution.js';
import type { ToolContext } from '../../src/mcp/types.js';

import { createWorkflow } from '../../src/types/workflow.js';
import { createProjectDirectorySource } from '../../src/types/workflow-source.js';

import { LocalDataDirV2 } from '../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../src/v2/infra/local/fs/index.js';
import { NodeSha256V2 } from '../../src/v2/infra/local/sha256/index.js';
import { LocalSessionEventLogStoreV2 } from '../../src/v2/infra/local/session-store/index.js';
import { LocalSessionLockV2 } from '../../src/v2/infra/local/session-lock/index.js';
import { NodeCryptoV2 } from '../../src/v2/infra/local/crypto/index.js';
import { LocalSnapshotStoreV2 } from '../../src/v2/infra/local/snapshot-store/index.js';
import { LocalPinnedWorkflowStoreV2 } from '../../src/v2/infra/local/pinned-workflow-store/index.js';
import { ExecutionSessionGateV2 } from '../../src/v2/usecases/execution-session-gate.js';

import { parseTokenV1Binary, verifyTokenSignatureV1Binary, unsafeTokenCodecPorts } from '../../src/v2/durable-core/tokens/index.js';
import { NodeHmacSha256V2 } from '../../src/v2/infra/local/hmac-sha256/index.js';
import { NodeBase64UrlV2 } from '../../src/v2/infra/local/base64url/index.js';
import { LocalKeyringV2 } from '../../src/v2/infra/local/keyring/index.js';
import { NodeRandomEntropyV2 } from '../../src/v2/infra/local/random-entropy/index.js';
import { NodeTimeClockV2 } from '../../src/v2/infra/local/time-clock/index.js';
import { IdFactoryV2 } from '../../src/v2/infra/local/id-factory/index.js';
import { Bech32mAdapterV2 } from '../../src/v2/infra/local/bech32m/index.js';
import { Base32AdapterV2 } from '../../src/v2/infra/local/base32/index.js';

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-start-'));
}

async function mkCtxWithWorkflow(workflowId: string): Promise<ToolContext> {
  const wf = createWorkflow(
    {
      id: workflowId,
      name: 'Test Workflow',
      description: 'Test',
      version: '0.1.0',
      steps: [{ id: 'triage', title: 'Triage', prompt: 'Do triage' }],
    } as any,
    createProjectDirectorySource('/tmp/project')
  );

  // Create v2 dependencies using same pattern as production
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
      tokenCodecPorts
    },
  };
}

describe('v2 start_workflow (Slice 3.5)', () => {
  it('returns VALIDATION_ERROR with actionable details for oversized context', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {
      const workflowId = 'test-workflow';
      const ctx = await mkCtxWithWorkflow(workflowId);

      const big = 'a'.repeat(262_200);
      const res = await handleV2StartWorkflow({ workflowId, context: { big } } as any, ctx);
      expect(res.type).toBe('error');
      if (res.type !== 'error') return;

      expect(res.code).toBe('VALIDATION_ERROR');
      expect(res.message).toContain('context is too large');
      expect(res.message).toContain('JCS');
      expect(res.retry).toEqual({ kind: 'not_retryable' });

      const details = res.details as any;
      expect(details.suggestion).toBeTruthy();
      expect(details.details.kind).toBe('context_budget_exceeded');
      expect(details.details.tool).toBe('start_workflow');
      expect(details.details.maxBytes).toBe(262144);
      expect(details.details.measuredBytes).toBeGreaterThan(262144);
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });

  it('returns VALIDATION_ERROR for non-finite numbers in context (agent-actionable)', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {
      const workflowId = 'test-workflow';
      const ctx = await mkCtxWithWorkflow(workflowId);

      const res = await handleV2StartWorkflow({ workflowId, context: { bad: Infinity } } as any, ctx);
      expect(res.type).toBe('error');
      if (res.type !== 'error') return;

      expect(res.code).toBe('VALIDATION_ERROR');
      expect(res.retry).toEqual({ kind: 'not_retryable' });

      const details = res.details as any;
      expect(details.suggestion).toBeTruthy();
      expect(details.details.kind).toBe('context_non_finite_number');
      expect(details.details.tool).toBe('start_workflow');
      expect(details.details.path).toBe('$.bad');
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });

  it('returns VALIDATION_ERROR for oversized context on continue_workflow (rehydrate-only path)', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {
      const workflowId = 'test-workflow';
      const ctx = await mkCtxWithWorkflow(workflowId);

      const start = await handleV2StartWorkflow({ workflowId } as any, ctx);
      expect(start.type).toBe('success');
      if (start.type !== 'success') return;

      const big = 'a'.repeat(262_200);
      const res = await handleV2ContinueWorkflow({ stateToken: start.data.stateToken, context: { big } } as any, ctx);
      expect(res.type).toBe('error');
      if (res.type !== 'error') return;

      expect(res.code).toBe('VALIDATION_ERROR');
      expect(res.retry).toEqual({ kind: 'not_retryable' });
      
      const details = res.details as any;
      expect(details.suggestion).toBeTruthy();
      expect(details.details.kind).toBe('context_budget_exceeded');
      expect(details.details.tool).toBe('continue_workflow');
      expect(details.details.measuredBytes).toBeGreaterThan(262144);
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });

  it('creates durable session/run/root node and returns signed tokens + first pending step', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {
      const workflowId = 'test-workflow';
      const ctx = await mkCtxWithWorkflow(workflowId);

      const res = await handleV2StartWorkflow({ workflowId } as any, ctx);
      expect(res.type).toBe('success');
      if (res.type === 'error') {
        console.error('ERROR:', res.code, res.message);
        throw new Error(`Handler returned error: ${res.code} - ${res.message}`);
      }
      if (res.type !== 'success') return;

      expect(typeof res.data.stateToken).toBe('string');
      expect(typeof res.data.ackToken).toBe('string');
      expect(res.data.isComplete).toBe(false);
      expect(res.data.pending?.stepId).toBe('triage');

      // Verify signatures using the same keyring in the temp data dir.
      const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
      const fsPort = new NodeFileSystemV2();
      const hmac = new NodeHmacSha256V2();
      const localBase64url = new NodeBase64UrlV2();
      const base32 = new Base32AdapterV2();
      const bech32m = new Bech32mAdapterV2();
      const keyring = await new LocalKeyringV2(dataDir, fsPort, localBase64url, new NodeRandomEntropyV2()).loadOrCreate().match(
        (v) => v,
        (e) => {
          throw new Error(`unexpected keyring error: ${e.code}`);
        }
      );

      const parsedState = parseTokenV1Binary(res.data.stateToken, { bech32m, base32 })._unsafeUnwrap();
      const parsedAck = parseTokenV1Binary(res.data.ackToken, { bech32m, base32 })._unsafeUnwrap();

      const verifyPorts = { keyring, hmac, base64url: localBase64url };
      expect(verifyTokenSignatureV1Binary(parsedState, verifyPorts).isOk()).toBe(true);
      expect(verifyTokenSignatureV1Binary(parsedAck, verifyPorts).isOk()).toBe(true);

      // Durable truth exists and is loadable via the session store.
      const sha256 = new NodeSha256V2();
      const store = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha256);
      const truth = await store.load(parsedState.payload.sessionId).match(
        (v) => v,
        (e) => {
          throw new Error(`unexpected load error: ${e.code}`);
        }
      );

      const runStarted = truth.events.find((e) => e.kind === 'run_started');
      expect(runStarted).toBeTruthy();

      const nodeCreated = truth.events.find((e) => e.kind === 'node_created');
      expect(nodeCreated).toBeTruthy();
      if (!nodeCreated || nodeCreated.kind !== 'node_created') return;

      // Snapshot referenced by node_created is present in CAS.
      const crypto = new NodeCryptoV2();
      const snapshotStore = new LocalSnapshotStoreV2(dataDir, fsPort, crypto);
      const snap = await snapshotStore.getExecutionSnapshotV1((nodeCreated as any).data.snapshotRef).match(
        (v) => v,
        (e) => {
          throw new Error(`unexpected snapshot get error: ${e.code}`);
        }
      );
      expect(snap).not.toBeNull();
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });
});
