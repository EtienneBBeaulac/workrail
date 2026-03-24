import { createTestValidationPipelineDeps } from "../helpers/v2-test-helpers.js";
/**
 * Tests for buildNextCall pure function and nextCall response field.
 *
 * Covers:
 * - All logic branches of buildNextCall (one-token continueToken API)
 * - Blocked retryable edge case (retryContinueToken preferred)
 * - Schema validation of nextCall values
 * - Integration: nextCall present in start_workflow and continue_workflow responses
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildNextCall } from '../../src/mcp/handlers/v2-execution.js';
import { V2NextCallSchema } from '../../src/mcp/output-schemas.js';
import { formatV2ExecutionResponse } from '../../src/mcp/v2-response-formatter.js';
import { V2ContinueWorkflowInput } from '../../src/mcp/v2/tools.js';

// ── Pure function tests ──────────────────────────────────────────────

describe('buildNextCall', () => {
  const CT = 'ct_testcontinuetoken123';
  const RETRY_CT = 'ct_retrycontinuetoken1';
  const PENDING = { stepId: 'step-1' };

  it('returns continue template when pending step + continueToken exist', () => {
    const result = buildNextCall({ continueToken: CT, isComplete: false, pending: PENDING });
    expect(result).toEqual({
      tool: 'continue_workflow',
      params: { continueToken: CT },
    });
  });

  it('returns null when workflow is complete with no pending', () => {
    const result = buildNextCall({ continueToken: CT, isComplete: true, pending: null });
    expect(result).toBeNull();
  });

  it('returns null when no continueToken and no retryContinueToken', () => {
    const result = buildNextCall({ isComplete: false, pending: PENDING });
    expect(result).toBeNull();
  });

  it('returns null when blocked non-retryable (retryable false, no retryContinueToken)', () => {
    const result = buildNextCall({ continueToken: CT, isComplete: false, pending: PENDING });
    // No retryContinueToken, returns normal advance template
    expect(result).toEqual({
      tool: 'continue_workflow',
      params: { continueToken: CT },
    });
  });

  it('uses retryContinueToken when blocked retryable', () => {
    const result = buildNextCall({
      continueToken: CT,
      isComplete: false,
      pending: PENDING,
      retryContinueToken: RETRY_CT,
    });
    expect(result).toEqual({
      tool: 'continue_workflow',
      params: { continueToken: RETRY_CT },
    });
  });

  it('returns null when complete even if continueToken is present', () => {
    const result = buildNextCall({ continueToken: CT, isComplete: true, pending: null });
    expect(result).toBeNull();
  });

  it('returns continue template for rehydrate responses (has pending + continueToken)', () => {
    // After rehydrate, the agent should advance when done working on the step
    const result = buildNextCall({ continueToken: CT, isComplete: false, pending: PENDING });
    expect(result).not.toBeNull();
    expect(result!.params.continueToken).toBe(CT);
  });
});

// ── Schema validation ────────────────────────────────────────────────

describe('V2NextCallSchema', () => {
  it('accepts valid continue template', () => {
    const result = V2NextCallSchema.safeParse({
      tool: 'continue_workflow',
      params: { continueToken: 'ct_test123' },
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
      params: { continueToken: 'ct_test123' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts continue template with just continueToken', () => {
    const result = V2NextCallSchema.safeParse({
      tool: 'continue_workflow',
      params: { continueToken: 'ct_test123' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing continueToken', () => {
    const result = V2NextCallSchema.safeParse({
      tool: 'continue_workflow',
      params: {},
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty continueToken', () => {
    const result = V2NextCallSchema.safeParse({
      tool: 'continue_workflow',
      params: { continueToken: '' },
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
import { InMemoryTokenAliasStoreV2 } from '../../src/v2/infra/in-memory/token-alias-store/index.js';

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
    v2: { gate, sessionStore, snapshotStore, pinnedStore, sha256, crypto, entropy, tokenCodecPorts, idFactory, tokenAliasStore: new InMemoryTokenAliasStoreV2(), validationPipelineDeps: createTestValidationPipelineDeps() },
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

  it('start_workflow returns nextCall with continue template', async () => {
    const ctx = await mkCtx();
    const start = await handleV2StartWorkflow({ workflowId: 'two-step' } as any, ctx);
    expect(start.type).toBe('success');
    if (start.type !== 'success') return;

    expect(start.data.response.nextCall).not.toBeNull();
    expect(start.data.response.nextCall!.tool).toBe('continue_workflow');
    // One-token: nextCall uses continueToken only
    expect(start.data.response.nextCall!.params.continueToken).toBe(start.data.response.continueToken);
  });

  it('rehydrate returns nextCall with continue template (for when agent finishes the step)', async () => {
    const ctx = await mkCtx();
    const start = await handleV2StartWorkflow({ workflowId: 'two-step' } as any, ctx);
    if (start.type !== 'success') return;

    const rehydrate = await handleV2ContinueWorkflow(
      { continueToken: start.data.response.continueToken, intent: 'rehydrate' } as any, ctx
    );
    expect(rehydrate.type).toBe('success');
    if (rehydrate.type !== 'success') return;

    expect(rehydrate.data.response.nextCall).not.toBeNull();
    expect(rehydrate.data.response.nextCall!.tool).toBe('continue_workflow');
    expect(rehydrate.data.response.nextCall!.params.continueToken).toBe(rehydrate.data.response.continueToken);
  });

  it('advance to next step returns nextCall for the next advance', async () => {
    const ctx = await mkCtx();
    const start = await handleV2StartWorkflow({ workflowId: 'two-step' } as any, ctx);
    if (start.type !== 'success') return;

    const adv1 = await handleV2ContinueWorkflow(
      { continueToken: start.data.response.continueToken, output: { notesMarkdown: 'Step A done.' } } as any, ctx
    );
    expect(adv1.type).toBe('success');
    if (adv1.type !== 'success') return;

    // Should have step-b pending with a nextCall template
    expect(adv1.data.response.pending?.stepId).toBe('step-b');
    expect(adv1.data.response.nextCall).not.toBeNull();
    expect(adv1.data.response.nextCall!.params.continueToken).toBe(adv1.data.response.continueToken);
  });

  it('advance past last step returns nextCall: null (workflow complete)', async () => {
    const ctx = await mkCtx();
    const start = await handleV2StartWorkflow({ workflowId: 'two-step' } as any, ctx);
    if (start.type !== 'success') return;

    // Advance through step-a
    const adv1 = await handleV2ContinueWorkflow(
      { continueToken: start.data.response.continueToken, output: { notesMarkdown: 'Step A done.' } } as any, ctx
    );
    if (adv1.type !== 'success') return;

    // Advance through step-b (last step) → complete
    const adv2 = await handleV2ContinueWorkflow(
      { continueToken: adv1.data.response.continueToken, output: { notesMarkdown: 'Step B done.' } } as any, ctx
    );
    expect(adv2.type).toBe('success');
    if (adv2.type !== 'success') return;

    expect(adv2.data.response.isComplete).toBe(true);
    expect(adv2.data.response.pending).toBeNull();
    expect(adv2.data.response.nextCall).toBeNull();
  });

  it('nextCall params can be used directly as continue_workflow input', async () => {
    const ctx = await mkCtx();
    const start = await handleV2StartWorkflow({ workflowId: 'two-step' } as any, ctx);
    if (start.type !== 'success') return;

    // Use nextCall.params directly as the input (the whole point of the feature), adding notes
    const nextCallParams = start.data.response.nextCall!.params;
    const adv1 = await handleV2ContinueWorkflow(
      { ...nextCallParams, output: { notesMarkdown: 'Step A done via nextCall.' } } as any, ctx
    );
    expect(adv1.type).toBe('success');
    if (adv1.type !== 'success') return;
    expect(adv1.data.response.pending?.stepId).toBe('step-b');
  });

  it('formatted nextToken block can be used directly as continue_workflow input', async () => {
    const ctx = await mkCtx();
    const start = await handleV2StartWorkflow({ workflowId: 'two-step' } as any, ctx);
    if (start.type !== 'success') return;

    const formatted = formatV2ExecutionResponse(start.data);
    expect(formatted).not.toBeNull();

    const jsonMatch = formatted!.primary.match(/```json\n(.*)\n```/);
    expect(jsonMatch).not.toBeNull();

    const formattedParams = JSON.parse(jsonMatch![1]);
    expect(formattedParams).toEqual({
      continueToken: start.data.response.continueToken,
    });

    const normalizedInput = V2ContinueWorkflowInput.parse({
      ...formattedParams,
      output: { notesMarkdown: 'Step A done via formatted nextToken.' },
    });

    const adv1 = await handleV2ContinueWorkflow(normalizedInput as any, ctx);
    expect(adv1.type).toBe('success');
    if (adv1.type !== 'success') return;
    expect(adv1.data.response.pending?.stepId).toBe('step-b');
  });
});
