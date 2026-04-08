import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { okAsync } from 'neverthrow';
import { handleV2ListWorkflows } from '../../src/mcp/handlers/v2-workflow.js';
import { handleV2InspectWorkflow } from '../../src/mcp/handlers/v2-workflow.js';
import { handleV2StartWorkflow } from '../../src/mcp/handlers/v2-execution.js';
import { handleV2ResumeSession } from '../../src/mcp/handlers/v2-resume.js';
import type { ToolContext } from '../../src/mcp/types.js';
import { EnvironmentFeatureFlagProvider } from '../../src/config/feature-flags.js';
import { createTestValidationPipelineDeps } from '../helpers/v2-test-helpers.js';
import { createWorkflow } from '../../src/types/workflow.js';
import { createProjectDirectorySource } from '../../src/types/workflow-source.js';
import { LocalDataDirV2 } from '../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../src/v2/infra/local/fs/index.js';
import { NodeSha256V2 } from '../../src/v2/infra/local/sha256/index.js';
import { NodeCryptoV2 } from '../../src/v2/infra/local/crypto/index.js';
import { LocalSessionEventLogStoreV2 } from '../../src/v2/infra/local/session-store/index.js';
import { LocalSessionLockV2 } from '../../src/v2/infra/local/session-lock/index.js';
import { LocalSnapshotStoreV2 } from '../../src/v2/infra/local/snapshot-store/index.js';
import { LocalPinnedWorkflowStoreV2 } from '../../src/v2/infra/local/pinned-workflow-store/index.js';
import { LocalKeyringV2 } from '../../src/v2/infra/local/keyring/index.js';
import { LocalRememberedRootsStoreV2 } from '../../src/v2/infra/local/remembered-roots-store/index.js';
import { ExecutionSessionGateV2 } from '../../src/v2/usecases/execution-session-gate.js';
import { unsafeTokenCodecPorts } from '../../src/v2/durable-core/tokens/index.js';
import { InMemoryTokenAliasStoreV2 } from '../../src/v2/infra/in-memory/token-alias-store/index.js';
import { NodeHmacSha256V2 } from '../../src/v2/infra/local/hmac-sha256/index.js';
import { NodeBase64UrlV2 } from '../../src/v2/infra/local/base64url/index.js';
import { NodeRandomEntropyV2 } from '../../src/v2/infra/local/random-entropy/index.js';
import { NodeTimeClockV2 } from '../../src/v2/infra/local/time-clock/index.js';
import { IdFactoryV2 } from '../../src/v2/infra/local/id-factory/index.js';
import { Bech32mAdapterV2 } from '../../src/v2/infra/local/bech32m/index.js';
import { Base32AdapterV2 } from '../../src/v2/infra/local/base32/index.js';
import type { SessionSummaryProviderPortV2 } from '../../src/v2/ports/session-summary-provider.port.js';

async function mkTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function buildCtx(dataRoot: string, workflowRoot?: string): Promise<{
  readonly ctx: ToolContext;
  readonly rememberedRootsStore: LocalRememberedRootsStoreV2;
}> {
  const dataDir = new LocalDataDirV2({ WORKRAIL_DATA_DIR: dataRoot });
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

  const rememberedRootsStore = new LocalRememberedRootsStoreV2(dataDir, fsPort, clock);
  const sessionSummaryProvider: SessionSummaryProviderPortV2 = {
    loadHealthySummaries: () => okAsync([]),
  };
  const workflow = workflowRoot
    ? createWorkflow(
        {
          id: 'test-workflow',
          name: 'Test Workflow',
          description: 'Test workflow',
          version: '0.1.0',
          steps: [{ id: 'triage', title: 'Triage', prompt: 'Do triage' }],
        } as any,
        createProjectDirectorySource(path.join(workflowRoot, 'workflows'))
      )
    : null;

  const tokenCodecPorts = unsafeTokenCodecPorts({
    keyring: keyringRes.value,
    hmac,
    base64url,
    base32,
    bech32m,
  });

  const ctx: ToolContext = {
    workflowService: {
      listWorkflowSummaries: async () => (workflow ? [workflow.toSummary()] : []),
      getWorkflowById: async (id: string) => (workflow && id === workflow.id ? workflow : null),
      getNextStep: async () => { throw new Error('not used'); },
      validateStepOutput: async () => ({ valid: true, issues: [], suggestions: [] }),
    } as any,
    featureFlags: EnvironmentFeatureFlagProvider.withEnv({}),
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
      rememberedRootsStore,
      sessionSummaryProvider,
      validationPipelineDeps: createTestValidationPipelineDeps(),
      resolvedRootUris: [],
    },
  };

  return { ctx, rememberedRootsStore };
}

async function writeWorkspaceWorkflow(workspaceRoot: string): Promise<void> {
  const workflowsDir = path.join(workspaceRoot, 'workflows');
  await fs.mkdir(workflowsDir, { recursive: true });
  await fs.writeFile(
    path.join(workflowsDir, 'test-workflow.v2.json'),
    JSON.stringify({
      id: 'test-workflow',
      name: 'Test Workflow',
      description: 'Test workflow',
      version: '0.1.0',
      steps: [{ id: 'triage', title: 'Triage', prompt: 'Do triage' }],
    }, null, 2),
    'utf8',
  );
}

describe('stale remembered roots in tool responses', () => {
  it('list_workflows suppresses staleRoots in tagSummary (compact) mode, surfaces them in filtered mode', async () => {
    const dataRoot = await mkTempDir('workrail-stale-list-data-');
    const workspaceRoot = await mkTempDir('workrail-stale-list-ws-');
    const { ctx, rememberedRootsStore } = await buildCtx(dataRoot);

    const stalePath = path.join(os.tmpdir(), `wr-stale-${Date.now()}`); // never created
    const rememberRes = await rememberedRootsStore.rememberRoot(stalePath);
    expect(rememberRes.isOk()).toBe(true);

    // No tags filter → tagSummary mode. staleRoots suppressed (noise for tag discovery).
    const compactResult = await handleV2ListWorkflows({ workspacePath: workspaceRoot }, ctx);
    expect(compactResult.type).toBe('success');
    const compactData = compactResult.data as Record<string, unknown>;
    expect(compactData.staleRoots).toBeUndefined();
    expect(Array.isArray(compactData.tagSummary)).toBe(true);

    // tags filter → filtered mode. staleRoots surfaced so agent knows why workflows may be missing.
    const filteredResult = await handleV2ListWorkflows({ workspacePath: workspaceRoot, tags: ['coding'] }, ctx);
    expect(filteredResult.type).toBe('success');
    const filteredData = filteredResult.data as Record<string, unknown>;
    expect(Array.isArray(filteredData.staleRoots)).toBe(true);
    expect(filteredData.staleRoots as string[]).toContain(path.resolve(stalePath));
  });

  it('list_workflows does not include staleRoots when all remembered roots are accessible', async () => {
    const dataRoot = await mkTempDir('workrail-nostale-list-data-');
    const workspaceRoot = await mkTempDir('workrail-nostale-list-ws-');
    const validRoot = await mkTempDir('workrail-nostale-list-root-');
    const { ctx, rememberedRootsStore } = await buildCtx(dataRoot);

    const rememberRes = await rememberedRootsStore.rememberRoot(validRoot);
    expect(rememberRes.isOk()).toBe(true);

    const result = await handleV2ListWorkflows({ workspacePath: workspaceRoot }, ctx);

    expect(result.type).toBe('success');
    const data = result.data as Record<string, unknown>;
    expect(data.staleRoots).toBeUndefined();
  });

  it('inspect_workflow succeeds and includes staleRoots when a remembered root no longer exists', async () => {
    const dataRoot = await mkTempDir('workrail-stale-inspect-data-');
    const workspaceRoot = await mkTempDir('workrail-stale-inspect-ws-');
    const { ctx, rememberedRootsStore } = await buildCtx(dataRoot, workspaceRoot);
    await writeWorkspaceWorkflow(workspaceRoot);

    const stalePath = path.join(os.tmpdir(), `wr-stale-${Date.now()}`); // never created
    const rememberRes = await rememberedRootsStore.rememberRoot(stalePath);
    expect(rememberRes.isOk()).toBe(true);

    const result = await handleV2InspectWorkflow(
      { workflowId: 'test-workflow', mode: 'metadata', workspacePath: workspaceRoot },
      ctx,
    );

    expect(result.type).toBe('success');
    const data = result.data as Record<string, unknown>;
    expect(Array.isArray(data.staleRoots)).toBe(true);
    expect(data.staleRoots as string[]).toContain(path.resolve(stalePath));
  });

  it('start_workflow succeeds and includes staleRoots when a remembered root no longer exists', async () => {
    const dataRoot = await mkTempDir('workrail-stale-start-data-');
    const workspaceRoot = await mkTempDir('workrail-stale-start-ws-');
    const { ctx, rememberedRootsStore } = await buildCtx(dataRoot, workspaceRoot);
    await writeWorkspaceWorkflow(workspaceRoot);

    const stalePath = path.join(os.tmpdir(), `wr-stale-${Date.now()}`); // never created
    const rememberRes = await rememberedRootsStore.rememberRoot(stalePath);
    expect(rememberRes.isOk()).toBe(true);

    const result = await handleV2StartWorkflow(
      { workflowId: 'test-workflow', workspacePath: workspaceRoot, goal: 'test workflow execution' },
      ctx,
    );

    expect(result.type).toBe('success');
    const data = result.data as Record<string, unknown>;
    expect(Array.isArray(data.staleRoots)).toBe(true);
    expect(data.staleRoots as string[]).toContain(path.resolve(stalePath));
  });
});

describe('v2 remembered roots integration', () => {
  it('list_workflows remembers explicit workspacePath in the persistent store', async () => {
    const dataRoot = await mkTempDir('workrail-remembered-roots-data-');
    const workspaceRoot = await mkTempDir('workrail-remembered-roots-workspace-');
    await writeWorkspaceWorkflow(workspaceRoot);

    const { ctx } = await buildCtx(dataRoot);
    const result = await handleV2ListWorkflows({ workspacePath: workspaceRoot }, ctx);
    expect(result.type).toBe('success');

    const reloadedStore = new LocalRememberedRootsStoreV2(
      new LocalDataDirV2({ WORKRAIL_DATA_DIR: dataRoot }),
      new NodeFileSystemV2(), new NodeTimeClockV2(),
    );
    const roots = await reloadedStore.listRoots();
    expect(roots.isOk()).toBe(true);
    expect(roots._unsafeUnwrap()).toEqual([path.resolve(workspaceRoot)]);
  });

  it('start_workflow remembers explicit workspacePath across store instances', async () => {
    const dataRoot = await mkTempDir('workrail-remembered-roots-start-data-');
    const workspaceRoot = await mkTempDir('workrail-remembered-roots-start-workspace-');
    await writeWorkspaceWorkflow(workspaceRoot);

    const { ctx } = await buildCtx(dataRoot);
    const result = await handleV2StartWorkflow(
      { workflowId: 'test-workflow', workspacePath: workspaceRoot, goal: 'test workflow execution' },
      ctx,
    );
    expect(result.type).toBe('success');

    const reloadedStore = new LocalRememberedRootsStoreV2(
      new LocalDataDirV2({ WORKRAIL_DATA_DIR: dataRoot }),
      new NodeFileSystemV2(), new NodeTimeClockV2(),
    );
    const roots = await reloadedStore.listRoots();
    expect(roots.isOk()).toBe(true);
    expect(roots._unsafeUnwrap()).toEqual([path.resolve(workspaceRoot)]);
  });

  it('inspect_workflow remembers explicit workspacePath in the persistent store', async () => {
    const dataRoot = await mkTempDir('workrail-remembered-roots-inspect-data-');
    const workspaceRoot = await mkTempDir('workrail-remembered-roots-inspect-workspace-');
    await writeWorkspaceWorkflow(workspaceRoot);

    const { ctx } = await buildCtx(dataRoot);
    const result = await handleV2InspectWorkflow(
      { workflowId: 'test-workflow', mode: 'metadata', workspacePath: workspaceRoot },
      ctx,
    );
    expect(result.type).toBe('success');

    const reloadedStore = new LocalRememberedRootsStoreV2(
      new LocalDataDirV2({ WORKRAIL_DATA_DIR: dataRoot }),
      new NodeFileSystemV2(), new NodeTimeClockV2(),
    );
    const roots = await reloadedStore.listRoots();
    expect(roots.isOk()).toBe(true);
    expect(roots._unsafeUnwrap()).toEqual([path.resolve(workspaceRoot)]);
  });

  it('resume_session remembers explicit workspacePath across store instances', async () => {
    const dataRoot = await mkTempDir('workrail-remembered-roots-resume-data-');
    const workspaceRoot = await mkTempDir('workrail-remembered-roots-resume-workspace-');

    const { ctx } = await buildCtx(dataRoot);

    const result = await handleV2ResumeSession(
      {
        workspacePath: workspaceRoot,
      },
      ctx,
    );
    expect(result.type).toBe('success');

    const reloadedStore = new LocalRememberedRootsStoreV2(
      new LocalDataDirV2({ WORKRAIL_DATA_DIR: dataRoot }),
      new NodeFileSystemV2(), new NodeTimeClockV2(),
    );
    const roots = await reloadedStore.listRoots();
    expect(roots.isOk()).toBe(true);
    expect(roots._unsafeUnwrap()).toEqual([path.resolve(workspaceRoot)]);
  });
});
