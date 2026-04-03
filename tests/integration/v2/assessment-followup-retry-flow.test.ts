import { createTestValidationPipelineDeps } from '../../helpers/v2-test-helpers.js';
import 'reflect-metadata';
import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { handleV2StartWorkflow, handleV2ContinueWorkflow } from '../../../src/mcp/handlers/v2-execution.js';
import type { ToolContext } from '../../../src/mcp/types.js';
import type { V2StartWorkflowInput, V2ContinueWorkflowInput } from '../../../src/mcp/v2/tools.js';

import { createWorkflow } from '../../../src/types/workflow.js';
import { createProjectDirectorySource } from '../../../src/types/workflow-source.js';

import { LocalDataDirV2 } from '../../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../../src/v2/infra/local/fs/index.js';
import { NodeSha256V2 } from '../../../src/v2/infra/local/sha256/index.js';
import { LocalSessionEventLogStoreV2 } from '../../../src/v2/infra/local/session-store/index.js';
import { LocalSessionLockV2 } from '../../../src/v2/infra/local/session-lock/index.js';
import { NodeCryptoV2 } from '../../../src/v2/infra/local/crypto/index.js';
import { LocalSnapshotStoreV2 } from '../../../src/v2/infra/local/snapshot-store/index.js';
import { LocalPinnedWorkflowStoreV2 } from '../../../src/v2/infra/local/pinned-workflow-store/index.js';
import { ExecutionSessionGateV2 } from '../../../src/v2/usecases/execution-session-gate.js';
import { unsafeTokenCodecPorts } from '../../../src/v2/durable-core/tokens/index.js';
import { InMemoryTokenAliasStoreV2 } from '../../../src/v2/infra/in-memory/token-alias-store/index.js';
import { parseShortTokenNative } from '../../../src/v2/durable-core/tokens/short-token.js';
import { NodeHmacSha256V2 } from '../../../src/v2/infra/local/hmac-sha256/index.js';
import { NodeBase64UrlV2 } from '../../../src/v2/infra/local/base64url/index.js';
import { LocalKeyringV2 } from '../../../src/v2/infra/local/keyring/index.js';
import { NodeRandomEntropyV2 } from '../../../src/v2/infra/local/random-entropy/index.js';
import { NodeTimeClockV2 } from '../../../src/v2/infra/local/time-clock/index.js';
import { IdFactoryV2 } from '../../../src/v2/infra/local/id-factory/index.js';
import { Bech32mAdapterV2 } from '../../../src/v2/infra/local/bech32m/index.js';
import { Base32AdapterV2 } from '../../../src/v2/infra/local/base32/index.js';
import { asSessionId } from '../../../src/v2/durable-core/ids/index.js';

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-assessment-followup-'));
}

async function mkCtxWithWorkflow(workflowId: string, definition: any): Promise<ToolContext> {
  const wf = createWorkflow(
    definition as any,
    createProjectDirectorySource(path.join(os.tmpdir(), 'workrail-project'))
  );

  const dataDir = new LocalDataDirV2(process.env);
  const fsPort = new NodeFileSystemV2();
  const sha256 = new NodeSha256V2();
  const crypto = new NodeCryptoV2();
  const sessionStore = new LocalSessionEventLogStoreV2(dataDir, fsPort, sha256);
  const clock = new NodeTimeClockV2();
  const lockPort = new LocalSessionLockV2(dataDir, fsPort, clock);
  const gate = new ExecutionSessionGateV2(lockPort, sessionStore);
  const snapshotStore = new LocalSnapshotStoreV2(dataDir, fsPort, crypto);
  const pinnedStore = new LocalPinnedWorkflowStoreV2(dataDir, fsPort);
  const hmac = new NodeHmacSha256V2();
  const base64url = new NodeBase64UrlV2();
  const entropy = new NodeRandomEntropyV2();
  const idFactory = new IdFactoryV2(entropy);
  const base32 = new Base32AdapterV2();
  const bech32m = new Bech32mAdapterV2();
  const keyringPort = new LocalKeyringV2(dataDir, fsPort, base64url, entropy);
  const keyringRes = await keyringPort.loadOrCreate();
  if (keyringRes.isErr()) throw new Error(`keyring load failed: ${keyringRes.error.code}`);

  const tokenCodecPorts = unsafeTokenCodecPorts({
    keyring: keyringRes.value,
    hmac,
    base64url,
    base32,
    bech32m,
  });

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
      gate,
      sessionStore,
      snapshotStore,
      pinnedStore,
      sha256,
      crypto,
      entropy,
      idFactory,
      tokenCodecPorts,
      tokenAliasStore: new InMemoryTokenAliasStoreV2(),
      validationPipelineDeps: createTestValidationPipelineDeps(),
      sessionEventLogStore: sessionStore,
    },
  };
}

describe('Assessment follow-up retry flow (end-to-end)', () => {
  afterEach(() => {
    delete process.env.WORKRAIL_DATA_DIR;
  });

  it('records accepted assessment, blocks with follow-up, then retries same step successfully', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {
      const workflowId = 'assessment-followup-test';
      const ctx = await mkCtxWithWorkflow(workflowId, {
        id: workflowId,
        name: 'Assessment follow-up test',
        description: 'Tests assessment-triggered follow-up retry flow.',
        version: '1.0.0',
        assessments: [
          {
            id: 'readiness_gate',
            purpose: 'Assess readiness before proceeding.',
            dimensions: [
              { id: 'confidence', purpose: 'Confidence', levels: ['low', 'high'] },
            ],
          },
        ],
        steps: [
          {
            id: 'assessment-step',
            title: 'Assessment step',
            prompt: 'Assess readiness before continuing.',
            assessmentRefs: ['readiness_gate'],
            assessmentConsequences: [
              {
                when: { dimensionId: 'confidence', equalsLevel: 'low' },
                effect: { kind: 'require_followup', guidance: 'Gather more context before proceeding.' },
              },
            ],
          },
          { id: 'step-next', title: 'Next step', prompt: 'Next step prompt' },
        ],
      });

      const startRes = await handleV2StartWorkflow(
        { workflowId, goal: 'test workflow execution' } as V2StartWorkflowInput,
        ctx
      );
      expect(startRes.type).toBe('success');
      if (startRes.type !== 'success') return;

      const continueToken = startRes.data.continueToken;

      const blockRes = await handleV2ContinueWorkflow(
        {
          continueToken,
          output: {
            notesMarkdown: 'Initial assessment notes.',
            artifacts: [
              {
                kind: 'wr.assessment',
                assessmentId: 'readiness_gate',
                dimensions: { confidence: 'low' },
              },
            ],
          },
        } as V2ContinueWorkflowInput,
        ctx
      );

      expect(blockRes.type).toBe('success');
      if (blockRes.type !== 'success') return;
      expect(blockRes.data.kind).toBe('blocked');
      if (blockRes.data.kind !== 'blocked') return;

      expect(blockRes.data.retryable).toBe(true);
      expect(blockRes.data.retryContinueToken).toBeDefined();
      expect(blockRes.data.blockers.blockers[0]?.code).toBe('ASSESSMENT_FOLLOWUP_REQUIRED');
      expect(blockRes.data.assessmentFollowup?.guidance).toContain('Gather more context before proceeding.');

      const retryContinueToken = blockRes.data.retryContinueToken!;

      const sessionStore = ctx.v2!.sessionEventLogStore as any;
      const parsed = parseShortTokenNative(continueToken)!;
      const sessionId = asSessionId(ctx.v2!.tokenAliasStore.lookup(parsed.nonceHex)!.sessionId);
      const loadRes = await sessionStore.load(sessionId);
      if (loadRes.isErr()) throw new Error(`Unexpected load error: ${loadRes.error.code}`);
      const truth1 = loadRes.value;

      expect(truth1.events.some((e) => e.kind === 'assessment_recorded')).toBe(true);
      expect(truth1.events.some((e) => e.kind === 'assessment_consequence_applied')).toBe(true);
      expect(truth1.events.some((e) => e.kind === 'validation_performed')).toBe(false);

      const retryRes = await handleV2ContinueWorkflow(
        {
          continueToken: retryContinueToken,
          output: {
            notesMarkdown: 'Updated assessment notes with additional context.',
            artifacts: [
              {
                kind: 'wr.assessment',
                assessmentId: 'readiness_gate',
                dimensions: { confidence: 'high' },
              },
            ],
          },
        } as V2ContinueWorkflowInput,
        ctx
      );

      expect(retryRes.type).toBe('success');
      if (retryRes.type !== 'success') return;
      expect(retryRes.data.kind).toBe('ok');
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });
});
