/**
 * Checkpoint Handler Integration Tests
 *
 * Exercises the full handleV2CheckpointWorkflow flow:
 *   parse token → load session → write events → mint new token
 *
 * Uses real adapters (local FS) with a temp data dir for isolation.
 * Follows the same pattern as mcp-v2-continue-behavior-lock.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { setupIntegrationTest, teardownIntegrationTest, resolveService } from '../../di/integration-container.js';
import { DI } from '../../../src/di/tokens.js';
import type { ToolContext } from '../../../src/mcp/types.js';

import { handleV2StartWorkflow, handleV2ContinueWorkflow } from '../../../src/mcp/handlers/v2-execution.js';
import { handleV2CheckpointWorkflow } from '../../../src/mcp/handlers/v2-checkpoint.js';
import { InMemoryWorkflowStorage } from '../../../src/infrastructure/storage/in-memory-storage.js';

import { LocalDataDirV2 } from '../../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../../src/v2/infra/local/fs/index.js';
import { NodeSha256V2 } from '../../../src/v2/infra/local/sha256/index.js';
import { LocalSessionEventLogStoreV2 } from '../../../src/v2/infra/local/session-store/index.js';
import { NodeCryptoV2 } from '../../../src/v2/infra/local/crypto/index.js';
import { NodeHmacSha256V2 } from '../../../src/v2/infra/local/hmac-sha256/index.js';
import { NodeBase64UrlV2 } from '../../../src/v2/infra/local/base64url/index.js';
import { LocalSessionLockV2 } from '../../../src/v2/infra/local/session-lock/index.js';
import { LocalSnapshotStoreV2 } from '../../../src/v2/infra/local/snapshot-store/index.js';
import { LocalPinnedWorkflowStoreV2 } from '../../../src/v2/infra/local/pinned-workflow-store/index.js';
import { ExecutionSessionGateV2 } from '../../../src/v2/usecases/execution-session-gate.js';
import { LocalKeyringV2 } from '../../../src/v2/infra/local/keyring/index.js';
import { NodeRandomEntropyV2 } from '../../../src/v2/infra/local/random-entropy/index.js';
import { NodeTimeClockV2 } from '../../../src/v2/infra/local/time-clock/index.js';
import { IdFactoryV2 } from '../../../src/v2/infra/local/id-factory/index.js';
import { Bech32mAdapterV2 } from '../../../src/v2/infra/local/bech32m/index.js';
import { Base32AdapterV2 } from '../../../src/v2/infra/local/base32/index.js';
import { unsafeTokenCodecPorts } from '../../../src/v2/durable-core/tokens/index.js';
import { parseCheckpointTokenOrFail } from '../../../src/mcp/handlers/v2-token-ops.js';
import { asSessionId } from '../../../src/v2/durable-core/ids/index.js';

async function mkV2Deps() {
  const dataDir = new LocalDataDirV2(process.env);
  const fsPort = new NodeFileSystemV2();
  const sha256 = new NodeSha256V2();
  const crypto = new NodeCryptoV2();
  const hmac = new NodeHmacSha256V2();
  const base64url = new NodeBase64UrlV2();
  const entropy = new NodeRandomEntropyV2();
  const idFactory = new IdFactoryV2(entropy);
  const base32 = new Base32AdapterV2();
  const bech32m = new Bech32mAdapterV2();
  const clock = new NodeTimeClockV2();
  const sessionStore = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha256);
  const lockPort = new LocalSessionLockV2(dataDir, fsPort, clock);
  const gate = new ExecutionSessionGateV2(lockPort, sessionStore);
  const snapshotStore = new LocalSnapshotStoreV2(dataDir, fsPort, crypto);
  const pinnedStore = new LocalPinnedWorkflowStoreV2(dataDir, fsPort);
  const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);
  const keyring = await keyringPort.loadOrCreate().match(v => v, e => { throw new Error(`keyring: ${e.code}`); });
  const tokenCodecPorts = unsafeTokenCodecPorts({ keyring, hmac, base64url, base32, bech32m });
  return { gate, sessionStore, snapshotStore, pinnedStore, sha256, crypto, idFactory, tokenCodecPorts };
}

describe('handleV2CheckpointWorkflow (integration)', () => {
  let root: string;
  let prevDataDir: string | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-checkpoint-'));
    prevDataDir = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;

    await setupIntegrationTest({
      storage: new InMemoryWorkflowStorage([
        {
          id: 'checkpoint-test',
          name: 'Checkpoint Test',
          description: 'A 2-step workflow for testing checkpoints',
          version: '1.0.0',
          steps: [
            { id: 'step-1', title: 'Step 1', prompt: 'Do step 1' },
            { id: 'step-2', title: 'Step 2', prompt: 'Do step 2' },
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

  async function buildCtx(): Promise<ToolContext> {
    const workflowService = resolveService<any>(DI.Services.Workflow);
    const featureFlags = resolveService<any>(DI.Infra.FeatureFlags);
    const v2 = await mkV2Deps();
    return { workflowService, featureFlags, sessionManager: null, httpServer: null, v2 };
  }

  /** Start a workflow, assert success, return data */
  async function startWorkflow(ctx: ToolContext) {
    const result = await handleV2StartWorkflow({ workflowId: 'checkpoint-test' } as any, ctx);
    expect(result.type).toBe('success');
    if (result.type !== 'success') throw new Error('start_workflow failed');
    return result.data;
  }

  it('creates a checkpoint successfully from a valid checkpointToken', async () => {
    const ctx = await buildCtx();
    const start = await startWorkflow(ctx);
    expect(start.checkpointToken).toBeDefined();

    const result = await handleV2CheckpointWorkflow(
      { checkpointToken: start.checkpointToken },
      ctx,
    );

    if (result.type === 'error') {
      console.error('Checkpoint error:', JSON.stringify(result, null, 2));
    }
    expect(result.type).toBe('success');
    if (result.type !== 'success') return;
    expect(result.data.checkpointNodeId).toBeDefined();
    expect(result.data.checkpointNodeId).not.toBe('unknown');
    expect(result.data.stateToken).toMatch(/^st1/);
  });

  it('is idempotent — same checkpointToken returns same checkpointNodeId', async () => {
    const ctx = await buildCtx();
    const start = await startWorkflow(ctx);

    const r1 = await handleV2CheckpointWorkflow({ checkpointToken: start.checkpointToken }, ctx);
    const r2 = await handleV2CheckpointWorkflow({ checkpointToken: start.checkpointToken }, ctx);

    expect(r1.type).toBe('success');
    expect(r2.type).toBe('success');
    if (r1.type !== 'success' || r2.type !== 'success') return;

    expect(r2.data.checkpointNodeId).toBe(r1.data.checkpointNodeId);
    expect(r2.data.stateToken).toMatch(/^st1/);
  });

  it('agent can continue_workflow after checkpoint with the returned stateToken', async () => {
    const ctx = await buildCtx();
    const start = await startWorkflow(ctx);

    const cp = await handleV2CheckpointWorkflow({ checkpointToken: start.checkpointToken }, ctx);
    expect(cp.type).toBe('success');
    if (cp.type !== 'success') return;

    // Resume from checkpoint — rehydrate to same pending step
    const resume = await handleV2ContinueWorkflow({ stateToken: cp.data.stateToken, intent: 'rehydrate' } as any, ctx);
    if (resume.type === 'error') console.error('Continue after checkpoint error:', JSON.stringify(resume));
    expect(resume.type).toBe('success');
    if (resume.type !== 'success') return;
    expect(resume.data.pending).toBeDefined();
  });

  it('rejects an invalid token string', async () => {
    const ctx = await buildCtx();
    const result = await handleV2CheckpointWorkflow({ checkpointToken: 'garbage_token' }, ctx);
    expect(result.type).toBe('error');
  });

  it('rejects a state token passed as checkpointToken', async () => {
    const ctx = await buildCtx();
    const start = await startWorkflow(ctx);

    // Pass stateToken where checkpointToken is expected — different token kind
    const result = await handleV2CheckpointWorkflow({ checkpointToken: start.stateToken }, ctx);
    expect(result.type).toBe('error');
  });

  it('writes checkpoint node_created and edge_created events to session store', async () => {
    const ctx = await buildCtx();
    const start = await startWorkflow(ctx);

    const cp = await handleV2CheckpointWorkflow({ checkpointToken: start.checkpointToken }, ctx);
    expect(cp.type).toBe('success');

    // Load session truth to verify durable events
    const parsed = parseCheckpointTokenOrFail(start.checkpointToken, ctx.v2!.tokenCodecPorts!);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const sessionId = asSessionId(String(parsed.token.payload.sessionId));
    const truthRes = await ctx.v2!.sessionStore.load(sessionId);
    if (truthRes.isErr()) {
      console.error('Session load error:', JSON.stringify(truthRes.error));
    }
    expect(truthRes.isOk()).toBe(true);
    if (!truthRes.isOk()) return;

    const truth = truthRes.value;
    const cpNodes = truth.events.filter(e => e.kind === 'node_created' && e.data.nodeKind === 'checkpoint');
    const cpEdges = truth.events.filter(e => e.kind === 'edge_created' && e.data.edgeKind === 'checkpoint');

    expect(cpNodes).toHaveLength(1);
    expect(cpEdges).toHaveLength(1);

    // Edge references the checkpoint node
    expect(cpEdges[0].data.toNodeId).toBe(cpNodes[0].scope?.nodeId);
    // Edge cause references node_created event ID (not a stringified index)
    expect(cpEdges[0].data.cause.eventId).toBe(cpNodes[0].eventId);
    expect(cpEdges[0].data.cause.kind).toBe('checkpoint_created');
  });

  it('idempotent replay does not create duplicate events', async () => {
    const ctx = await buildCtx();
    const start = await startWorkflow(ctx);

    // Checkpoint twice with same token
    const r1 = await handleV2CheckpointWorkflow({ checkpointToken: start.checkpointToken }, ctx);
    const r2 = await handleV2CheckpointWorkflow({ checkpointToken: start.checkpointToken }, ctx);
    if (r1.type === 'error') console.error('Checkpoint 1 error:', JSON.stringify(r1));
    if (r2.type === 'error') console.error('Checkpoint 2 error:', JSON.stringify(r2));

    const parsed = parseCheckpointTokenOrFail(start.checkpointToken, ctx.v2!.tokenCodecPorts!);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const sessionId = asSessionId(String(parsed.token.payload.sessionId));
    const truthRes = await ctx.v2!.sessionStore.load(sessionId);
    if (truthRes.isErr()) {
      console.error('Session load error:', JSON.stringify(truthRes.error));
    }
    expect(truthRes.isOk()).toBe(true);
    if (!truthRes.isOk()) return;

    const truth = truthRes.value;
    const cpNodes = truth.events.filter(e => e.kind === 'node_created' && e.data.nodeKind === 'checkpoint');
    const cpEdges = truth.events.filter(e => e.kind === 'edge_created' && e.data.edgeKind === 'checkpoint');

    // Only ONE checkpoint node + edge, not two
    expect(cpNodes).toHaveLength(1);
    expect(cpEdges).toHaveLength(1);
  });
});
