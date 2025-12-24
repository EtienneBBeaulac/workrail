import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { handleV2StartWorkflow } from '../../src/mcp/handlers/v2-execution.js';
import type { ToolContext } from '../../src/mcp/types.js';

import { createWorkflow } from '../../src/types/workflow.js';
import { createProjectDirectorySource } from '../../src/types/workflow-source.js';

import { LocalDataDirV2 } from '../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../src/v2/infra/local/fs/index.js';
import { NodeSha256V2 } from '../../src/v2/infra/local/sha256/index.js';
import { LocalSessionEventLogStoreV2 } from '../../src/v2/infra/local/session-store/index.js';
import { NodeCryptoV2 } from '../../src/v2/infra/local/crypto/index.js';
import { LocalSnapshotStoreV2 } from '../../src/v2/infra/local/snapshot-store/index.js';

import { parseTokenV1, verifyTokenSignatureV1 } from '../../src/v2/durable-core/tokens/index.js';
import { NodeHmacSha256V2 } from '../../src/v2/infra/local/hmac-sha256/index.js';
import { LocalKeyringV2 } from '../../src/v2/infra/local/keyring/index.js';

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-start-'));
}

function mkCtxWithWorkflow(workflowId: string): ToolContext {
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
  };
}

describe('v2 start_workflow (Slice 3.5)', () => {
  it('creates durable session/run/root node and returns signed tokens + first pending step', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {
      const workflowId = 'test-workflow';
      const ctx = mkCtxWithWorkflow(workflowId);

      const res = await handleV2StartWorkflow({ workflowId } as any, ctx);
      expect(res.type).toBe('success');
      if (res.type !== 'success') return;

      expect(typeof res.data.stateToken).toBe('string');
      expect(typeof res.data.ackToken).toBe('string');
      expect(typeof res.data.checkpointToken).toBe('string');
      expect(res.data.isComplete).toBe(false);
      expect(res.data.pending?.stepId).toBe('triage');

      const parsedState = parseTokenV1(res.data.stateToken)._unsafeUnwrap();
      const parsedAck = parseTokenV1(res.data.ackToken)._unsafeUnwrap();
      const parsedCheckpoint = parseTokenV1(res.data.checkpointToken)._unsafeUnwrap();

      // Verify signatures using the same keyring in the temp data dir.
      const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
      const fsPort = new NodeFileSystemV2();
      const hmac = new NodeHmacSha256V2();
      const keyring = await new LocalKeyringV2(dataDir, fsPort).loadOrCreate().match(
        (v) => v,
        (e) => {
          throw new Error(`unexpected keyring error: ${e.code}`);
        }
      );
      expect(verifyTokenSignatureV1(parsedState, keyring, hmac).isOk()).toBe(true);
      expect(verifyTokenSignatureV1(parsedAck, keyring, hmac).isOk()).toBe(true);
      expect(verifyTokenSignatureV1(parsedCheckpoint, keyring, hmac).isOk()).toBe(true);

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
