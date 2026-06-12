import { createTestValidationPipelineDeps } from '../../helpers/v2-test-helpers.js';
import 'reflect-metadata';
import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

import { executeStartWorkflow } from '../../../src/mcp/handlers/v2-execution/start.js';
import { signEAT } from '../../../src/v2/durable-core/tokens/index.js';
import { parseContinueTokenOrFail } from '../../../src/mcp/handlers/v2-token-ops.js';
import { NullGitSnapshotV2 } from '../../../src/v2/ports/git-snapshot.port.js';
import type { ToolContext } from '../../../src/mcp/types.js';
import type { V2StartWorkflowInput } from '../../../src/mcp/v2/tools.js';

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

async function mkTempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workrail-v2-start-'));
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

describe('v2 startup sniffing & Environment Attestation Tokens', () => {
  const workflowId = 'sniff-test';
  const workflowDef = {
    id: workflowId,
    name: 'Sniff Test',
    description: 'Tests environmental sniffing and EAT verification',
    version: '1.0.0',
    steps: [
      { id: 'step-1', title: 'Step 1', prompt: 'First prompt' }
    ],
  };

  const oldEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...oldEnv };
  });

  it('sniffs Cursor environment via WORKRAIL_FORCE_HARNESS', async () => {
    const root = await mkTempDataDir();
    process.env.WORKRAIL_DATA_DIR = root;
    process.env.WORKRAIL_FORCE_HARNESS = 'cursor';
    process.env.WORKRAIL_FORCE_MODEL = 'custom-gpt4';

    try {
      const ctx = await mkCtxWithWorkflow(workflowId, workflowDef);
      const startRes = await executeStartWorkflow(
        { workflowId, workspacePath: root, goal: 'sniff harness' } as V2StartWorkflowInput,
        ctx
      );

      expect(startRes.isOk()).toBe(true);
      if (!startRes.isOk()) return;

      const sessionId = startRes.value.sessionId;
      const loadRes = await ctx.v2.sessionStore.load(sessionId);
      expect(loadRes.isOk()).toBe(true);
      if (!loadRes.isOk()) return;

      const events = loadRes.value.events;
      const contextSetEvent = events.find(e => e.kind === 'context_set');
      expect(contextSetEvent).toBeDefined();

      const contextData = (contextSetEvent as any).data.context;
      expect(contextData.metrics_harness).toBe('cursor');
      expect(contextData.metrics_active_model).toBe('custom-gpt4');
      expect(contextData.eat_token).toBeDefined();

      const eatObj = JSON.parse(contextData.eat_token);
      expect(eatObj.payload.harness).toBe('cursor');
      expect(eatObj.payload.activeModel).toBe('custom-gpt4');
      expect(eatObj.payload.spawnDepth).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('verifies parent EAT and increments spawnDepth correctly', async () => {
    const root = await mkTempDataDir();
    process.env.WORKRAIL_DATA_DIR = root;

    try {
      const ctx = await mkCtxWithWorkflow(workflowId, workflowDef);

      const parentEatPayload = {
        harness: 'claude_code' as const,
        activeModel: 'claude-3-5-sonnet',
        parentSessionId: 'sess_parent123',
        spawnDepth: 1,
        sessionId: 'sess_parent123',
      };

      const parentEatSignature = signEAT(parentEatPayload, ctx.v2.tokenCodecPorts);
      expect(parentEatSignature).not.toBeNull();

      const parentEatTokenJson = JSON.stringify({
        payload: parentEatPayload,
        signature: parentEatSignature,
      });

      const startRes = await executeStartWorkflow(
        { workflowId, workspacePath: root, goal: 'sniff child' } as V2StartWorkflowInput,
        ctx,
        { parent_eat_token: parentEatTokenJson, parentSessionId: 'sess_parent123' }
      );

      expect(startRes.isOk()).toBe(true);
      if (!startRes.isOk()) return;

      const sessionId = startRes.value.sessionId;
      const loadRes = await ctx.v2.sessionStore.load(sessionId);
      const contextSetEvent = loadRes._unsafeUnwrap().events.find(e => e.kind === 'context_set');
      const contextData = (contextSetEvent as any).data.context;

      const eatObj = JSON.parse(contextData.eat_token);
      expect(eatObj.payload.spawnDepth).toBe(2);
      expect(eatObj.payload.parentSessionId).toBe('sess_parent123');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects start_workflow if spawn depth exceeds 3', async () => {
    const root = await mkTempDataDir();
    process.env.WORKRAIL_DATA_DIR = root;

    try {
      const ctx = await mkCtxWithWorkflow(workflowId, workflowDef);

      const parentEatPayload = {
        harness: 'daemon' as const,
        activeModel: 'claude-3-5-haiku',
        parentSessionId: 'sess_parent123',
        spawnDepth: 3, // depth + 1 = 4, which exceeds 3!
      };

      const parentEatSignature = signEAT(parentEatPayload, ctx.v2.tokenCodecPorts);
      const parentEatTokenJson = JSON.stringify({
        payload: parentEatPayload,
        signature: parentEatSignature,
      });

      const startRes = await executeStartWorkflow(
        { workflowId, workspacePath: root, goal: 'exceed depth' } as V2StartWorkflowInput,
        ctx,
        { parent_eat_token: parentEatTokenJson }
      );

      expect(startRes.isErr()).toBe(true);
      if (!startRes.isErr()) return;
      expect((startRes.error as any).kind).toBe('precondition_failed');
      expect((startRes.error as any).message).toContain('Spawn depth limit exceeded');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects start_workflow if parent EAT signature is invalid', async () => {
    const root = await mkTempDataDir();
    process.env.WORKRAIL_DATA_DIR = root;

    try {
      const ctx = await mkCtxWithWorkflow(workflowId, workflowDef);

      const parentEatPayload = {
        harness: 'daemon' as const,
        activeModel: 'claude-3-5-haiku',
        parentSessionId: 'sess_parent123',
        spawnDepth: 1,
      };

      const parentEatTokenJson = JSON.stringify({
        payload: parentEatPayload,
        signature: 'invalid_signature_hex_or_base64url',
      });

      const startRes = await executeStartWorkflow(
        { workflowId, workspacePath: root, goal: 'invalid sig' } as V2StartWorkflowInput,
        ctx,
        { parent_eat_token: parentEatTokenJson }
      );

      expect(startRes.isErr()).toBe(true);
      if (!startRes.isErr()) return;
      expect((startRes.error as any).kind).toBe('precondition_failed');
      expect((startRes.error as any).message).toContain('signature verification failed');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('refreshes EAT token when host environment drifts on continue_workflow advance', async () => {
    const root = await mkTempDataDir();
    process.env.WORKRAIL_DATA_DIR = root;
    process.env.WORKRAIL_FORCE_HARNESS = 'cursor';
    process.env.WORKRAIL_FORCE_MODEL = 'custom-gpt4';

    try {
      const ctx = await mkCtxWithWorkflow(workflowId, workflowDef);

      // Start workflow under Cursor
      const startRes = await executeStartWorkflow(
        { workflowId, workspacePath: root, goal: 'drift test' } as V2StartWorkflowInput,
        ctx
      );
      expect(startRes.isOk()).toBe(true);
      const startVal = startRes._unsafeUnwrap();
      const continueToken = startVal.response.continueToken;
      const sessionId = startVal.sessionId;

      // Change environment to Claude Code
      process.env.WORKRAIL_FORCE_HARNESS = 'claude_code';
      process.env.WORKRAIL_FORCE_MODEL = 'claude-3-5-sonnet';

      // Call handleAdvanceIntent (continue_workflow with intent: advance)
      const { handleAdvanceIntent } = await import('../../../src/mcp/handlers/v2-execution/continue-advance.js');
      const loadRes = await ctx.v2.sessionStore.load(sessionId);
      expect(loadRes.isOk()).toBe(true);

      const decoded = await parseContinueTokenOrFail(
        continueToken,
        ctx.v2.tokenCodecPorts,
        ctx.v2.tokenAliasStore
      );
      expect(decoded.isOk()).toBe(true);
      const workflowHashRef = decoded._unsafeUnwrap().workflowHashRef;

      const advanceRes = await handleAdvanceIntent({
        input: { continueToken, intent: 'advance', workspacePath: root, output: { notesMarkdown: 'Step 1 notes.' } },
        sessionId,
        runId: loadRes._unsafeUnwrap().events.find(e => e.kind === 'run_started')!.scope!.runId as any,
        nodeId: loadRes._unsafeUnwrap().events.find(e => e.kind === 'node_created')!.scope!.nodeId as any,
        attemptId: 'att_123' as any,
        workflowHashRef,
        truth: loadRes._unsafeUnwrap(),
        gate: ctx.v2.gate,
        sessionStore: ctx.v2.sessionStore,
        snapshotStore: ctx.v2.snapshotStore,
        pinnedStore: ctx.v2.pinnedStore,
        tokenCodecPorts: ctx.v2.tokenCodecPorts,
        idFactory: ctx.v2.idFactory,
        sha256: ctx.v2.sha256,
        gitSnapshot: new NullGitSnapshotV2(),
        aliasStore: ctx.v2.tokenAliasStore,
        entropy: ctx.v2.entropy,
      });

      expect(advanceRes.isOk()).toBe(true);

      // Verify that the reloaded event log has a new CONTEXT_SET event with refreshed eat_token!
      const loadRes2 = await ctx.v2.sessionStore.load(sessionId);
      const events = loadRes2._unsafeUnwrap().events;
      
      // Look for a context_set event that came from 'agent_delta'
      const systemContextEvents = events.filter(e => e.kind === 'context_set' && (e as any).data?.source === 'agent_delta' && (e as any).data?.context?.['metrics_harness'] === 'claude_code');
      expect(systemContextEvents.length).toBeGreaterThanOrEqual(1);

      const refreshedContext = (systemContextEvents[0] as any).data.context;
      expect(refreshedContext.metrics_harness).toBe('claude_code');
      expect(refreshedContext.metrics_active_model).toBe('claude-3-5-sonnet');
      expect(refreshedContext.eat_token).toBeDefined();

      const refreshedEat = JSON.parse(refreshedContext.eat_token);
      expect(refreshedEat.payload.harness).toBe('claude_code');
      expect(refreshedEat.payload.activeModel).toBe('claude-3-5-sonnet');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('spawn_agent accepts custom model overrides and propagates EAT token down the spawn chain', async () => {
    const root = await mkTempDataDir();
    process.env.WORKRAIL_DATA_DIR = root;
    process.env.WORKRAIL_FORCE_HARNESS = 'daemon';
    delete process.env.WORKRAIL_FORCE_MODEL;

    try {
      const ctx = await mkCtxWithWorkflow(workflowId, workflowDef);

      // Start parent workflow
      const startRes = await executeStartWorkflow(
        { workflowId, workspacePath: root, goal: 'parent goal' } as V2StartWorkflowInput,
        ctx
      );
      expect(startRes.isOk()).toBe(true);
      const parentSessionId = startRes.value.sessionId;

      // Construct spawn_agent tool call params with custom model override
      const { makeSpawnAgentTool } = await import('../../../src/daemon/tools/spawn-agent.js');
      const tool = makeSpawnAgentTool(
        'run_parent123' as any,
        ctx,
        'mock-api-key',
        String(parentSessionId),
        0,
        3,
        async () => ({ _tag: 'success' as const, lastStepNotes: 'Child succeeded!' }), // mock runWorkflow Fn
        { SpawnAgentParams: {} }
      );

      const result = await tool.execute('tool_call_123', {
        workflowId,
        goal: 'child goal',
        workspacePath: root,
        agentConfig: {
          model: 'claude-3-5-sonnet',
        },
      }, new AbortController().signal);

      // Since we mocked runWorkflowFn to succeed immediately, let's verify that the tool succeeded
      expect(result.details).toBeDefined();
      const details = result.details as any;
      expect(details.outcome).toBe('success');
      expect(details.notes).toBe('Child succeeded!');
      expect(details.childSessionId).not.toBeNull();
      const childSessionId = details.childSessionId;

      // Load child session state and assert its context has propagated eat_token, harness, and model override!
      const childLoad = await ctx.v2.sessionStore.load(childSessionId);
      expect(childLoad.isOk()).toBe(true);
      const childEvents = childLoad._unsafeUnwrap().events;
      const childContextSet = childEvents.find(e => e.kind === 'context_set');
      expect(childContextSet).toBeDefined();

      const childContext = (childContextSet as any).data.context;
      expect(childContext.metrics_harness).toBe('daemon');
      expect(childContext.metrics_active_model).toBe('claude-3-5-sonnet'); // custom model override!
      expect(childContext.eat_token).toBeDefined();

      const childEatObj = JSON.parse(childContext.eat_token);
      expect(childEatObj.payload.spawnDepth).toBe(1); // incremented from parent spawn depth (0)
      expect(childEatObj.payload.activeModel).toBe('claude-3-5-sonnet');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('spawn_agent throws a hard reject if spawn depth exceeds max depth', async () => {
    const root = await mkTempDataDir();
    process.env.WORKRAIL_DATA_DIR = root;

    try {
      const ctx = await mkCtxWithWorkflow(workflowId, workflowDef);

      // Start parent workflow
      const startRes = await executeStartWorkflow(
        { workflowId, workspacePath: root, goal: 'parent goal' } as V2StartWorkflowInput,
        ctx
      );
      expect(startRes.isOk()).toBe(true);
      const parentSessionId = startRes.value.sessionId;

      const { makeSpawnAgentTool } = await import('../../../src/daemon/tools/spawn-agent.js');
      // Create spawn_agent tool at currentDepth=3, maxDepth=3
      const tool = makeSpawnAgentTool(
        'run_parent123' as any,
        ctx,
        'mock-api-key',
        String(parentSessionId),
        3,
        3,
        async () => ({ _tag: 'success' as const, lastStepNotes: 'Child succeeded!' }),
        { SpawnAgentParams: {} }
      );

      const result = await tool.execute('tool_call_123', {
        workflowId,
        goal: 'child goal',
        workspacePath: root,
      }, new AbortController().signal);

      expect(result.details).toBeDefined();
      const details = result.details as any;
      expect(details.outcome).toBe('error');
      expect(details.notes).toContain('Max spawn depth exceeded');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('resolves activeModel based on modelTier hierarchy', async () => {
    const root = await mkTempDataDir();
    process.env.WORKRAIL_DATA_DIR = root;

    const tierWorkflowDef = {
      ...workflowDef,
      modelTier: 'heavy',
    };

    try {
      const ctx = await mkCtxWithWorkflow(workflowId, tierWorkflowDef);

      // Start workflow without passing modelTier override
      const startRes = await executeStartWorkflow(
        { workflowId, workspacePath: root, goal: 'test goal' } as V2StartWorkflowInput,
        ctx
      );
      expect(startRes.isOk()).toBe(true);
      const sessionId = startRes.value.sessionId;

      const loaded = await ctx.v2.sessionStore.load(sessionId);
      expect(loaded.isOk()).toBe(true);
      const events = loaded._unsafeUnwrap().events;
      const contextSet = events.find(e => e.kind === 'context_set');
      expect(contextSet).toBeDefined();

      const context = (contextSet as any).data.context;
      expect(context.metrics_active_model).toBe('claude-3-opus-latest');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('allows modelTier override in start input', async () => {
    const root = await mkTempDataDir();
    process.env.WORKRAIL_DATA_DIR = root;

    const tierWorkflowDef = {
      ...workflowDef,
      modelTier: 'heavy',
    };

    try {
      const ctx = await mkCtxWithWorkflow(workflowId, tierWorkflowDef);

      // Start workflow passing lightweight override
      const startRes = await executeStartWorkflow(
        { workflowId, workspacePath: root, goal: 'test goal', modelTier: 'lightweight' } as V2StartWorkflowInput,
        ctx
      );
      expect(startRes.isOk()).toBe(true);
      const sessionId = startRes.value.sessionId;

      const loaded = await ctx.v2.sessionStore.load(sessionId);
      expect(loaded.isOk()).toBe(true);
      const events = loaded._unsafeUnwrap().events;
      const contextSet = events.find(e => e.kind === 'context_set');
      expect(contextSet).toBeDefined();

      const context = (contextSet as any).data.context;
      expect(context.metrics_active_model).toBe('claude-3-5-haiku-latest');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
