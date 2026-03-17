/**
 * Tests that replaying an advance via continueToken is idempotent.
 * Uses the actual start_workflow → advance → replay flow.
 */
import { createTestValidationPipelineDeps } from "../helpers/v2-test-helpers.js";
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { handleV2StartWorkflow, handleV2ContinueWorkflow } from '../../src/mcp/handlers/v2-execution.js';
import type { ToolContext, V2Dependencies } from '../../src/mcp/types.js';
import type { V2StartWorkflowInput, V2ContinueWorkflowInput } from '../../src/mcp/v2/tools.js';
import { setupIntegrationTest, teardownIntegrationTest, resolveService } from '../di/integration-container.js';
import { DI } from '../../src/di/tokens.js';

import { ExecutionSessionGateV2 } from '../../src/v2/usecases/execution-session-gate.js';
import { LocalDataDirV2 } from '../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../src/v2/infra/local/fs/index.js';
import { NodeSha256V2 } from '../../src/v2/infra/local/sha256/index.js';
import { LocalSessionEventLogStoreV2 } from '../../src/v2/infra/local/session-store/index.js';
import { LocalSessionLockV2 } from '../../src/v2/infra/local/session-lock/index.js';
import { LocalSnapshotStoreV2 } from '../../src/v2/infra/local/snapshot-store/index.js';
import { NodeCryptoV2 } from '../../src/v2/infra/local/crypto/index.js';
import { LocalPinnedWorkflowStoreV2 } from '../../src/v2/infra/local/pinned-workflow-store/index.js';
import { NodeHmacSha256V2 } from '../../src/v2/infra/local/hmac-sha256/index.js';
import { LocalKeyringV2 } from '../../src/v2/infra/local/keyring/index.js';
import { NodeBase64UrlV2 } from '../../src/v2/infra/local/base64url/index.js';
import { NodeRandomEntropyV2 } from '../../src/v2/infra/local/random-entropy/index.js';
import { NodeTimeClockV2 } from '../../src/v2/infra/local/time-clock/index.js';
import { IdFactoryV2 } from '../../src/v2/infra/local/id-factory/index.js';
import { Bech32mAdapterV2 } from '../../src/v2/infra/local/bech32m/index.js';
import { Base32AdapterV2 } from '../../src/v2/infra/local/base32/index.js';
import { unsafeTokenCodecPorts } from '../../src/v2/durable-core/tokens/index.js';
import { InMemoryTokenAliasStoreV2 } from '../../src/v2/infra/in-memory/token-alias-store/index.js';

let prevDataDir: string | undefined;

async function mkV2Deps(): Promise<V2Dependencies> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-blocked-'));
  process.env.WORKRAIL_DATA_DIR = root;
  const dataDir = new LocalDataDirV2(process.env);
  const fsPort = new NodeFileSystemV2();
  const sha256 = new NodeSha256V2();
  const sessionEventLogStore = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha256);
  const clock = new NodeTimeClockV2();
  const sessionLock = new LocalSessionLockV2(dataDir, fsPort, clock);
  const sessionGate = new ExecutionSessionGateV2(sessionLock, sessionEventLogStore);
  const crypto = new NodeCryptoV2();
  const hmac = new NodeHmacSha256V2();
  const base64url = new NodeBase64UrlV2();
  const entropy = new NodeRandomEntropyV2();
  const idFactory = new IdFactoryV2(entropy);
  const base32 = new Base32AdapterV2();
  const bech32m = new Bech32mAdapterV2();
  const snapshotStore = new LocalSnapshotStoreV2(dataDir, fsPort, crypto);
  const pinnedStore = new LocalPinnedWorkflowStoreV2(dataDir, fsPort);
  const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);
  const keyring = await keyringPort.loadOrCreate().match(v => v, e => { throw new Error(`keyring: ${e.code}`); });
  const tokenCodecPorts = unsafeTokenCodecPorts({ keyring, hmac, base64url, base32, bech32m });
  
  return {
    gate: sessionGate,
    sessionStore: sessionEventLogStore,
    snapshotStore,
    pinnedStore,
    sha256,
    crypto,
    entropy,
    tokenCodecPorts,
    tokenAliasStore: new InMemoryTokenAliasStoreV2(),
    validationPipelineDeps: createTestValidationPipelineDeps(),
    idFactory,
    sessionGate,
    sessionEventLogStore,
  } as any;
}

describe('v2 continue_workflow: advance replay idempotency', () => {
  beforeEach(async () => {
    prevDataDir = process.env.WORKRAIL_DATA_DIR;
    await setupIntegrationTest({
      storage: new (await import('../../src/infrastructure/storage/in-memory-storage.js')).InMemoryWorkflowStorage([
        {
          id: 'blocked-test-wf',
          name: 'Blocked Test',
          description: 'Test workflow for blocked outcome tests',
          version: '1.0.0',
          steps: [
            { id: 'step1', title: 'Step 1', prompt: 'Do step 1' },
            { id: 'step2', title: 'Step 2', prompt: 'Do step 2' },
          ],
        } as any,
      ]),
      disableSessionTools: true,
    });
  });

  afterEach(async () => {
    teardownIntegrationTest();
    process.env.WORKRAIL_DATA_DIR = prevDataDir;
  });

  it('replays advance deterministically (no duplicate advance_recorded)', async () => {
    const workflowService = resolveService<any>(DI.Services.Workflow);
    const featureFlags = resolveService<any>(DI.Infra.FeatureFlags);
    const v2 = await mkV2Deps();
    const ctx: ToolContext = { workflowService, featureFlags, sessionManager: null, httpServer: null, v2 };

    // 1. Start workflow
    const startRes = await handleV2StartWorkflow(
      { workflowId: 'blocked-test-wf' } as V2StartWorkflowInput,
      ctx
    );
    expect(startRes.type).toBe('success');
    if (startRes.type !== 'success') return;

    const startToken = startRes.data.continueToken;

    // 2. Advance with output
    const firstAdvance = await handleV2ContinueWorkflow(
      { continueToken: startToken, output: { notesMarkdown: 'some output' } } as V2ContinueWorkflowInput,
      ctx
    );
    expect(firstAdvance.type).toBe('success');
    if (firstAdvance.type !== 'success') return;

    // 3. Replay the same token — should return identical result (idempotency)
    const replay1 = await handleV2ContinueWorkflow(
      { continueToken: startToken, intent: 'advance' } as any,
      ctx
    );
    expect(replay1.type).toBe('success');
    if (replay1.type !== 'success') return;
    expect(replay1.data.kind).toBe(firstAdvance.data.kind);
    expect(replay1.data.continueToken).toBe(firstAdvance.data.continueToken);
    expect(replay1.data.checkpointToken).toBe(firstAdvance.data.checkpointToken);

    // 4. Replay again — still idempotent
    const replay2 = await handleV2ContinueWorkflow(
      { continueToken: startToken, intent: 'advance' } as any,
      ctx
    );
    expect(replay2.type).toBe('success');
    if (replay2.type !== 'success') return;
    expect(replay2.data.continueToken).toBe(firstAdvance.data.continueToken);
    expect(replay2.data.checkpointToken).toBe(firstAdvance.data.checkpointToken);
  });

  it('maintains deterministic response across multiple replays', async () => {
    const workflowService = resolveService<any>(DI.Services.Workflow);
    const featureFlags = resolveService<any>(DI.Infra.FeatureFlags);
    const v2 = await mkV2Deps();
    const ctx: ToolContext = { workflowService, featureFlags, sessionManager: null, httpServer: null, v2 };

    // Start + advance
    const startRes = await handleV2StartWorkflow(
      { workflowId: 'blocked-test-wf' } as V2StartWorkflowInput,
      ctx
    );
    expect(startRes.type).toBe('success');
    if (startRes.type !== 'success') return;

    const advanceRes = await handleV2ContinueWorkflow(
      { continueToken: startRes.data.continueToken, output: { notesMarkdown: 'test' } } as V2ContinueWorkflowInput,
      ctx
    );
    expect(advanceRes.type).toBe('success');
    if (advanceRes.type !== 'success') return;

    // Replay three times — all must be identical
    const token = startRes.data.continueToken;
    const r1 = await handleV2ContinueWorkflow({ continueToken: token, intent: 'advance' } as any, ctx);
    const r2 = await handleV2ContinueWorkflow({ continueToken: token, intent: 'advance' } as any, ctx);
    const r3 = await handleV2ContinueWorkflow({ continueToken: token, intent: 'advance' } as any, ctx);

    expect(r1.type).toBe('success');
    expect(r2.type).toBe('success');
    expect(r3.type).toBe('success');

    if (r1.type === 'success' && r2.type === 'success' && r3.type === 'success') {
      // All responses should be structurally identical
      expect(r1.data.continueToken).toBe(r2.data.continueToken);
      expect(r2.data.continueToken).toBe(r3.data.continueToken);
      expect(r1.data.checkpointToken).toBe(r2.data.checkpointToken);
      expect(r2.data.checkpointToken).toBe(r3.data.checkpointToken);
    }
  });
});
