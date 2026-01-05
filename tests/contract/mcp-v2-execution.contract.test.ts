import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { setupIntegrationTest, teardownIntegrationTest, resolveService } from '../di/integration-container';
import { DI } from '../../src/di/tokens.js';
import type { ToolContext } from '../../src/mcp/types.js';

import { handleV2StartWorkflow, handleV2ContinueWorkflow } from '../../src/mcp/handlers/v2-execution.js';
import { InMemoryWorkflowStorage } from '../../src/infrastructure/storage/in-memory-storage.js';
import { LocalDataDirV2 } from '../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../src/v2/infra/local/fs/index.js';
import { NodeSha256V2 } from '../../src/v2/infra/local/sha256/index.js';
import { LocalSessionEventLogStoreV2 } from '../../src/v2/infra/local/session-store/index.js';
import { LocalSessionLockV2 } from '../../src/v2/infra/local/session-lock/index.js';
import { ExecutionSessionGateV2 } from '../../src/v2/usecases/execution-session-gate.js';
import { LocalSnapshotStoreV2 } from '../../src/v2/infra/local/snapshot-store/index.js';
import { LocalPinnedWorkflowStoreV2 } from '../../src/v2/infra/local/pinned-workflow-store/index.js';
import { LocalKeyringV2 } from '../../src/v2/infra/local/keyring/index.js';
import { NodeCryptoV2 } from '../../src/v2/infra/local/crypto/index.js';
import { NodeHmacSha256V2 } from '../../src/v2/infra/local/hmac-sha256/index.js';
import { NodeBase64UrlV2 } from '../../src/v2/infra/local/base64url/index.js';
import { NodeRandomEntropyV2 } from '../../src/v2/infra/local/random-entropy/index.js';
import { NodeTimeClockV2 } from '../../src/v2/infra/local/time-clock/index.js';
import { IdFactoryV2 } from '../../src/v2/infra/local/id-factory/index.js';
import { Bech32mAdapterV2 } from '../../src/v2/infra/local/bech32m/index.js';

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-exec-contract-'));
}

/**
 * Helper to create a v2-enabled ToolContext with deterministic workflow dependencies.
 */
async function createV2Context(): Promise<ToolContext> {
  const workflowService = resolveService<any>(DI.Services.Workflow);
  const featureFlags = resolveService<any>(DI.Infra.FeatureFlags);

  const dataDir = new LocalDataDirV2(process.env);
  const fsPort = new NodeFileSystemV2();
  const sha256 = new NodeSha256V2();
  const crypto = new NodeCryptoV2();
  const hmac = new NodeHmacSha256V2();
  const base64url = new NodeBase64UrlV2();
  const entropy = new NodeRandomEntropyV2();
  const idFactory = new IdFactoryV2(entropy);
  const bech32m = new Bech32mAdapterV2();
  const clock = new NodeTimeClockV2();
  const sessionStore = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha256);
  const lockPort = new LocalSessionLockV2(dataDir, fsPort, clock);
  const gate = new ExecutionSessionGateV2(lockPort, sessionStore);
  const snapshotStore = new LocalSnapshotStoreV2(dataDir, fsPort, crypto);
  const pinnedStore = new LocalPinnedWorkflowStoreV2(dataDir, fsPort);
  const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);
  const keyring = await keyringPort.loadOrCreate().match(v => v, e => { throw new Error(`keyring: ${e.code}`); });

  return {
    workflowService,
    featureFlags,
    sessionManager: null,
    httpServer: null,
    v2: {
      gate,
      sessionStore,
      snapshotStore,
      pinnedStore,
      keyring,
      sha256,
      crypto,
      hmac,
      base64url,
      bech32m,
      idFactory,
    },
  };
}

describe('MCP contract: v2 start_workflow / continue_workflow (Slice 3)', () => {
  let root: string;
  let prevDataDir: string | undefined;

  beforeEach(async () => {
    root = await mkTempDataDir();
    prevDataDir = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;

    await setupIntegrationTest({
      storage: new InMemoryWorkflowStorage([
        {
          id: 'v2-exec-contract',
          name: 'V2 Exec Contract',
          description: 'Contract test workflow for v2 execution surface',
          version: '1.0.0',
          steps: [{ id: 'triage', title: 'Triage', prompt: 'Do triage' }],
        } as any,
      ]),
      disableSessionTools: true,
    });
  });

  afterEach(async () => {
    teardownIntegrationTest();
    process.env.WORKRAIL_DATA_DIR = prevDataDir;
  });

  it('start -> rehydrate -> ack replay is deterministic and idempotent', async () => {
    const ctx = await createV2Context();

    const start = await handleV2StartWorkflow({ workflowId: 'v2-exec-contract', context: {} } as any, ctx);
    expect(start.type).toBe('success');
    if (start.type !== 'success') return;

    // Token size budget regression guard (prevents future payload bloat).
    expect(start.data.stateToken.length).toBeLessThan(170); // Binary tokens: ~166 chars
    expect(start.data.ackToken).toBeDefined();
    if (start.data.ackToken) {
      expect(start.data.ackToken.length).toBeLessThan(170); // Binary tokens: ~167 chars
    }

    expect(start.data.pending?.stepId).toBe('triage');
    expect(start.data.isComplete).toBe(false);

    const rehydrate1 = await handleV2ContinueWorkflow({ stateToken: start.data.stateToken } as any, ctx);
    expect(rehydrate1.type).toBe('success');
    if (rehydrate1.type !== 'success') return;
    expect(rehydrate1.data.kind).toBe('ok');
    expect(rehydrate1.data.pending?.stepId).toBe('triage');

    const rehydrate2 = await handleV2ContinueWorkflow({ stateToken: start.data.stateToken } as any, ctx);
    expect(rehydrate2.type).toBe('success');
    if (rehydrate2.type !== 'success') return;
    // Rehydrate is side-effect-free and deterministic in content, but may mint fresh ack/checkpoint tokens.
    expect(rehydrate2.data.kind).toBe('ok');
    expect(rehydrate2.data.stateToken).toBe(rehydrate1.data.stateToken);
    expect(rehydrate2.data.isComplete).toBe(rehydrate1.data.isComplete);
    expect(rehydrate2.data.pending).toEqual(rehydrate1.data.pending);

    const ack1 = await handleV2ContinueWorkflow({ stateToken: start.data.stateToken, ackToken: start.data.ackToken } as any, ctx);
    expect(ack1.type).toBe('success');
    if (ack1.type !== 'success') return;
    // This workflow has a single step; after acknowledging it we should complete.
    expect(ack1.data.kind).toBe('ok');
    expect(ack1.data.isComplete).toBe(true);
    expect(ack1.data.pending).toBeNull();

    const ack2 = await handleV2ContinueWorkflow({ stateToken: start.data.stateToken, ackToken: start.data.ackToken } as any, ctx);
    expect(ack2).toEqual(ack1); // idempotent replay

    // Verify v2 context is properly initialized
    expect(ctx.v2).toBeDefined();
    expect(ctx.v2.gate).toBeDefined();
    expect(ctx.v2.sessionStore).toBeDefined();
    expect(ctx.v2.snapshotStore).toBeDefined();
    expect(ctx.v2.pinnedStore).toBeDefined();
    expect(ctx.v2.keyring).toBeDefined();
    expect(ctx.v2.crypto).toBeDefined();
    expect(ctx.v2.hmac).toBeDefined();
  });
});
