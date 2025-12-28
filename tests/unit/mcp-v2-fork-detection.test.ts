import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { handleV2StartWorkflow, handleV2ContinueWorkflow } from '../../src/mcp/handlers/v2-execution.js';
import type { ToolContext } from '../../src/mcp/types.js';

import { createWorkflow } from '../../src/types/workflow.js';
import { createProjectDirectorySource } from '../../src/types/workflow-source.js';

import { LocalDataDirV2 } from '../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../src/v2/infra/local/fs/index.js';
import { NodeSha256V2 } from '../../src/v2/infra/local/sha256/index.js';
import { LocalSessionEventLogStoreV2 } from '../../src/v2/infra/local/session-store/index.js';
import { LocalSessionLockV2 } from '../../src/v2/infra/local/session-lock/index.js';
import { LocalSnapshotStoreV2 } from '../../src/v2/infra/local/snapshot-store/index.js';
import { LocalPinnedWorkflowStoreV2 } from '../../src/v2/infra/local/pinned-workflow-store/index.js';
import { ExecutionSessionGateV2 } from '../../src/v2/usecases/execution-session-gate.js';
import { LocalKeyringV2 } from '../../src/v2/infra/local/keyring/index.js';
import { NodeCryptoV2 } from '../../src/v2/infra/local/crypto/index.js';
import { NodeHmacSha256V2 } from '../../src/v2/infra/local/hmac-sha256/index.js';

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-fork-'));
}

async function mkCtxWithWorkflow(workflowId: string, dataDir: string): Promise<ToolContext> {
  const wf = createWorkflow(
    {
      id: workflowId,
      name: 'Fork Test Workflow',
      description: 'Test',
      version: '1.0.0',
      steps: [
        { id: 'step1', title: 'Step 1', prompt: 'Do step 1' },
        { id: 'step2', title: 'Step 2', prompt: 'Do step 2' },
      ],
    } as any,
    createProjectDirectorySource('/tmp/project')
  );

  const dataDirV2 = new LocalDataDirV2({ WORKRAIL_DATA_DIR: dataDir });
  const fsPortV2 = new NodeFileSystemV2();
  const sha256V2 = new NodeSha256V2();
  const cryptoV2 = new NodeCryptoV2();
  const hmacV2 = new NodeHmacSha256V2();
  const sessionStoreV2 = new LocalSessionEventLogStoreV2(dataDirV2, fsPortV2, sha256V2);
  const lockV2 = new LocalSessionLockV2(dataDirV2, fsPortV2);
  const gateV2 = new ExecutionSessionGateV2(lockV2, sessionStoreV2);
  const snapshotStoreV2 = new LocalSnapshotStoreV2(dataDirV2, fsPortV2, cryptoV2);
  const pinnedStoreV2 = new LocalPinnedWorkflowStoreV2(dataDirV2);
  const keyringPortV2 = new LocalKeyringV2(dataDirV2, fsPortV2);
  const keyringV2 = await keyringPortV2.loadOrCreate().match(v => v, e => { throw new Error(`keyring: ${e.code}`); });

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
      gate: gateV2,
      sessionStore: sessionStoreV2,
      snapshotStore: snapshotStoreV2,
      pinnedStore: pinnedStoreV2,
      keyring: keyringV2,
      crypto: cryptoV2,
      hmac: hmacV2,
    },
  };
}

describe('v2 fork detection (Phase 5)', () => {
  it('detects non-tip advance and creates a fork with cause.kind=non_tip_advance', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {
      const workflowId = 'fork-test';
      const ctx = await mkCtxWithWorkflow(workflowId, root);

      // Start workflow and advance once.
      const start = await handleV2StartWorkflow({ workflowId } as any, ctx);
      expect(start.type).toBe('success');
      if (start.type !== 'success') return;

      const first = await handleV2ContinueWorkflow({ stateToken: start.data.stateToken, ackToken: start.data.ackToken } as any, ctx);
      expect(first.type).toBe('success');
      if (first.type !== 'success') return;
      expect(first.data.kind).toBe('ok');
      expect(first.data.pending?.stepId).toBe('step2');

      // To simulate a rewind/fork, we need to call rehydrate on the ORIGINAL stateToken to get a fresh ackToken.
      // (Reusing the same ackToken would be an idempotent replay, not a fork.)
      const rehydrate = await handleV2ContinueWorkflow({ stateToken: start.data.stateToken } as any, ctx);
      expect(rehydrate.type).toBe('success');
      if (rehydrate.type !== 'success') return;

      // Now advance from the root node again with the NEW ackToken.
      // This should detect that root node already has a child and create a fork.
      const fork = await handleV2ContinueWorkflow({ stateToken: start.data.stateToken, ackToken: rehydrate.data.ackToken } as any, ctx);
      expect(fork.type).toBe('success');
      if (fork.type !== 'success') return;
      expect(fork.data.kind).toBe('ok');

      // Load truth and verify:
      // - 2 node_created events (root + 2 children)
      // - 2 edge_created events
      // - at least one edge has cause.kind=non_tip_advance
      const { parseTokenV1 } = await import('../../src/v2/durable-core/tokens/index.js');
      const parsed = parseTokenV1(start.data.stateToken)._unsafeUnwrap();
      const sid = parsed.payload.sessionId;

      const truth = await ctx.v2!.sessionStore.load(sid).match(
        (v) => v,
        (e) => {
          throw new Error(`unexpected load error: ${e.code}`);
        }
      );

      const nodes = truth.events.filter((e) => e.kind === 'node_created');
      const edges = truth.events.filter((e) => e.kind === 'edge_created');

      // Root node + 2 advanced children (fork).
      expect(nodes.length).toBe(3);
      expect(edges.length).toBe(2);

      const forkEdge = edges.find((e: any) => e.data.cause.kind === 'non_tip_advance');
      expect(forkEdge).toBeTruthy();
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });
});
