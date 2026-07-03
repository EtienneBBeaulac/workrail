import { createTestValidationPipelineDeps } from '../helpers/v2-test-helpers.js';
import { startWorkflowForTest } from '../helpers/v2-start-workflow-helper.js';
import { unwrapResponse } from '../helpers/unwrap-response.js';
import 'reflect-metadata';
import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { executeContinueWorkflow } from '../../src/mcp/handlers/v2-execution/index.js';
import type { ToolContext } from '../../src/mcp/types.js';
import type { V2StartWorkflowInput, V2ContinueWorkflowInput } from '../../src/mcp/v2/tools.js';

import { createWorkflow } from '../../src/types/workflow.js';
import { createProjectDirectorySource } from '../../src/types/workflow-source.js';

import { LocalDataDirV2 } from '../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../src/v2/infra/local/fs/index.js';
import { NodeSha256V2 } from '../../src/v2/infra/local/sha256/index.js';
import { LocalSessionEventLogStoreV2 } from '../../src/v2/infra/local/session-store/index.js';
import { LocalSessionLockV2 } from '../../src/v2/infra/local/session-lock/index.js';
import { NodeCryptoV2 } from '../../src/v2/infra/local/crypto/index.js';
import { LocalSnapshotStoreV2 } from '../../src/v2/infra/local/snapshot-store/index.js';
import { LocalPinnedWorkflowStoreV2 } from '../../src/v2/infra/local/pinned-workflow-store/index.js';
import { ExecutionSessionGateV2 } from '../../src/v2/usecases/execution-session-gate.js';

import { unsafeTokenCodecPorts } from '../../src/v2/durable-core/tokens/index.js';
import { InMemoryTokenAliasStoreV2 } from '../../src/v2/infra/in-memory/token-alias-store/index.js';
import { NodeHmacSha256V2 } from '../../src/v2/infra/local/hmac-sha256/index.js';
import { NodeBase64UrlV2 } from '../../src/v2/infra/local/base64url/index.js';
import { LocalKeyringV2 } from '../../src/v2/infra/local/keyring/index.js';
import { NodeRandomEntropyV2 } from '../../src/v2/infra/local/random-entropy/index.js';
import { NodeTimeClockV2 } from '../../src/v2/infra/local/time-clock/index.js';
import { IdFactoryV2 } from '../../src/v2/infra/local/id-factory/index.js';
import { Bech32mAdapterV2 } from '../../src/v2/infra/local/bech32m/index.js';
import { Base32AdapterV2 } from '../../src/v2/infra/local/base32/index.js';

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-breaker-'));
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

describe('MCP Attempt Circuit Breaker & Blocker UI Adaptations', () => {
  afterEach(() => {
    delete process.env.WORKRAIL_DATA_DIR;
  });

  const workflowId = 'breaker-test';
  const workflowDef = {
    id: workflowId,
    name: 'Breaker Test',
    description: 'Tests circuit breaker limits and context-aware error messages',
    version: '1.0.0',
    steps: [
      {
        id: 'coding-step',
        title: 'Coding Step',
        prompt: 'Submit coding handoff.',
        outputContract: {
          contractRef: 'wr.contracts.coding_handoff',
        },
      },
      { id: 'step-next', title: 'Next step', prompt: 'Next step prompt' },
    ],
  };

  it('autonomous daemon session: fails strictly on 4th call (attempt #4), uses complete_step suggestions', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;

    try {
      const ctx = await mkCtxWithWorkflow(workflowId, workflowDef);

      // Start workflow as autonomous daemon
      const startRes = await startWorkflowForTest(
        { workflowId, workspacePath: root, goal: 'daemon run' } as V2StartWorkflowInput,
        ctx,
        { is_autonomous: 'true', triggerSource: 'daemon' }
      );
      expect(startRes.type).toBe('success');
      if (startRes.type !== 'success') return;

      let continueToken = unwrapResponse(startRes.data).continueToken;

      // First failed attempt
      let res = await executeContinueWorkflow(
        { continueToken, output: { notesMarkdown: 'first notes', artifacts: [{ kind: 'wr.coding_handoff', version: 1 }] } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(res.isOk()).toBe(true);
      if (!res.isOk()) return;
      expect(res.value.response.kind).toBe('blocked');
      const response = res.value.response as any;
      expect(response.blockers.blockers[0].suggestedFix).toContain("complete_step's artifacts[] parameter");
      expect(response.validation?.issues.length).toBeGreaterThan(0);

      continueToken = res.value.response.continueToken;

      // Second failed attempt
      res = await executeContinueWorkflow(
        { continueToken: res.value.response.retryContinueToken!, output: { notesMarkdown: 'second notes', artifacts: [{ kind: 'wr.coding_handoff', version: 1 }] } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(res.isOk()).toBe(true);
      if (!res.isOk()) return;
      expect(res.value.response.kind).toBe('blocked');
      continueToken = res.value.response.continueToken;

      // Third failed attempt
      res = await executeContinueWorkflow(
        { continueToken: res.value.response.retryContinueToken!, output: { notesMarkdown: 'third notes', artifacts: [{ kind: 'wr.coding_handoff', version: 1 }] } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(res.isOk()).toBe(true);
      if (!res.isOk()) return;
      expect(res.value.response.kind).toBe('blocked');

      // Fourth attempt: exceeding limit of 3 should trip the circuit breaker and return a PRECONDITION_FAILED failure
      const limitExceededRes = await executeContinueWorkflow(
        { continueToken: res.value.response.retryContinueToken!, output: { notesMarkdown: 'fourth notes', artifacts: [{ kind: 'wr.coding_handoff', version: 1 }] } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(limitExceededRes.isErr()).toBe(true);
      if (!limitExceededRes.isErr()) return;

      const failure = limitExceededRes.error as any;
      expect(failure.kind).toBe('precondition_failed');
      expect(failure.message).toContain('Step failed after 3 attempts');
      expect(failure.message).not.toContain('Rehydrate');
      expect(failure.message).not.toContain('Rewind');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });

  it('MCP/interactive session: allows up to 10 attempts, uses continue_workflow suggestions, returns recovery instructions', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;

    try {
      const ctx = await mkCtxWithWorkflow(workflowId, workflowDef);

      // Start workflow as MCP (non-autonomous)
      const startRes = await startWorkflowForTest(
        { workflowId, workspacePath: root, goal: 'mcp run' } as V2StartWorkflowInput,
        ctx,
        { triggerSource: 'mcp' } // triggerSource = mcp triggers isAutonomous = false
      );
      expect(startRes.type).toBe('success');
      if (startRes.type !== 'success') return;

      let currentToken = unwrapResponse(startRes.data).continueToken;
      let retryToken = '';

      // Run 10 blocked attempts
      for (let attempt = 1; attempt <= 10; attempt++) {
        const tokenToUse = attempt === 1 ? currentToken : retryToken;
        const res = await executeContinueWorkflow(
          { continueToken: tokenToUse, output: { notesMarkdown: `attempt ${attempt} notes`, artifacts: [{ kind: 'wr.coding_handoff', version: 1 }] } } as V2ContinueWorkflowInput,
          ctx
        );
        expect(res.isOk()).toBe(true);
        if (!res.isOk()) return;
        expect(res.value.response.kind).toBe('blocked');
        
        const response = res.value.response as any;
        // Assert that suggestions dynamically map to continue_workflow and output.artifacts
        expect(response.blockers.blockers[0].suggestedFix).toContain("continue_workflow's output.artifacts parameter");
        expect(response.validation?.issues.length).toBeGreaterThan(0);

        currentToken = res.value.response.continueToken;
        retryToken = res.value.response.retryContinueToken!;
      }

      // 11th attempt: exceeding limit of 10 should trip breaker and return unbricking instructions
      const limitExceededRes = await executeContinueWorkflow(
        { continueToken: retryToken, output: { notesMarkdown: '11th notes', artifacts: [{ kind: 'wr.coding_handoff', version: 1 }] } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(limitExceededRes.isErr()).toBe(true);
      if (!limitExceededRes.isErr()) return;

      const failure = limitExceededRes.error as any;
      expect(failure.kind).toBe('precondition_failed');
      expect(failure.message).toContain('Step failed after 10 attempts');
      expect(failure.message).toContain('Rehydrate');
      expect(failure.message).toContain('Rewind');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });
});
