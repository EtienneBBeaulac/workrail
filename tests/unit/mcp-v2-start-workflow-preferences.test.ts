import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { handleV2StartWorkflow } from '../../src/mcp/handlers/v2-execution.js';
import type { ToolContext } from '../../src/mcp/types.js';

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

import { parseTokenV1Binary, verifyTokenSignatureV1Binary, unsafeTokenCodecPorts } from '../../src/v2/durable-core/tokens/index.js';
import { NodeHmacSha256V2 } from '../../src/v2/infra/local/hmac-sha256/index.js';
import { NodeBase64UrlV2 } from '../../src/v2/infra/local/base64url/index.js';
import { LocalKeyringV2 } from '../../src/v2/infra/local/keyring/index.js';
import { NodeRandomEntropyV2 } from '../../src/v2/infra/local/random-entropy/index.js';
import { NodeTimeClockV2 } from '../../src/v2/infra/local/time-clock/index.js';
import { IdFactoryV2 } from '../../src/v2/infra/local/id-factory/index.js';
import { Bech32mAdapterV2 } from '../../src/v2/infra/local/bech32m/index.js';
import { Base32AdapterV2 } from '../../src/v2/infra/local/base32/index.js';

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-start-prefs-'));
}

async function mkCtxWithWorkflow(workflowId: string): Promise<ToolContext> {
  const wf = createWorkflow(
    {
      id: workflowId,
      name: 'Test Workflow',
      description: 'Test',
      version: '0.1.0',
      steps: [{ id: 'triage', title: 'Triage', prompt: 'Do triage' }],
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
    v2: { gate, sessionStore, snapshotStore, pinnedStore, sha256, crypto, idFactory, tokenCodecPorts },
  };
}

describe('v2 start_workflow emits baseline preferences_changed', () => {
  it('records a system baseline preferences_changed event at session start', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {
      const workflowId = 'test-workflow';
      const ctx = await mkCtxWithWorkflow(workflowId);

      const res = await handleV2StartWorkflow({ workflowId } as any, ctx);
      expect(res.type).toBe('success');
      if (res.type !== 'success') return;

      // Recover sessionId from stateToken.
      const parsed = parseTokenV1Binary(res.data.stateToken, {
        bech32m: new Bech32mAdapterV2(),
        base32: new Base32AdapterV2(),
      })._unsafeUnwrap();

      // Quick signature check (optional but cheap):
      verifyTokenSignatureV1Binary(parsed, (ctx.v2 as any).tokenCodecPorts)._unsafeUnwrap();

      const sessionId = (parsed.payload as any).sessionId as string;
      const truth = await (ctx.v2 as any).sessionStore.load(sessionId).match(
        (v: any) => v,
        (e: any) => {
          throw new Error(`session load failed: ${e.code}`);
        }
      );

      const prefEvents = truth.events.filter((e: any) => e.kind === 'preferences_changed');
      expect(prefEvents.length).toBe(1);
      expect(prefEvents[0].data.source).toBe('system');
      expect(prefEvents[0].data.effective.autonomy).toBe('guided');
      expect(prefEvents[0].data.effective.riskPolicy).toBe('conservative');
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });
});
