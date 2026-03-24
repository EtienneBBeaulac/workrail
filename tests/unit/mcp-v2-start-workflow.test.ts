import { createTestValidationPipelineDeps } from '../helpers/v2-test-helpers.js';
import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { handleV2ContinueWorkflow, handleV2StartWorkflow } from '../../src/mcp/handlers/v2-execution.js';
import type { ToolContext } from '../../src/mcp/types.js';
import { unwrapResponse } from '../helpers/unwrap-response.js';
import { EnvironmentFeatureFlagProvider } from '../../src/config/feature-flags.js';

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

import { unsafeTokenCodecPorts } from '../../src/v2/durable-core/tokens/index.js';
import { parseShortTokenNative } from '../../src/v2/durable-core/tokens/short-token.js';
import { InMemoryTokenAliasStoreV2 } from '../../src/v2/infra/in-memory/token-alias-store/index.js';
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

async function mkCtxWithWorkflow(workflowId: string): Promise<{ ctx: ToolContext; aliasStore: InMemoryTokenAliasStoreV2 }> {
  const wf = createWorkflow(
    {
      id: workflowId,
      name: 'Test Workflow',
      description: 'Test',
      version: '0.1.0',
      steps: [{ id: 'triage', title: 'Triage', prompt: 'Do triage' }],
    } as any,
    createProjectDirectorySource(path.join(os.tmpdir(), 'workrail-project'))
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

  const tokenAliasStore = new InMemoryTokenAliasStoreV2();

  const ctx: ToolContext = {
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
      entropy,
      idFactory,
      tokenCodecPorts,
      tokenAliasStore,
      validationPipelineDeps: createTestValidationPipelineDeps(),
    },
  };

  return { ctx, aliasStore: tokenAliasStore };
}

async function mkRequestCtx(): Promise<ToolContext> {
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
      getWorkflowById: async () => null,
      getNextStep: async () => {
        throw new Error('not used');
      },
      validateStepOutput: async () => ({ valid: true, issues: [], suggestions: [] }),
    } as any,
    featureFlags: EnvironmentFeatureFlagProvider.withEnv({}),
    sessionManager: null,
    httpServer: null,
    v2: {
      gate,
      sessionStore,
      snapshotStore,
      pinnedStore,
      sha256,
      crypto,
      entropy,
      idFactory,
      tokenCodecPorts,
      tokenAliasStore: new InMemoryTokenAliasStoreV2(),
      validationPipelineDeps: createTestValidationPipelineDeps(),
    },
  };
}

/**
 * Create a context whose getWorkflowById returns a workflow with
 * both prompt AND promptBlocks on a step (invalid XOR).
 */
async function mkCtxWithInvalidWorkflow(workflowId: string): Promise<ToolContext> {
  const wf = createWorkflow(
    {
      id: workflowId,
      name: 'Invalid Workflow',
      description: 'Test',
      version: '0.1.0',
      steps: [{ id: 'bad-step', title: 'Bad', prompt: 'Raw.', promptBlocks: { goal: 'Also blocks.' } }],
    } as any,
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
      getNextStep: async () => { throw new Error('not used'); },
      validateStepOutput: async () => ({ valid: true, issues: [], suggestions: [] }),
    } as any,
    featureFlags: null as any,
    sessionManager: null,
    httpServer: null,
    v2: { gate, sessionStore, snapshotStore, pinnedStore, sha256, crypto, entropy, idFactory, tokenCodecPorts, tokenAliasStore: new InMemoryTokenAliasStoreV2(), validationPipelineDeps: createTestValidationPipelineDeps() },
  };
}

describe('v2 start_workflow (Slice 3.5)', () => {
  it('returns VALIDATION_ERROR for oversized context on continue_workflow (rehydrate-only path)', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {
      const workflowId = 'test-workflow';
      const { ctx } = await mkCtxWithWorkflow(workflowId);

      const start = await handleV2StartWorkflow({ workflowId } as any, ctx);
      expect(start.type).toBe('success');
      if (start.type !== 'success') return;

      const big = 'a'.repeat(262_200);
      const startResponse = unwrapResponse(start.data);
      const res = await handleV2ContinueWorkflow({ continueToken: startResponse.continueToken, intent: 'rehydrate', context: { big } } as any, ctx);
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

  it('start_workflow persists resolved reference state and reuses it on rehydrate', async () => {
    const root = await mkTempDataDir();
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workrail-ref-workspace-'));
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;

    try {
      const workflowsDir = path.join(workspaceDir, 'workflows');
      const docsDir = path.join(workspaceDir, 'docs');
      await fs.mkdir(workflowsDir, { recursive: true });
      await fs.mkdir(docsDir, { recursive: true });
      await fs.writeFile(path.join(docsDir, 'guide.md'), '# Guide\n');

      const workflowId = 'refs-workflow';
      const workflowFile = {
        id: workflowId,
        name: 'Refs Workflow',
        description: 'Workflow used to verify reference resolution end to end.',
        version: '0.1.0',
        references: [
          {
            id: 'guide',
            title: 'Workspace Guide',
            source: 'docs/guide.md',
            purpose: 'Shared project guidance',
            authoritative: true,
          },
        ],
        steps: [
          { id: 'triage', title: 'Triage', prompt: 'Do triage' },
        ],
      };
      await fs.writeFile(
        path.join(workflowsDir, `${workflowId}.json`),
        JSON.stringify(workflowFile, null, 2),
      );

      const ctx = await mkRequestCtx();
      const start = await handleV2StartWorkflow({ workflowId, workspacePath: workspaceDir } as any, ctx);
      expect(start.type).toBe('success');
      if (start.type !== 'success') return;

      const { getV2ExecutionRenderEnvelope } = await import('../../src/mcp/render-envelope.js');
      const startEnvelope = getV2ExecutionRenderEnvelope(start.data);
      expect(startEnvelope).not.toBeNull();
      if (startEnvelope == null) return;

      expect(startEnvelope.contentEnvelope).toBeDefined();
      expect(startEnvelope.contentEnvelope!.references).toHaveLength(1);
      expect(startEnvelope.contentEnvelope!.references[0]).toMatchObject({
        id: 'guide',
        source: 'docs/guide.md',
        resolveFrom: 'workspace',
        status: 'resolved',
        resolvedPath: path.join(workspaceDir, 'docs', 'guide.md'),
      });

      const startResponse = unwrapResponse(start.data);
      const rehydrate = await handleV2ContinueWorkflow({
        continueToken: startResponse.continueToken,
        intent: 'rehydrate',
        workspacePath: workspaceDir,
      } as any, ctx);
      expect(rehydrate.type).toBe('success');
      if (rehydrate.type !== 'success') return;

      const rehydrateEnvelope = getV2ExecutionRenderEnvelope(rehydrate.data);
      expect(rehydrateEnvelope).not.toBeNull();
      if (rehydrateEnvelope == null) return;

      expect(rehydrateEnvelope.contentEnvelope).toBeDefined();
      expect(rehydrateEnvelope.contentEnvelope!.references).toHaveLength(1);
      expect(rehydrateEnvelope.contentEnvelope!.references[0]).toMatchObject({
        id: 'guide',
        source: 'docs/guide.md',
        resolveFrom: 'workspace',
        status: 'resolved',
        resolvedPath: path.join(workspaceDir, 'docs', 'guide.md'),
      });
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('rejects workflow with both prompt and promptBlocks before creating a session', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {
      const workflowId = 'invalid-workflow';
      const ctx = await mkCtxWithInvalidWorkflow(workflowId);

      const res = await handleV2StartWorkflow({ workflowId } as any, ctx);

      // Must fail before session creation — not later at continue_workflow
      expect(res.type).toBe('error');
      if (res.type !== 'error') return;

      expect(res.code).toBe('PRECONDITION_FAILED');
      expect(res.message).toContain('invalid');

      // No session should have been created in the data dir
      const sessionDirs = await import('fs/promises').then(f => f.readdir(path.join(root, 'sessions')).catch(() => []));
      expect(sessionDirs.length).toBe(0);
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
        const { ctx, aliasStore } = await mkCtxWithWorkflow(workflowId);

      const res = await handleV2StartWorkflow({ workflowId } as any, ctx);
      expect(res.type).toBe('success');
      if (res.type === 'error') {
        console.error('ERROR:', res.code, res.message);
        throw new Error(`Handler returned error: ${res.code} - ${res.message}`);
      }
      if (res.type !== 'success') return;

      const response = unwrapResponse(res.data);
      expect(typeof response.continueToken).toBe('string');
      expect(typeof response.continueToken).toBe('string');
      expect(response.isComplete).toBe(false);
      expect(response.pending?.stepId).toBe('triage');

      // Verify v2 short token format.
      const localBase64url = new NodeBase64UrlV2();
      expect(response.continueToken).toMatch(/^ct_[A-Za-z0-9_-]{24}$/);
      expect(response.continueToken).toMatch(/^ct_[A-Za-z0-9_-]{24}$/);

      // Resolve session ID from alias store (registered during mintShortTokenTriple).
      const parsedState = parseShortTokenNative(response.continueToken)!;
      const stateAlias = aliasStore.lookup(parsedState.nonceHex);
      expect(stateAlias).not.toBeNull();
      if (!stateAlias) throw new Error('state alias not found');

      // Durable truth exists and is loadable via the session store.
      const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
      const fsPort = new NodeFileSystemV2();
      const sha256 = new NodeSha256V2();
      const store = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha256);
      const truth = await store.load(stateAlias.sessionId).match(
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
