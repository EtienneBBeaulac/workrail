import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { handleV2StartWorkflow, handleV2ContinueWorkflow } from '../../../src/mcp/handlers/v2-execution.js';
import { handleV2ResumeSession } from '../../../src/mcp/handlers/v2-resume.js';
import type { ToolContext } from '../../../src/mcp/types.js';
import { unwrapResponse } from '../../helpers/unwrap-response.js';
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
import { NodeHmacSha256V2 } from '../../../src/v2/infra/local/hmac-sha256/index.js';
import { NodeBase64UrlV2 } from '../../../src/v2/infra/local/base64url/index.js';
import { LocalKeyringV2 } from '../../../src/v2/infra/local/keyring/index.js';
import { NodeRandomEntropyV2 } from '../../../src/v2/infra/local/random-entropy/index.js';
import { NodeTimeClockV2 } from '../../../src/v2/infra/local/time-clock/index.js';
import { IdFactoryV2 } from '../../../src/v2/infra/local/id-factory/index.js';
import { Bech32mAdapterV2 } from '../../../src/v2/infra/local/bech32m/index.js';
import { Base32AdapterV2 } from '../../../src/v2/infra/local/base32/index.js';
import { LocalSessionSummaryProviderV2 } from '../../../src/v2/infra/local/session-summary-provider/index.js';
import { createTestValidationPipelineDeps } from '../../helpers/v2-test-helpers.js';

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-resume-e2e-'));
}

async function mkCtxWithWorkflow(workflowId: string): Promise<ToolContext> {
  const workflow = createWorkflow(
    {
      id: workflowId,
      name: 'Resume Test Workflow',
      description: 'Test workflow for resume → rehydrate flow',
      version: '0.1.0',
      steps: [
        {
          id: 'triage',
          title: 'Triage',
          prompt: 'Inspect the problem and summarize the key issue.',
        },
      ],
    } as any,
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

  const directoryListing = {
    readdir: (dirPath: string) => fsPort.readdir(dirPath),
    readdirWithMtime: (dirPath: string) => fsPort.readdirWithMtime(dirPath),
  };

  return {
    workflowService: {
      listWorkflowSummaries: async () => [],
      getWorkflowById: async (id: string) => (id === workflowId ? workflow : null),
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
      dataDir,
      directoryListing,
      sessionSummaryProvider: new LocalSessionSummaryProviderV2({
        directoryListing,
        dataDir,
        sessionStore,
        snapshotStore,
      }),
    },
  };
}

describe('resume → rehydrate end-to-end', () => {
  it('resume_session returns a candidate that rehydrates to the expected pending step', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;

    try {
      const workflowId = 'resume-e2e-workflow';
      const ctx = await mkCtxWithWorkflow(workflowId);

      const start = await handleV2StartWorkflow({ workflowId, workspacePath: root, goal: 'test workflow execution' } as any, ctx);
      expect(start.type).toBe('success');
      if (start.type !== 'success') return;

      const startResponse = unwrapResponse(start.data) as any;
      const firstRehydrate = await handleV2ContinueWorkflow({
        continueToken: startResponse.continueToken,
        intent: 'rehydrate',
        context: { goal: 'Resume the MR ownership task for this repo' },
      } as any, ctx);

      expect(firstRehydrate.type).toBe('success');
      if (firstRehydrate.type !== 'success') return;

      const resume = await handleV2ResumeSession({
        query: 'mr ownership task',
        sameWorkspaceOnly: true,
      } as any, ctx);

      expect(resume.type).toBe('success');
      if (resume.type !== 'success') return;

      const candidate = resume.data.candidates[0];
      expect(candidate).toBeDefined();
      expect(candidate!.confidence).toBeTruthy();
      expect(candidate!.matchExplanation).toBeTruthy();

      const resumed = await handleV2ContinueWorkflow(candidate!.nextCall.params as any, ctx);
      expect(resumed.type).toBe('success');
      if (resumed.type !== 'success') return;

      const resumedResponse = unwrapResponse(resumed.data) as any;
      expect(resumedResponse.pending?.stepId).toBe('triage');
      expect(resumedResponse.nextIntent).toBeTruthy();
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });
});
