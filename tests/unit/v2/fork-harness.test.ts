import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { handleV2StartWorkflow, handleV2ContinueWorkflow } from '../../../src/mcp/handlers/v2-execution.js';
import type { ToolContext } from '../../../src/mcp/types.js';
import { setupIntegrationTest, teardownIntegrationTest, resolveService } from '../../di/integration-container.js';
import { DI } from '../../../src/di/tokens.js';
import { InMemoryWorkflowStorage } from '../../../src/infrastructure/storage/in-memory-storage.js';

import { LocalDataDirV2 } from '../../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../../src/v2/infra/local/fs/index.js';
import { NodeSha256V2 } from '../../../src/v2/infra/local/sha256/index.js';
import { NodeCryptoV2 } from '../../../src/v2/infra/local/crypto/index.js';
import { NodeHmacSha256V2 } from '../../../src/v2/infra/local/hmac-sha256/index.js';
import { NodeBase64UrlV2 } from '../../../src/v2/infra/local/base64url/index.js';
import { LocalSessionEventLogStoreV2 } from '../../../src/v2/infra/local/session-store/index.js';
import { LocalSessionLockV2 } from '../../../src/v2/infra/local/session-lock/index.js';
import { ExecutionSessionGateV2 } from '../../../src/v2/usecases/execution-session-gate.js';
import { LocalSnapshotStoreV2 } from '../../../src/v2/infra/local/snapshot-store/index.js';
import { LocalPinnedWorkflowStoreV2 } from '../../../src/v2/infra/local/pinned-workflow-store/index.js';
import { LocalKeyringV2 } from '../../../src/v2/infra/local/keyring/index.js';
import { NodeRandomEntropyV2 } from '../../../src/v2/infra/local/random-entropy/index.js';
import { NodeTimeClockV2 } from '../../../src/v2/infra/local/time-clock/index.js';

import { projectRunDagV2 } from '../../../src/v2/projections/run-dag.js';
import { asSessionId } from '../../../src/v2/durable-core/ids/index.js';
import type { DomainEventV1 } from '../../../src/v2/durable-core/schemas/session/index.js';

/**
 * Fork harness: verify N attemptIds from same node create N distinct branches.
 * 
 * Lock: docs/design/v2-core-design-locks.md Section 16.5 Sub-phase E
 * > Fork harness: N different attemptIds from same node create N distinct branches
 * 
 * Purpose:
 * - Verify branching works correctly under rewinds
 * - Ensure attemptId isolation
 * - Validate fork detection (intentional_fork vs non_tip_advance)
 * - Stress test with multiple forks from same node
 */

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-fork-'));
}

async function createV2Context(): Promise<ToolContext> {
  const workflowService = resolveService<any>(DI.Services.Workflow);
  const featureFlags = resolveService<any>(DI.Infra.FeatureFlags);

  const dataDir = new LocalDataDirV2(process.env);
  const fsPort = new NodeFileSystemV2();
  const sha256 = new NodeSha256V2();
  const crypto = new NodeCryptoV2();
  const hmac = new NodeHmacSha256V2();
  const base64url = new NodeBase64UrlV2();
  const sessionStore = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha256);
  const clock = new NodeTimeClockV2();
  const lockPort = new LocalSessionLockV2(dataDir, fsPort, clock);
  const gate = new ExecutionSessionGateV2(lockPort, sessionStore);
  const snapshotStore = new LocalSnapshotStoreV2(dataDir, fsPort, crypto);
  const pinnedStore = new LocalPinnedWorkflowStoreV2(dataDir, fsPort);
  const entropy = new NodeRandomEntropyV2();
  const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);
  const keyring = await keyringPort.loadOrCreate().match(
    v => v,
    e => { throw new Error(`keyring: ${e.code}`); }
  );

  return {
    workflowService,
    featureFlags,
    sessionManager: null,
    httpServer: null,
    v2: { gate, sessionStore, snapshotStore, pinnedStore, keyring, crypto, hmac, base64url },
  };
}

function extractSessionIdFromToken(stateToken: string): string {
  const parts = stateToken.split('.');
  if (parts.length < 3) throw new Error('Invalid token format');
  
  const payloadB64 = parts[2]!;
  const payloadJson = Buffer.from(payloadB64, 'base64url').toString('utf-8');
  const payload = JSON.parse(payloadJson);
  
  return payload.sessionId;
}

describe('v2 fork harness (branching stress test)', () => {
  let root: string;
  let prevDataDir: string | undefined;

  beforeEach(async () => {
    root = await mkTempDataDir();
    prevDataDir = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;

    await setupIntegrationTest({
      storage: new InMemoryWorkflowStorage([
        {
          id: 'fork-test',
          name: 'Fork Test',
          description: 'Multi-step workflow for fork testing',
          version: '1.0.0',
          steps: [
            { id: 'step1', title: 'Step 1', prompt: 'Do step 1' },
            { id: 'step2', title: 'Step 2', prompt: 'Do step 2' },
            { id: 'step3', title: 'Step 3', prompt: 'Do step 3' },
          ],
        } as any,
      ]),
      disableSessionTools: true,
    });
  });

  afterEach(async () => {
    teardownIntegrationTest();
    process.env.WORKRAIL_DATA_DIR = prevDataDir;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates N distinct branches from same node with different attemptIds', async () => {
    const ctx = await createV2Context();

    const start = await handleV2StartWorkflow({ workflowId: 'fork-test' } as any, ctx);
    expect(start.type).toBe('success');
    if (start.type !== 'success') return;

    const nodeA_stateToken = start.data.stateToken;
    const nodeA_ackToken_1 = start.data.ackToken;

    const ack1 = await handleV2ContinueWorkflow({
      stateToken: nodeA_stateToken,
      ackToken: nodeA_ackToken_1,
      output: { notesMarkdown: 'Branch 1' },
    } as any, ctx);
    expect(ack1.type).toBe('success');
    if (ack1.type !== 'success') return;
    expect(ack1.data.kind).toBe('ok');
    expect(ack1.data.pending?.stepId).toBe('step2');

    const rehydrate2 = await handleV2ContinueWorkflow({
      stateToken: nodeA_stateToken,
    } as any, ctx);
    expect(rehydrate2.type).toBe('success');
    if (rehydrate2.type !== 'success') return;
    const nodeA_ackToken_2 = rehydrate2.data.ackToken;

    const ack2 = await handleV2ContinueWorkflow({
      stateToken: nodeA_stateToken,
      ackToken: nodeA_ackToken_2,
      output: { notesMarkdown: 'Branch 2' },
    } as any, ctx);
    expect(ack2.type).toBe('success');
    if (ack2.type !== 'success') return;
    expect(ack2.data.kind).toBe('ok');

    const rehydrate3 = await handleV2ContinueWorkflow({
      stateToken: nodeA_stateToken,
    } as any, ctx);
    expect(rehydrate3.type).toBe('success');
    if (rehydrate3.type !== 'success') return;
    const nodeA_ackToken_3 = rehydrate3.data.ackToken;

    const ack3 = await handleV2ContinueWorkflow({
      stateToken: nodeA_stateToken,
      ackToken: nodeA_ackToken_3,
      output: { notesMarkdown: 'Branch 3' },
    } as any, ctx);
    expect(ack3.type).toBe('success');
    if (ack3.type !== 'success') return;

    const sessionId = asSessionId(extractSessionIdFromToken(nodeA_stateToken));
    const truthRes = await ctx.v2!.sessionStore.load(sessionId);
    expect(truthRes.isOk()).toBe(true);
    const truth = truthRes._unsafeUnwrap();

    const dagRes = projectRunDagV2(truth.events);
    expect(dagRes.isOk()).toBe(true);
    const dag = dagRes._unsafeUnwrap();

    const runs = Object.values(dag.runsById);
    expect(runs.length).toBe(1);
    const run = runs[0]!;

    const nodeA = Object.values(run.nodesById).find(n => n.parentNodeId === null);
    expect(nodeA).toBeDefined();

    const childrenOfA = run.edges.filter(e => e.fromNodeId === nodeA!.nodeId);
    expect(childrenOfA.length).toBe(3);

    const childNodeIds = new Set(childrenOfA.map(e => e.toNodeId));
    expect(childNodeIds.size).toBe(3);

    for (const nodeId of childNodeIds) {
      expect(run.nodesById[nodeId]).toBeDefined();
    }

    const causes = childrenOfA.map(e => e.cause.kind).sort();
    expect(causes).toContain('intentional_fork');
    expect(causes).toContain('non_tip_advance');
    expect(causes.filter(c => c === 'non_tip_advance').length).toBe(2);

    const eventIds = new Set(childrenOfA.map(e => e.cause.eventId));
    expect(eventIds.size).toBe(3);

    expect(run.tipNodeIds.length).toBe(3);
  });

  it('stress test: 10 forks from same node', async () => {
    const ctx = await createV2Context();

    const start = await handleV2StartWorkflow({ workflowId: 'fork-test' } as any, ctx);
    expect(start.type).toBe('success');
    if (start.type !== 'success') return;

    const nodeA_stateToken = start.data.stateToken;

    for (let i = 0; i < 10; i++) {
      const rehydrate = await handleV2ContinueWorkflow({
        stateToken: nodeA_stateToken,
      } as any, ctx);
      expect(rehydrate.type).toBe('success');
      if (rehydrate.type !== 'success') return;

      const ack = await handleV2ContinueWorkflow({
        stateToken: nodeA_stateToken,
        ackToken: rehydrate.data.ackToken,
        output: { notesMarkdown: `Branch ${i + 1}` },
      } as any, ctx);
      expect(ack.type).toBe('success');
      if (ack.type !== 'success') return;
    }

    const sessionId = asSessionId(extractSessionIdFromToken(nodeA_stateToken));
    const truthRes = await ctx.v2!.sessionStore.load(sessionId);
    expect(truthRes.isOk()).toBe(true);

    const dagRes = projectRunDagV2(truthRes._unsafeUnwrap().events);
    expect(dagRes.isOk()).toBe(true);

    const run = Object.values(dagRes._unsafeUnwrap().runsById)[0]!;
    const nodeA = Object.values(run.nodesById).find(n => n.parentNodeId === null)!;

    const childrenOfA = run.edges.filter(e => e.fromNodeId === nodeA.nodeId);
    expect(childrenOfA.length).toBe(10);

    const eventIds = new Set(childrenOfA.map(e => e.cause.eventId));
    expect(eventIds.size).toBe(10);

    expect(run.tipNodeIds.length).toBe(10);
  });

  it('fork detection: first child is intentional_fork, later are non_tip_advance', async () => {
    const ctx = await createV2Context();

    const start = await handleV2StartWorkflow({ workflowId: 'fork-test' } as any, ctx);
    expect(start.type).toBe('success');
    if (start.type !== 'success') return;

    const ack1 = await handleV2ContinueWorkflow({
      stateToken: start.data.stateToken,
      ackToken: start.data.ackToken,
    } as any, ctx);
    expect(ack1.type).toBe('success');

    const rehydrate = await handleV2ContinueWorkflow({
      stateToken: start.data.stateToken,
    } as any, ctx);
    expect(rehydrate.type).toBe('success');
    if (rehydrate.type !== 'success') return;

    const ack2 = await handleV2ContinueWorkflow({
      stateToken: start.data.stateToken,
      ackToken: rehydrate.data.ackToken,
    } as any, ctx);
    expect(ack2.type).toBe('success');

    const sessionId = asSessionId(extractSessionIdFromToken(start.data.stateToken));
    const truthRes = await ctx.v2!.sessionStore.load(sessionId);
    const events = truthRes._unsafeUnwrap().events;

    const edgeEvents = events.filter(
      (e): e is Extract<DomainEventV1, { kind: 'edge_created' }> => e.kind === 'edge_created'
    );

    expect(edgeEvents.length).toBe(2);
    
    edgeEvents.sort((a, b) => a.eventIndex - b.eventIndex);
    
    expect(edgeEvents[0]!.data.cause.kind).toBe('intentional_fork');
    expect(edgeEvents[1]!.data.cause.kind).toBe('non_tip_advance');
  });

  it('forks are isolated: 2 branches from same parent have different child nodes', async () => {
    const ctx = await createV2Context();

    const start = await handleV2StartWorkflow({ workflowId: 'fork-test' } as any, ctx);
    expect(start.type).toBe('success');
    if (start.type !== 'success') return;

    const nodeA_state = start.data.stateToken;

    const ack1 = await handleV2ContinueWorkflow({
      stateToken: nodeA_state,
      ackToken: start.data.ackToken,
      output: { notesMarkdown: 'BRANCH_1_OUTPUT' },
    } as any, ctx);
    expect(ack1.type).toBe('success');
    if (ack1.type !== 'success') return;

    const rehydrate = await handleV2ContinueWorkflow({ stateToken: nodeA_state } as any, ctx);
    expect(rehydrate.type).toBe('success');
    if (rehydrate.type !== 'success') return;

    const ack2 = await handleV2ContinueWorkflow({
      stateToken: nodeA_state,
      ackToken: rehydrate.data.ackToken,
      output: { notesMarkdown: 'BRANCH_2_OUTPUT' },
    } as any, ctx);
    expect(ack2.type).toBe('success');
    if (ack2.type !== 'success') return;

    const sessionId = asSessionId(extractSessionIdFromToken(nodeA_state));
    const truthRes = await ctx.v2!.sessionStore.load(sessionId);
    const events = truthRes._unsafeUnwrap().events;

    const dagRes = projectRunDagV2(events);
    expect(dagRes.isOk()).toBe(true);
    
    const run = Object.values(dagRes._unsafeUnwrap().runsById)[0]!;
    
    const rootNode = Object.values(run.nodesById).find(n => n.parentNodeId === null)!;
    const children = run.edges.filter(e => e.fromNodeId === rootNode.nodeId);
    
    expect(children.length).toBe(2);
    expect(run.tipNodeIds.length).toBe(2);
    
    const child1Id = children[0]!.toNodeId;
    const child2Id = children[1]!.toNodeId;
    expect(child1Id).not.toBe(child2Id);
  });

  it('ackToken replay: same ackToken twice is idempotent (same branch)', async () => {
    const ctx = await createV2Context();

    const start = await handleV2StartWorkflow({ workflowId: 'fork-test' } as any, ctx);
    expect(start.type).toBe('success');
    if (start.type !== 'success') return;

    const ack1 = await handleV2ContinueWorkflow({
      stateToken: start.data.stateToken,
      ackToken: start.data.ackToken,
      output: { notesMarkdown: 'First ack' },
    } as any, ctx);
    expect(ack1.type).toBe('success');

    const ack2 = await handleV2ContinueWorkflow({
      stateToken: start.data.stateToken,
      ackToken: start.data.ackToken,
      output: { notesMarkdown: 'Replay ack (should be ignored)' },
    } as any, ctx);
    expect(ack2.type).toBe('success');

    expect(ack2.data).toEqual(ack1.data);

    const sessionId = asSessionId(extractSessionIdFromToken(start.data.stateToken));
    const truthRes = await ctx.v2!.sessionStore.load(sessionId);
    const dagRes = projectRunDagV2(truthRes._unsafeUnwrap().events);
    
    const run = Object.values(dagRes._unsafeUnwrap().runsById)[0]!;
    const rootNode = Object.values(run.nodesById).find(n => n.parentNodeId === null)!;
    const children = run.edges.filter(e => e.fromNodeId === rootNode.nodeId);
    
    expect(children.length).toBe(1);
  });
});
