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
import { NodeCryptoV2 } from '../../src/v2/infra/local/crypto/index.js';
import { NodeHmacSha256V2 } from '../../src/v2/infra/local/hmac-sha256/index.js';
import { LocalSessionLockV2 } from '../../src/v2/infra/local/session-lock/index.js';
import { LocalSnapshotStoreV2 } from '../../src/v2/infra/local/snapshot-store/index.js';
import { LocalPinnedWorkflowStoreV2 } from '../../src/v2/infra/local/pinned-workflow-store/index.js';
import { ExecutionSessionGateV2 } from '../../src/v2/usecases/execution-session-gate.js';
import { LocalKeyringV2 } from '../../src/v2/infra/local/keyring/index.js';

import { parseTokenV1 } from '../../src/v2/durable-core/tokens/index.js';

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-output-replay-'));
}

async function mkV2Deps() {
  const dataDir = new LocalDataDirV2(process.env);
  const fsPort = new NodeFileSystemV2();
  const sha256 = new NodeSha256V2();
  const crypto = new NodeCryptoV2();
  const hmac = new NodeHmacSha256V2();
  const sessionStore = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha256);
  const lockPort = new LocalSessionLockV2(dataDir, fsPort);
  const gate = new ExecutionSessionGateV2(lockPort, sessionStore);
  const snapshotStore = new LocalSnapshotStoreV2(dataDir, fsPort, crypto);
  const pinnedStore = new LocalPinnedWorkflowStoreV2(dataDir);
  const keyringPort = new LocalKeyringV2(dataDir, fsPort);
  const keyring = await keyringPort.loadOrCreate().match(v => v, e => { throw new Error(`keyring: ${e.code}`); });

  return { gate, sessionStore, snapshotStore, pinnedStore, keyring, crypto, hmac };
}

async function mkCtxWithWorkflow(workflowId: string): Promise<ToolContext> {
  const wf = createWorkflow(
    {
      id: workflowId,
      name: 'Output Replay Test',
      description: 'Test',
      version: '1.0.0',
      steps: [{ id: 'triage', title: 'Triage', prompt: 'Do triage' }],
    } as any,
    createProjectDirectorySource('/tmp/project')
  );

  const v2 = await mkV2Deps();

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
    v2,
  };
}

describe('v2 output replay idempotency', () => {
  it('replaying ack with output.notesMarkdown creates only one node_output_appended event', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {
      const workflowId = 'output-test';
      const ctx = await mkCtxWithWorkflow(workflowId);

      const start = await handleV2StartWorkflow({ workflowId } as any, ctx);
      expect(start.type).toBe('success');
      if (start.type !== 'success') return;

      const output = { notesMarkdown: 'Completed triage. Next: investigation.' };

      // First ack with output
      const ack1 = await handleV2ContinueWorkflow(
        { stateToken: start.data.stateToken, ackToken: start.data.ackToken, output } as any,
        ctx
      );
      expect(ack1.type).toBe('success');
      if (ack1.type !== 'success') return;

      // Replay same ack with same output
      const ack2 = await handleV2ContinueWorkflow(
        { stateToken: start.data.stateToken, ackToken: start.data.ackToken, output } as any,
        ctx
      );
      expect(ack2).toEqual(ack1); // Idempotent response

      // Load truth and verify exactly ONE node_output_appended event
      const parsed = parseTokenV1(start.data.stateToken)._unsafeUnwrap();
      const sessionId = parsed.payload.sessionId;

      const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
      const fsPort = new NodeFileSystemV2();
      const sha256 = new NodeSha256V2();
      const store = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha256);

      const truth = await store.load(sessionId).match(
        (v) => v,
        (e) => {
          throw new Error(`unexpected load error: ${e.code}`);
        }
      );

      const outputEvents = truth.events.filter((e) => e.kind === 'node_output_appended');
      expect(outputEvents.length).toBe(1);
      expect((outputEvents[0] as any).data.payload.notesMarkdown).toBe('Completed triage. Next: investigation.');
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });
});
