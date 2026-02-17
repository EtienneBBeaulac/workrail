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

import { unsafeTokenCodecPorts, parseTokenV1Binary } from '../../../src/v2/durable-core/tokens/index.js';
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
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-atomicity-'));
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
      idFactory,
      tokenCodecPorts,
      sessionEventLogStore: sessionStore,
    },
  };
}

describe('Blocked node atomicity (validation + node + edge atomic)', () => {
  afterEach(() => {
    delete process.env.WORKRAIL_DATA_DIR;
  });

  it('blocked advance creates validation event + node + edge atomically', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {
      const workflowId = 'atomicity-test';
      const ctx = await mkCtxWithWorkflow(workflowId, {
        id: workflowId,
        name: 'Atomicity test',
        description: 'Tests atomic append',
        version: '1.0.0',
        steps: [
          {
            id: 'step_validated',
            title: 'Validated step',
            prompt: 'Return "result".',
            validationCriteria: [{ type: 'contains', value: 'result', message: 'Must contain result' }],
          },
          { id: 'step_next', title: 'Next', prompt: 'Next' },
        ],
      });

      const startRes = await handleV2StartWorkflow({ workflowId } as V2StartWorkflowInput, ctx);
      expect(startRes.type).toBe('success');
      if (startRes.type !== 'success') return;

      // Advance with invalid output → should create validation + blocked node + edge
      const blockRes = await handleV2ContinueWorkflow(
        { stateToken: startRes.data.stateToken, ackToken: startRes.data.ackToken!, output: { notesMarkdown: 'invalid' } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(blockRes.type).toBe('success');
      if (blockRes.type !== 'success') return;
      expect(blockRes.data.kind).toBe('blocked');

      // Verify atomicity: validation event, node, and edge all present
      const sessionStore = ctx.v2!.sessionEventLogStore as any;
      const bech32m = new Bech32mAdapterV2();
      const base32 = new Base32AdapterV2();
      const parsedState = parseTokenV1Binary(startRes.data.stateToken, { bech32m, base32 })._unsafeUnwrap();
      const sessionId = asSessionId(parsedState.payload.sessionId);
      const loadRes = await sessionStore.load(sessionId);
      if (loadRes.isErr()) throw new Error(`Unexpected load error: ${loadRes.error.code}`);
      const truth = loadRes.value;

      const validationEvents = truth.events.filter((e) => e.kind === 'validation_performed');
      const blockedNodes = truth.events.filter((e) => e.kind === 'node_created' && e.data.nodeKind === 'blocked_attempt');
      const edgesToBlocked = truth.events.filter(
        (e) => e.kind === 'edge_created' && e.data.toNodeId === blockedNodes[0]?.scope.nodeId
      );

      // All three events must exist
      expect(validationEvents.length).toBe(1);
      expect(blockedNodes.length).toBe(1);
      expect(edgesToBlocked.length).toBe(1);

      // Ordering: validation < node < edge (or validation < edge < node, both valid)
      const valIdx = validationEvents[0]!.eventIndex;
      const nodeIdx = blockedNodes[0]!.eventIndex;
      const edgeIdx = edgesToBlocked[0]!.eventIndex;

      expect(valIdx).toBeLessThan(nodeIdx);
      expect(valIdx).toBeLessThan(edgeIdx);

      // Verify session health remains healthy (if health tracking exists)
      if (truth.health) {
        expect(truth.health.kind).toBe('healthy');
      }
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });

  it('successful retry creates validation event + node + edge atomically', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {
      const workflowId = 'retry-atomicity-test';
      const ctx = await mkCtxWithWorkflow(workflowId, {
        id: workflowId,
        name: 'Retry atomicity test',
        description: 'Tests atomic retry',
        version: '1.0.0',
        steps: [
          {
            id: 'step_val',
            title: 'Val',
            prompt: 'Return "done".',
            validationCriteria: [{ type: 'contains', value: 'done', message: 'Must contain done' }],
          },
          { id: 'step_next', title: 'Next', prompt: 'Next' },
        ],
      });

      const startRes = await handleV2StartWorkflow({ workflowId } as V2StartWorkflowInput, ctx);
      expect(startRes.type).toBe('success');
      if (startRes.type !== 'success') return;

      // Block
      const blockRes = await handleV2ContinueWorkflow(
        { stateToken: startRes.data.stateToken, ackToken: startRes.data.ackToken!, output: { notesMarkdown: 'bad' } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(blockRes.type).toBe('success');
      if (blockRes.type !== 'success') return;
      expect(blockRes.data.kind).toBe('blocked');
      if (blockRes.data.kind !== 'blocked') return;

      const retryToken = blockRes.data.retryAckToken!;

      // Retry successfully
      const retryRes = await handleV2ContinueWorkflow(
        { stateToken: blockRes.data.stateToken, ackToken: retryToken, output: { notesMarkdown: 'done' } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(retryRes.type).toBe('success');
      if (retryRes.type !== 'success') return;
      expect(retryRes.data.kind).toBe('ok');

      // Verify atomicity: validation event (for retry) + step node + edge all present
      const sessionStore = ctx.v2!.sessionEventLogStore as any;
      const bech32m = new Bech32mAdapterV2();
      const base32 = new Base32AdapterV2();
      const parsedState = parseTokenV1Binary(startRes.data.stateToken, { bech32m, base32 })._unsafeUnwrap();
      const sessionId = asSessionId(parsedState.payload.sessionId);
      const loadRes = await sessionStore.load(sessionId);
      if (loadRes.isErr()) throw new Error(`Unexpected load error: ${loadRes.error.code}`);
      const truth = loadRes.value;

      const validationEvents = truth.events.filter((e) => e.kind === 'validation_performed');
      const stepNodes = truth.events.filter((e) => e.kind === 'node_created' && e.data.nodeKind === 'step');
      const blockedNodes = truth.events.filter((e) => e.kind === 'node_created' && e.data.nodeKind === 'blocked_attempt');

      // Should have 2 validation events (block + retry)
      expect(validationEvents.length).toBe(2);
      // Should have root step + advanced step (not duplicate)
      expect(stepNodes.length).toBe(2);
      // Should have 1 blocked node
      expect(blockedNodes.length).toBe(1);

      // Verify edge from blocked to step exists
      const edgesFromBlocked = truth.events.filter(
        (e) => e.kind === 'edge_created' && e.data.fromNodeId === blockedNodes[0]!.scope.nodeId
      );
      expect(edgesFromBlocked.length).toBe(1);
      expect(edgesFromBlocked[0]!.data.toNodeId).toBe(stepNodes[1]!.scope.nodeId);

      // Verify session health = healthy (if health tracking exists)
      if (truth.health) {
        expect(truth.health.kind).toBe('healthy');
      }
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });

  it('no partial state visible: events appear atomically', async () => {
    const root = await mkTempDataDir();
    const prev = process.env.WORKRAIL_DATA_DIR;
    process.env.WORKRAIL_DATA_DIR = root;
    try {
      const workflowId = 'visibility-test';
      const ctx = await mkCtxWithWorkflow(workflowId, {
        id: workflowId,
        name: 'Visibility test',
        description: 'Tests atomic visibility',
        version: '1.0.0',
        steps: [
          {
            id: 'step1',
            title: 'Step 1',
            prompt: 'Return "pass".',
            validationCriteria: [{ type: 'contains', value: 'pass', message: 'Must contain pass' }],
          },
          { id: 'step2', title: 'Step 2', prompt: 'Step 2' },
        ],
      });

      const startRes = await handleV2StartWorkflow({ workflowId } as V2StartWorkflowInput, ctx);
      expect(startRes.type).toBe('success');
      if (startRes.type !== 'success') return;

      // Block
      const blockRes = await handleV2ContinueWorkflow(
        { stateToken: startRes.data.stateToken, ackToken: startRes.data.ackToken!, output: { notesMarkdown: 'fail' } } as V2ContinueWorkflowInput,
        ctx
      );
      expect(blockRes.type).toBe('success');
      if (blockRes.type !== 'success') return;

      // Load events and verify: either all present or none (no partial state)
      const sessionStore = ctx.v2!.sessionEventLogStore as any;
      const bech32m = new Bech32mAdapterV2();
      const base32 = new Base32AdapterV2();
      const parsedState = parseTokenV1Binary(startRes.data.stateToken, { bech32m, base32 })._unsafeUnwrap();
      const sessionId = asSessionId(parsedState.payload.sessionId);
      const loadRes = await sessionStore.load(sessionId);
      if (loadRes.isErr()) throw new Error(`Unexpected load error: ${loadRes.error.code}`);
      const truth = loadRes.value;

      const validationEvents = truth.events.filter((e) => e.kind === 'validation_performed');
      const blockedNodes = truth.events.filter((e) => e.kind === 'node_created' && e.data.nodeKind === 'blocked_attempt');
      const edges = truth.events.filter((e) => e.kind === 'edge_created');

      // If blocked node exists, validation event must exist (atomicity)
      if (blockedNodes.length > 0) {
        expect(validationEvents.length).toBeGreaterThan(0);
        // Edge to blocked node must exist
        const edgesToBlocked = edges.filter((e) => e.data.toNodeId === blockedNodes[0]!.scope.nodeId);
        expect(edgesToBlocked.length).toBe(1);
      }

      // If validation event exists without blocked node, it's a partial write (should never happen)
      if (validationEvents.length > 0 && blockedNodes.length === 0) {
        throw new Error('ATOMICITY VIOLATION: validation_performed exists without blocked_attempt node');
      }
    } finally {
      process.env.WORKRAIL_DATA_DIR = prev;
    }
  });
});
