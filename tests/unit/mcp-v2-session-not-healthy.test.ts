import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { handleV2ContinueWorkflow, handleV2StartWorkflow } from '../../src/mcp/handlers/v2-execution.js';
import type { ToolContext } from '../../src/mcp/types.js';
import type { SessionHealthDetails } from '../../src/mcp/types.js';

import { createWorkflow } from '../../src/types/workflow.js';
import { createProjectDirectorySource } from '../../src/types/workflow-source.js';

import { parseTokenV1Binary, unsafeTokenCodecPorts } from '../../src/v2/durable-core/tokens/index.js';
import { LocalDataDirV2 } from '../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../src/v2/infra/local/fs/index.js';
import { NodeSha256V2 } from '../../src/v2/infra/local/sha256/index.js';
import { LocalSessionEventLogStoreV2 } from '../../src/v2/infra/local/session-store/index.js';
import { NodeCryptoV2 } from '../../src/v2/infra/local/crypto/index.js';
import { NodeHmacSha256V2 } from '../../src/v2/infra/local/hmac-sha256/index.js';
import { NodeBase64UrlV2 } from '../../src/v2/infra/local/base64url/index.js';
import { LocalSessionLockV2 } from '../../src/v2/infra/local/session-lock/index.js';
import { LocalSnapshotStoreV2 } from '../../src/v2/infra/local/snapshot-store/index.js';
import { LocalPinnedWorkflowStoreV2 } from '../../src/v2/infra/local/pinned-workflow-store/index.js';
import { ExecutionSessionGateV2 } from '../../src/v2/usecases/execution-session-gate.js';
import { LocalKeyringV2 } from '../../src/v2/infra/local/keyring/index.js';
import { NodeRandomEntropyV2 } from '../../src/v2/infra/local/random-entropy/index.js';
import { NodeTimeClockV2 } from '../../src/v2/infra/local/time-clock/index.js';
import { IdFactoryV2 } from '../../src/v2/infra/local/id-factory/index.js';
import { Bech32mAdapterV2 } from '../../src/v2/infra/local/bech32m/index.js';
import { Base32AdapterV2 } from '../../src/v2/infra/local/base32/index.js';

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-health-'));
}

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
  return { gate, sessionStore, snapshotStore, pinnedStore, keyring, sha256, crypto, idFactory, tokenCodecPorts, hmac, base64url, base32, bech32m };
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

  const v2 = await mkV2Deps();

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
    v2,
  };
}

describe('v2 execution: SESSION_NOT_HEALTHY error response', () => {
  it('returns SESSION_NOT_HEALTHY with proper MCP envelope when session manifest is corrupted', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {
      const workflowId = 'test-workflow';
      const ctx = await mkCtxWithWorkflow(workflowId);

      // Create a healthy session initially
      const started = await handleV2StartWorkflow({ workflowId } as any, ctx);
      expect(started.type).toBe('success');
      if (started.type !== 'success') return;

      const stateToken = started.data.stateToken;
      const parsedState = parseTokenV1Binary(stateToken, { bech32m: new Bech32mAdapterV2(), base32: new (await import('../../src/v2/infra/local/base32/index.js')).Base32AdapterV2() })._unsafeUnwrap();
      const sessionId = parsedState.payload.sessionId;

      // Corrupt the session manifest file by truncating it
      const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
      const manifestPath = dataDir.sessionManifestPath(sessionId);
      
      // Truncate the file to make it invalid JSON
      const fd = await fs.open(manifestPath, 'w');
      await fd.truncate(5); // Truncate to 5 bytes, rendering it invalid JSON
      await fd.close();

      // Try to load the session - should fail with SESSION_NOT_HEALTHY
      const result = await handleV2ContinueWorkflow({ intent: 'rehydrate', stateToken } as any, ctx);

      // Assert: error response
      expect(result.type).toBe('error');
      if (result.type !== 'error') return;

      // Assert: exact error code
      expect(result.code).toBe('SESSION_NOT_HEALTHY');

      // Assert: not retryable
      expect(result.retry.kind).toBe('not_retryable');

      // Assert: details contain health information with proper structure
      expect(result.details).toBeDefined();
      const envelope = result.details as any;
      expect(envelope.suggestion).toBeTruthy();
      // Verify the suggestion is agent-actionable (tells agent what to do)
      expect(envelope.suggestion).toContain('start_workflow');
      expect(envelope.details).toBeDefined();
      
      const details = envelope.details as SessionHealthDetails;
      expect(details).toHaveProperty('health');
      expect(details.health).toHaveProperty('kind');
      expect(['corrupt_tail', 'corrupt_head', 'unknown_version']).toContain(details.health.kind);
      
      // Assert: reason is populated
      expect(details.health).toHaveProperty('reason');
      if (details.health.reason) {
        expect(details.health.reason).toHaveProperty('code');
        expect(details.health.reason).toHaveProperty('message');
        expect(typeof details.health.reason.code).toBe('string');
        expect(typeof details.health.reason.message).toBe('string');
      }

      // Assert: message exists
      expect(result.message).toBeTruthy();
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });

  it('SESSION_NOT_HEALTHY uses correct type-safe health discriminators', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {
      const workflowId = 'test-workflow';
      const ctx = await mkCtxWithWorkflow(workflowId);

      // Create and corrupt session
      const started = await handleV2StartWorkflow({ workflowId } as any, ctx);
      expect(started.type).toBe('success');
      if (started.type !== 'success') return;

      const stateToken = started.data.stateToken;
      const parsedState = parseTokenV1Binary(stateToken, { bech32m: new Bech32mAdapterV2(), base32: new (await import('../../src/v2/infra/local/base32/index.js')).Base32AdapterV2() })._unsafeUnwrap();
      const sessionId = parsedState.payload.sessionId;

      // Corrupt manifest
      const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: root });
      const manifestPath = dataDir.sessionManifestPath(sessionId);
      const fd = await fs.open(manifestPath, 'w');
      await fd.truncate(3);
      await fd.close();

      // Get error
      const result = await handleV2ContinueWorkflow({ intent: 'rehydrate', stateToken } as any, ctx);
      expect(result.type).toBe('error');
      if (result.type !== 'error') return;

      const details = result.details as SessionHealthDetails;
      
      // Type assertion: health.kind must be one of the valid discriminators
      const validKinds: readonly string[] = ['corrupt_tail', 'corrupt_head', 'unknown_version'];
      expect(validKinds).toContain(details.details.health.kind);
      
      // Verify reason structure is present and valid
      if (details.details.health.reason) {
        const reason = details.details.health.reason;
        expect(typeof reason.code).toBe('string');
        expect(typeof reason.message).toBe('string');
        expect(reason.code.length).toBeGreaterThan(0);
        expect(reason.message.length).toBeGreaterThan(0);
      }
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });
});
