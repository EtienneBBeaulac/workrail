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

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-fork-'));
}

function mkCtxWithWorkflow(workflowId: string): ToolContext {
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

describe('v2 fork detection (Phase 5)', () => {
  it('detects non-tip advance and creates a fork with cause.kind=non_tip_advance', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {
      const workflowId = 'fork-test';
      const ctx = mkCtxWithWorkflow(workflowId);

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
      const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
      const fsPort = new NodeFileSystemV2();
      const sha256 = new NodeSha256V2();
      const store = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha256);

      const sessionId = start.data.stateToken.includes('sessionId') ? 'sess_' : '';  // Extract from token parsing
      const sessionStore = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha256);
      
      // Get sessionId by parsing the stateToken.
      const { parseTokenV1 } = await import('../../src/v2/durable-core/tokens/index.js');
      const parsed = parseTokenV1(start.data.stateToken)._unsafeUnwrap();
      const sid = parsed.payload.sessionId;

      const truth = await sessionStore.load(sid).match(
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
