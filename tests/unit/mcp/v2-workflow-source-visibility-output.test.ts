import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { okAsync } from 'neverthrow';

import { handleV2InspectWorkflow, handleV2ListWorkflows } from '../../../src/mcp/handlers/v2-workflow.js';
import type { ToolContext } from '../../../src/mcp/types.js';
import { StaticFeatureFlagProvider } from '../../../src/config/feature-flags.js';
import { LocalDataDirV2 } from '../../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../../src/v2/infra/local/fs/index.js';
import { NodeCryptoV2 } from '../../../src/v2/infra/local/crypto/index.js';
import { LocalPinnedWorkflowStoreV2 } from '../../../src/v2/infra/local/pinned-workflow-store/index.js';
import { createTestValidationPipelineDeps } from '../../helpers/v2-test-helpers.js';
import type { RememberedRootsStorePortV2 } from '../../../src/v2/ports/remembered-roots-store.port.js';
import type { ManagedSourceStorePortV2 } from '../../../src/v2/ports/managed-source-store.port.js';
import { errAsync } from 'neverthrow';
import { createWorkflow } from '../../../src/types/workflow.js';
import { createProjectDirectorySource } from '../../../src/types/workflow-source.js';

function writeRootedWorkflow(rootDir: string, segments: readonly string[], id: string, name: string): void {
  const workflowsDir = path.join(rootDir, ...segments, '.workrail', 'workflows');
  fs.mkdirSync(workflowsDir, { recursive: true });
  fs.writeFileSync(
    path.join(workflowsDir, `${id}.v2.json`),
    JSON.stringify({
      id,
      name,
      description: `${name} description`,
      version: '0.0.1',
      steps: [{ id: 'step-1', title: 'Step 1', prompt: 'Do the thing' }],
    }, null, 2),
    'utf8',
  );
}

function writeProjectWorkflow(workspaceRoot: string, id: string, name: string): void {
  const workflowsDir = path.join(workspaceRoot, 'workflows');
  fs.mkdirSync(workflowsDir, { recursive: true });
  fs.writeFileSync(
    path.join(workflowsDir, `${id}.v2.json`),
    JSON.stringify({
      id,
      name,
      description: `${name} description`,
      version: '0.0.1',
      steps: [{ id: 'step-1', title: 'Step 1', prompt: 'Do the thing' }],
    }, null, 2),
    'utf8',
  );
}

function rememberedRootsStore(...roots: readonly string[]): RememberedRootsStorePortV2 {
  return {
    listRoots: () => okAsync([...roots]),
    listRootRecords: () => okAsync(
      roots.map((root, index) => ({
        path: root,
        addedAtMs: index,
        lastSeenAtMs: index,
        source: 'explicit_workspace_path' as const,
      }))
    ),
    rememberRoot: () => okAsync(undefined),
  };
}

function buildCtx(rememberedRoots: RememberedRootsStorePortV2): ToolContext {
  const dataDir = new LocalDataDirV2(process.env);
  const fsPort = new NodeFileSystemV2();
  const crypto = new NodeCryptoV2();
  const pinnedStore = new LocalPinnedWorkflowStoreV2(dataDir, fsPort);

  return {
    workflowService: {
      listWorkflowSummaries: async () => [],
      getWorkflowById: async () => null,
      getNextStep: async () => { throw new Error('not used'); },
      validateStepOutput: async () => ({ valid: true, issues: [], suggestions: [] }),
    } as any,
    featureFlags: new StaticFeatureFlagProvider({
      v2Tools: true,
      leanWorkflows: false,
      agenticRoutines: false,
      experimentalWorkflows: false,
    }),
    sessionManager: null,
    httpServer: null,
    v2: {
      crypto,
      pinnedStore,
      rememberedRootsStore: rememberedRoots,
      validationPipelineDeps: createTestValidationPipelineDeps(),
      resolvedRootUris: [],
    },
  } as any;
}

describe('v2 workflow source visibility outputs', () => {
  it('surfaces rooted-sharing visibility on list_workflows results', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-v2-visibility-list-'));
    const workspace = path.join(tempRoot, 'workspace');
    const rememberedRoot = path.join(tempRoot, 'repo');
    fs.mkdirSync(workspace, { recursive: true });
    writeRootedWorkflow(rememberedRoot, ['packages', 'tools'], 'rooted-workflow', 'Rooted Workflow');

    const result = await handleV2ListWorkflows(
      { workspacePath: workspace },
      buildCtx(rememberedRootsStore(rememberedRoot)),
    );

    expect(result.type).toBe('success');
    if (result.type !== 'success') return;

    const workflows = (result.data as { workflows: Array<Record<string, any>> }).workflows;
    const rooted = workflows.find((workflow) => workflow.workflowId === 'rooted-workflow');
    expect(rooted).toBeDefined();
    expect(rooted.visibility).toEqual({
      category: 'rooted_sharing',
      source: {
        kind: 'custom',
        displayName: 'workflows',
      },
      rootedSharing: {
        kind: 'remembered_root',
        rootPath: path.resolve(rememberedRoot),
        groupLabel: 'tools',
      },
    });
  });

  it('surfaces migration guidance when a legacy project workflow overrides rooted sharing', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-v2-visibility-inspect-'));
    const workspace = path.join(tempRoot, 'workspace');
    const rememberedRoot = path.join(tempRoot, 'repo');
    fs.mkdirSync(workspace, { recursive: true });
    writeProjectWorkflow(workspace, 'shared-workflow', 'Legacy Project Workflow');
    writeRootedWorkflow(rememberedRoot, ['packages', 'tools'], 'shared-workflow', 'Rooted Workflow');

    const result = await handleV2InspectWorkflow(
      { workflowId: 'shared-workflow', mode: 'metadata', workspacePath: workspace },
      buildCtx(rememberedRootsStore(rememberedRoot)),
    );

    expect(result.type).toBe('success');
    if (result.type !== 'success') return;

    const data = result.data as Record<string, any>;
    expect(data.visibility).toEqual({
      category: 'legacy_project',
      source: {
        kind: 'project',
        displayName: 'Project',
      },
      migration: {
        preferredSource: 'rooted_sharing',
        currentSource: 'legacy_project',
        reason: 'legacy_project_precedence',
        summary:
          'Project-scoped ./workflows currently overrides rooted .workrail/workflows during migration. Prefer rooted sharing for new team-shared workflows.',
      },
    });
  });

  it('surfaces managed source store error as warnings in inspect_workflow response', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-v2-inspect-store-err-'));
    const workspace = path.join(tempRoot, 'workspace');
    writeProjectWorkflow(workspace, 'test-workflow', 'Test Workflow');

    const failingStore: ManagedSourceStorePortV2 = {
      list: () => errAsync({ code: 'MANAGED_SOURCE_IO_ERROR' as const, message: 'disk failure' }),
      attach: () => errAsync({ code: 'MANAGED_SOURCE_IO_ERROR' as const, message: 'disk failure' }),
      detach: () => errAsync({ code: 'MANAGED_SOURCE_IO_ERROR' as const, message: 'disk failure' }),
    };

    const ctx: ToolContext = {
      ...buildCtx(rememberedRootsStore()),
      v2: {
        ...(buildCtx(rememberedRootsStore()).v2 as object),
        managedSourceStore: failingStore,
      },
    } as any;

    const result = await handleV2InspectWorkflow(
      { workflowId: 'test-workflow', workspacePath: workspace, mode: 'metadata' },
      ctx,
    );

    expect(result.type).toBe('success');
    if (result.type !== 'success') return;

    const data = result.data as { warnings?: string[] };
    expect(Array.isArray(data.warnings)).toBe(true);
    expect(data.warnings!.some((w) => w.includes('MANAGED_SOURCE_IO_ERROR'))).toBe(true);
  });
});
