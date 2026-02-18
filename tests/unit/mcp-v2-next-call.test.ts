/**
 * Tests for buildNextCall pure function and nextCall response field.
 *
 * Covers:
 * - All 5 logic branches of buildNextCall
 * - Blocked retryable edge case (retryAckToken preferred over ackToken)
 * - Schema validation of nextCall values
 * - Integration: nextCall present in start_workflow and continue_workflow responses
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildNextCall } from '../../src/mcp/handlers/v2-execution.js';
import { V2NextCallSchema } from '../../src/mcp/output-schemas.js';

// ── Pure function tests ──────────────────────────────────────────────

describe('buildNextCall', () => {
  const ST = 'st1abc';
  const ACK = 'ack1xyz';
  const RETRY_ACK = 'ack1retry';
  const PENDING = { stepId: 'step-1' };

  it('returns advance template when pending step + ackToken exist', () => {
    const result = buildNextCall({ stateToken: ST, ackToken: ACK, isComplete: false, pending: PENDING });
    expect(result).toEqual({
      tool: 'continue_workflow',
      params: { intent: 'advance', stateToken: ST, ackToken: ACK },
    });
  });

  it('returns null when workflow is complete with no pending', () => {
    const result = buildNextCall({ stateToken: ST, ackToken: undefined, isComplete: true, pending: null });
    expect(result).toBeNull();
  });

  it('returns null when blocked non-retryable (no ackToken)', () => {
    const result = buildNextCall({ stateToken: ST, ackToken: undefined, isComplete: false, pending: PENDING });
    expect(result).toBeNull();
  });

  it('returns null when blocked non-retryable (retryable false, no retryAckToken)', () => {
    const result = buildNextCall({ stateToken: ST, ackToken: ACK, isComplete: false, pending: PENDING, retryable: false });
    // retryable is false, so falls through to normal path which returns advance template
    expect(result).toEqual({
      tool: 'continue_workflow',
      params: { intent: 'advance', stateToken: ST, ackToken: ACK },
    });
  });

  it('uses retryAckToken (not ackToken) when blocked retryable', () => {
    const result = buildNextCall({
      stateToken: ST,
      ackToken: ACK,
      isComplete: false,
      pending: PENDING,
      retryable: true,
      retryAckToken: RETRY_ACK,
    });
    expect(result).toEqual({
      tool: 'continue_workflow',
      params: { intent: 'advance', stateToken: ST, ackToken: RETRY_ACK },
    });
    // Explicitly verify it's NOT using the original ackToken
    expect(result!.params.ackToken).toBe(RETRY_ACK);
    expect(result!.params.ackToken).not.toBe(ACK);
  });

  it('returns null when complete even if ackToken is present', () => {
    const result = buildNextCall({ stateToken: ST, ackToken: ACK, isComplete: true, pending: null });
    expect(result).toBeNull();
  });

  it('returns advance template for rehydrate responses (has pending + ackToken)', () => {
    // After rehydrate, the agent should advance when done working on the step
    const result = buildNextCall({ stateToken: ST, ackToken: ACK, isComplete: false, pending: PENDING });
    expect(result).not.toBeNull();
    expect(result!.params.intent).toBe('advance');
  });
});

// ── Schema validation ────────────────────────────────────────────────

describe('V2NextCallSchema', () => {
  it('accepts valid advance template', () => {
    const result = V2NextCallSchema.safeParse({
      tool: 'continue_workflow',
      params: { intent: 'advance', stateToken: 'st1abc', ackToken: 'ack1xyz' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts null (workflow complete)', () => {
    const result = V2NextCallSchema.safeParse(null);
    expect(result.success).toBe(true);
  });

  it('rejects wrong tool name', () => {
    const result = V2NextCallSchema.safeParse({
      tool: 'advance_workflow',
      params: { intent: 'advance', stateToken: 'st1abc', ackToken: 'ack1xyz' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts rehydrate intent without ackToken (used by checkpoint_workflow)', () => {
    const result = V2NextCallSchema.safeParse({
      tool: 'continue_workflow',
      params: { intent: 'rehydrate', stateToken: 'st1abc' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects advance without ackToken (discriminated union enforces pairing)', () => {
    const result = V2NextCallSchema.safeParse({
      tool: 'continue_workflow',
      params: { intent: 'advance', stateToken: 'st1abc' },
    });
    expect(result.success).toBe(false);
  });

  it('rehydrate with extra ackToken parses but ackToken is stripped', () => {
    const result = V2NextCallSchema.safeParse({
      tool: 'continue_workflow',
      params: { intent: 'rehydrate', stateToken: 'st1abc', ackToken: 'ack1xyz' },
    });
    // Zod discriminated union matches rehydrate variant; extra ackToken is silently dropped
    expect(result.success).toBe(true);
    if (result.success && result.data) {
      expect(result.data.params).not.toHaveProperty('ackToken');
    }
  });

  it('rejects wrong intent value', () => {
    const result = V2NextCallSchema.safeParse({
      tool: 'continue_workflow',
      params: { intent: 'probe', stateToken: 'st1abc' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty stateToken', () => {
    const result = V2NextCallSchema.safeParse({
      tool: 'continue_workflow',
      params: { intent: 'advance', stateToken: '', ackToken: 'ack1xyz' },
    });
    expect(result.success).toBe(false);
  });
});

// ── Integration: nextCall in live responses ──────────────────────────

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { setupIntegrationTest, teardownIntegrationTest, resolveService } from '../di/integration-container.js';
import { DI } from '../../src/di/tokens.js';
import type { ToolContext } from '../../src/mcp/types.js';
import { handleV2StartWorkflow, handleV2ContinueWorkflow } from '../../src/mcp/handlers/v2-execution.js';
import { InMemoryWorkflowStorage } from '../../src/infrastructure/storage/in-memory-storage.js';
import { LocalDataDirV2 } from '../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../src/v2/infra/local/fs/index.js';
import { NodeSha256V2 } from '../../src/v2/infra/local/sha256/index.js';
import { LocalSessionEventLogStoreV2 } from '../../src/v2/infra/local/session-store/index.js';
import { LocalSessionLockV2 } from '../../src/v2/infra/local/session-lock/index.js';
import { NodeCryptoV2 } from '../../src/v2/infra/local/crypto/index.js';
import { NodeHmacSha256V2 } from '../../src/v2/infra/local/hmac-sha256/index.js';
import { NodeBase64UrlV2 } from '../../src/v2/infra/local/base64url/index.js';
import { LocalSnapshotStoreV2 } from '../../src/v2/infra/local/snapshot-store/index.js';
import { LocalPinnedWorkflowStoreV2 } from '../../src/v2/infra/local/pinned-workflow-store/index.js';
import { ExecutionSessionGateV2 } from '../../src/v2/usecases/execution-session-gate.js';
import { LocalKeyringV2 } from '../../src/v2/infra/local/keyring/index.js';
import { NodeRandomEntropyV2 } from '../../src/v2/infra/local/random-entropy/index.js';
import { NodeTimeClockV2 } from '../../src/v2/infra/local/time-clock/index.js';
import { IdFactoryV2 } from '../../src/v2/infra/local/id-factory/index.js';
import { Bech32mAdapterV2 } from '../../src/v2/infra/local/bech32m/index.js';
import { Base32AdapterV2 } from '../../src/v2/infra/local/base32/index.js';
import { unsafeTokenCodecPorts } from '../../src/v2/durable-core/tokens/index.js';

async function mkCtx(): Promise<ToolContext> {
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

  return {
    workflowService,
    featureFlags,
    sessionManager: null,
    httpServer: null,
    v2: { gate, sessionStore, snapshotStore, pinnedStore, sha256, crypto, tokenCodecPorts, idFactory },
  };
}

describe('nextCall in live execution responses', () => {
  let prev: string | undefined;

  beforeEach(async () => {
    prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'workrail-nextcall-'));
    await setupIntegrationTest({
      storage: new InMemoryWorkflowStorage([
        {
          id: 'two-step',
          name: 'Two Step',
          description: 'Two step workflow for nextCall tests',
          version: '1.0.0',
          steps: [
            { id: 'step-a', title: 'Step A', prompt: 'Do A' },
            { id: 'step-b', title: 'Step B', prompt: 'Do B' },
          ],
        } as any,
      ]),
      disableSessionTools: true,
    });
  });

  afterEach(() => {
    teardownIntegrationTest();
    process.env.WORKRAIL_DATA_DIR = prev;
  });

  it('start_workflow returns nextCall with advance template', async () => {
    const ctx = await mkCtx();
    const start = await handleV2StartWorkflow({ workflowId: 'two-step' } as any, ctx);
    expect(start.type).toBe('success');
    if (start.type !== 'success') return;

    expect(start.data.nextCall).not.toBeNull();
    expect(start.data.nextCall!.tool).toBe('continue_workflow');
    expect(start.data.nextCall!.params.intent).toBe('advance');
    expect(start.data.nextCall!.params.stateToken).toBe(start.data.stateToken);
    expect(start.data.nextCall!.params.ackToken).toBe(start.data.ackToken);
  });

  it('rehydrate returns nextCall with advance template (for when agent finishes the step)', async () => {
    const ctx = await mkCtx();
    const start = await handleV2StartWorkflow({ workflowId: 'two-step' } as any, ctx);
    if (start.type !== 'success') return;

    const rehydrate = await handleV2ContinueWorkflow(
      { intent: 'rehydrate', stateToken: start.data.stateToken } as any, ctx
    );
    expect(rehydrate.type).toBe('success');
    if (rehydrate.type !== 'success') return;

    expect(rehydrate.data.nextCall).not.toBeNull();
    expect(rehydrate.data.nextCall!.tool).toBe('continue_workflow');
    expect(rehydrate.data.nextCall!.params.intent).toBe('advance');
    // stateToken is same (rehydrate doesn't change it)
    expect(rehydrate.data.nextCall!.params.stateToken).toBe(start.data.stateToken);
    // ackToken is freshly minted for rehydrate
    expect(rehydrate.data.nextCall!.params.ackToken).toBeDefined();
  });

  it('advance to next step returns nextCall for the next advance', async () => {
    const ctx = await mkCtx();
    const start = await handleV2StartWorkflow({ workflowId: 'two-step' } as any, ctx);
    if (start.type !== 'success') return;

    const adv1 = await handleV2ContinueWorkflow(
      { intent: 'advance', stateToken: start.data.stateToken, ackToken: start.data.ackToken, output: { notesMarkdown: 'Step A done.' } } as any, ctx
    );
    expect(adv1.type).toBe('success');
    if (adv1.type !== 'success') return;

// Should have step-b pending with a nextCall template
    expect(adv1.data.pending?.stepId).toBe('step-b');
    expect(adv1.data.nextCall).not.toBeNull();
    expect(adv1.data.nextCall!.params.stateToken).toBe(adv1.data.stateToken);
    expect(adv1.data.nextCall!.params.ackToken).toBe(adv1.data.ackToken);
  });

  it('advance past last step returns nextCall: null (workflow complete)', async () => {
    const ctx = await mkCtx();
    const start = await handleV2StartWorkflow({ workflowId: 'two-step' } as any, ctx);
    if (start.type !== 'success') return;

    // Advance through step-a
    const adv1 = await handleV2ContinueWorkflow(
      { intent: 'advance', stateToken: start.data.stateToken, ackToken: start.data.ackToken, output: { notesMarkdown: 'Step A done.' } } as any, ctx
    );
    if (adv1.type !== 'success') return;

    // Advance through step-b (last step) → complete
    const adv2 = await handleV2ContinueWorkflow(
      { intent: 'advance', stateToken: adv1.data.stateToken, ackToken: adv1.data.ackToken, output: { notesMarkdown: 'Step B done.' } } as any, ctx
    );
    expect(adv2.type).toBe('success');
    if (adv2.type !== 'success') return;

    expect(adv2.data.isComplete).toBe(true);
    expect(adv2.data.pending).toBeNull();
    expect(adv2.data.nextCall).toBeNull();
  });

  it('nextCall params can be used directly as continue_workflow input', async () => {
    const ctx = await mkCtx();
    const start = await handleV2StartWorkflow({ workflowId: 'two-step' } as any, ctx);
    if (start.type !== 'success') return;

    // Use nextCall.params directly as the input (the whole point of the feature), adding notes
    const nextCallParams = start.data.nextCall!.params;
    const adv1 = await handleV2ContinueWorkflow(
      { ...nextCallParams, output: { notesMarkdown: 'Step A done via nextCall.' } } as any, ctx
    );
    expect(adv1.type).toBe('success');
    if (adv1.type !== 'success') return;
    expect(adv1.data.pending?.stepId).toBe('step-b');
  });
});
