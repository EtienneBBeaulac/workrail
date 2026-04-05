import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { okAsync } from 'neverthrow';

import { handleV2ListWorkflows } from '../../../src/mcp/handlers/v2-workflow.js';
import type { ToolContext } from '../../../src/mcp/types.js';
import { StaticFeatureFlagProvider } from '../../../src/config/feature-flags.js';
import { LocalDataDirV2 } from '../../../src/v2/infra/local/data-dir/index.js';
import { NodeFileSystemV2 } from '../../../src/v2/infra/local/fs/index.js';
import { NodeCryptoV2 } from '../../../src/v2/infra/local/crypto/index.js';
import { LocalPinnedWorkflowStoreV2 } from '../../../src/v2/infra/local/pinned-workflow-store/index.js';
import { createTestValidationPipelineDeps } from '../../helpers/v2-test-helpers.js';
import type { RememberedRootsStorePortV2 } from '../../../src/v2/ports/remembered-roots-store.port.js';
import { InMemoryManagedSourceStoreV2 } from '../../../src/v2/infra/in-memory/managed-source-store/index.js';
import { errAsync } from 'neverthrow';
import type { ManagedSourceStorePortV2 } from '../../../src/v2/ports/managed-source-store.port.js';

function writeWorkflow(dir: string, id: string, name: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.v2.json`),
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
      })),
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
      loadAllWorkflows: async () => [],
      listWorkflowSummaries: async () => [],
      getWorkflowById: async () => null,
      getNextStep: async () => {
        throw new Error('not used');
      },
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

function buildCtxWithManagedStore(
  rememberedRoots: RememberedRootsStorePortV2,
  managedStore: InMemoryManagedSourceStoreV2,
): ToolContext {
  const base = buildCtx(rememberedRoots);
  return {
    ...base,
    v2: {
      ...(base.v2 as object),
      managedSourceStore: managedStore,
    },
  } as any;
}

describe('v2 workflow source catalog output', () => {
  it('lists effective and shadowed sources for rooted-sharing overlap', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-v2-source-catalog-'));
    const workspace = path.join(tempRoot, 'workspace');
    const projectDir = path.join(workspace, 'workflows');
    const rememberedRoot = path.join(tempRoot, 'repo');
    const rootedDir = path.join(rememberedRoot, 'packages', 'tools', '.workrail', 'workflows');

    writeWorkflow(projectDir, 'shared-workflow', 'Legacy Project Workflow');
    writeWorkflow(rootedDir, 'shared-workflow', 'Rooted Workflow');
    writeWorkflow(rootedDir, 'rooted-only-workflow', 'Rooted Only Workflow');

    const result = await handleV2ListWorkflows(
      { workspacePath: workspace, includeSources: true },
      buildCtx(rememberedRootsStore(rememberedRoot)),
    );

    expect(result.type).toBe('success');
    if (result.type !== 'success') return;

    const sources = (result.data as { sources: Array<Record<string, any>> }).sources;
    expect(sources.length).toBeGreaterThanOrEqual(2);

    const project = sources.find((entry) => entry.category === 'legacy_project');
    expect(project).toEqual({
      sourceKey: `project:${path.join(workspace, 'workflows')}`,
      category: 'legacy_project',
      source: {
        kind: 'project',
        displayName: 'Project',
      },
      sourceMode: 'legacy_project',
      effectiveWorkflowCount: 1,
      totalWorkflowCount: 1,
      shadowedWorkflowCount: 0,
      migration: {
        preferredSource: 'rooted_sharing',
        currentSource: 'legacy_project',
        reason: 'legacy_project_precedence',
        summary:
          'Project-scoped ./workflows currently overrides rooted .workrail/workflows during migration. Prefer rooted sharing for new team-shared workflows.',
      },
    });

    const rooted = sources.find((entry) => entry.category === 'rooted_sharing');
    expect(rooted).toEqual({
      sourceKey: `custom:${path.join(rememberedRoot, 'packages', 'tools', '.workrail', 'workflows')}`,
      category: 'rooted_sharing',
      source: {
        kind: 'custom',
        displayName: 'workflows',
      },
      sourceMode: 'rooted_sharing',
      effectiveWorkflowCount: 1,
      totalWorkflowCount: 2,
      shadowedWorkflowCount: 1,
      rootedSharing: {
        kind: 'remembered_root',
        rootPath: path.resolve(rememberedRoot),
        groupLabel: 'tools',
      },
    });

    expect(sources.some((entry) => entry.category === 'built_in')).toBe(true);
  });

  it('includes env-configured external-style sources in the catalog', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-v2-source-catalog-env-'));
    const workspace = path.join(tempRoot, 'workspace');
    const envRepo = path.join(tempRoot, 'env-repo');
    const envWorkflowsDir = path.join(envRepo, '.workrail', 'workflows');

    fs.mkdirSync(workspace, { recursive: true });
    writeWorkflow(envWorkflowsDir, 'env-configured-workflow', 'Env Configured Workflow');

    const previousGitRepos = process.env['WORKFLOW_GIT_REPOS'];
    process.env['WORKFLOW_GIT_REPOS'] = pathToFileURL(envRepo).href;

    try {
      const result = await handleV2ListWorkflows(
        { workspacePath: workspace, includeSources: true },
        buildCtx(rememberedRootsStore()),
      );

      expect(result.type).toBe('success');
      if (result.type !== 'success') return;

      const sources = (result.data as { sources: Array<Record<string, any>> }).sources;
      const envConfigured = sources.find(
        (entry) =>
          entry.sourceKey === `custom:${envRepo}`
      );

      expect(envConfigured).toEqual({
        sourceKey: `custom:${envRepo}`,
        category: 'external',
        sourceMode: 'live_directory',
        source: {
          kind: 'custom',
          displayName: path.basename(envRepo),
        },
        effectiveWorkflowCount: 1,
        totalWorkflowCount: 1,
        shadowedWorkflowCount: 0,
      });
    } finally {
      if (previousGitRepos === undefined) {
        delete process.env['WORKFLOW_GIT_REPOS'];
      } else {
        process.env['WORKFLOW_GIT_REPOS'] = previousGitRepos;
      }
    }
  });

  it('succeeds and returns sources when includeSources is true with no extra roots configured', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-v2-source-catalog-readonly-'));
    const workspace = path.join(tempRoot, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });

    const result = await handleV2ListWorkflows(
      { workspacePath: workspace, includeSources: true },
      buildCtx(rememberedRootsStore()),
    );

    expect(result.type).toBe('success');
    if (result.type !== 'success') return;
    const data = result.data as { sources?: Array<Record<string, unknown>> };
    expect(Array.isArray(data.sources)).toBe(true);
    // At minimum, built-in source should be present
    expect(data.sources!.some((s) => s.category === 'built_in')).toBe(true);
  });

  it('omits sources field when includeSources is not set', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-v2-source-catalog-absent-'));
    const workspace = path.join(tempRoot, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });

    const result = await handleV2ListWorkflows(
      { workspacePath: workspace },
      buildCtx(rememberedRootsStore()),
    );

    expect(result.type).toBe('success');
    if (result.type !== 'success') return;
    const data = result.data as Record<string, unknown>;
    expect(data.sources).toBeUndefined();
  });

  it('shows attached managed source as category=managed in catalog and its workflows in listing', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-v2-source-catalog-managed-'));
    const workspace = path.join(tempRoot, 'workspace');
    const managedDir = path.join(tempRoot, 'managed-workflows');

    fs.mkdirSync(workspace, { recursive: true });
    writeWorkflow(managedDir, 'managed-workflow', 'Managed Workflow');

    const managedStore = new InMemoryManagedSourceStoreV2();
    await managedStore.attach(managedDir);

    const result = await handleV2ListWorkflows(
      { workspacePath: workspace, includeSources: true },
      buildCtxWithManagedStore(rememberedRootsStore(), managedStore),
    );

    expect(result.type).toBe('success');
    if (result.type !== 'success') return;

    const data = result.data as { workflows: Array<{ workflowId: string }>; sources: Array<Record<string, unknown>> };

    // Workflow from managed directory appears in listing
    expect(data.workflows.some((w) => w.workflowId === 'managed-workflow')).toBe(true);

    // Catalog has a managed entry for the attached directory
    const managedEntry = data.sources.find((s) => s.category === 'managed');
    expect(managedEntry).toBeDefined();
    expect(managedEntry!.sourceKey).toBe(`custom:${path.resolve(managedDir)}`);
    expect(managedEntry!.sourceMode).toBe('live_directory');
    expect(managedEntry!.effectiveWorkflowCount).toBe(1);
    expect((managedEntry!.managed as { addedAtMs: number }).addedAtMs).toBeGreaterThanOrEqual(0);
    // Not rooted-sharing -- no rootedSharing context expected
    expect(managedEntry!.rootedSharing).toBeUndefined();
  });

  it('shows managed source that is also a remembered root as single catalog entry with managed category and rootedSharing context', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-v2-source-catalog-managed-rooted-'));
    const workspace = path.join(tempRoot, 'workspace');
    const rememberedRoot = path.join(tempRoot, 'repo');
    // The rooted workflow directory discovered by the remembered root walk
    const rootedDir = path.join(rememberedRoot, '.workrail', 'workflows');

    fs.mkdirSync(workspace, { recursive: true });
    writeWorkflow(rootedDir, 'shared-workflow', 'Shared Workflow');

    // Attach the same path as a managed source
    const managedStore = new InMemoryManagedSourceStoreV2();
    await managedStore.attach(rootedDir);

    const result = await handleV2ListWorkflows(
      { workspacePath: workspace, includeSources: true },
      buildCtxWithManagedStore(rememberedRootsStore(rememberedRoot), managedStore),
    );

    expect(result.type).toBe('success');
    if (result.type !== 'success') return;

    const sources = (result.data as { sources: Array<Record<string, unknown>> }).sources;

    // Exactly one entry for this path -- no dual truth
    const entriesForPath = sources.filter((s) => s.sourceKey === `custom:${path.resolve(rootedDir)}`);
    expect(entriesForPath).toHaveLength(1);

    const entry = entriesForPath[0]!;
    expect(entry.category).toBe('managed');
    // rootedSharing context is present (the relationship is explicit)
    expect(entry.rootedSharing).toBeDefined();
    expect((entry.rootedSharing as { kind: string }).kind).toBe('remembered_root');
    expect(entry.managed).toBeDefined();
  });

  it('surfaces missing managed source directory in staleRoots', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-v2-source-catalog-stale-managed-'));
    const workspace = path.join(tempRoot, 'workspace');
    const missingDir = path.join(tempRoot, 'nonexistent-workflows');

    fs.mkdirSync(workspace, { recursive: true });
    // Do NOT create missingDir -- it intentionally does not exist

    const managedStore = new InMemoryManagedSourceStoreV2();
    await managedStore.attach(missingDir);

    const result = await handleV2ListWorkflows(
      { workspacePath: workspace, tags: ['coding'] },
      buildCtxWithManagedStore(rememberedRootsStore(), managedStore),
    );

    expect(result.type).toBe('success');
    if (result.type !== 'success') return;

    const data = result.data as { staleRoots?: string[] };
    expect(data.staleRoots).toBeDefined();
    expect(data.staleRoots).toContain(path.resolve(missingDir));
  });

  it('includes missing managed source as stale catalog entry when includeSources is true', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-v2-source-catalog-stale-entry-'));
    const workspace = path.join(tempRoot, 'workspace');
    const missingDir = path.join(tempRoot, 'gone-workflows');

    fs.mkdirSync(workspace, { recursive: true });
    // Do NOT create missingDir

    const managedStore = new InMemoryManagedSourceStoreV2();
    await managedStore.attach(missingDir);

    const result = await handleV2ListWorkflows(
      { workspacePath: workspace, includeSources: true },
      buildCtxWithManagedStore(rememberedRootsStore(), managedStore),
    );

    expect(result.type).toBe('success');
    if (result.type !== 'success') return;

    const data = result.data as { staleRoots?: string[]; sources?: Array<Record<string, unknown>> };

    // Stale path still appears in staleRoots
    expect(data.staleRoots).toContain(path.resolve(missingDir));

    // Stale path also appears in the catalog so agents don't need to cross-reference staleRoots
    const staleEntry = data.sources!.find((s) => s.sourceKey === `custom:${path.resolve(missingDir)}`);
    expect(staleEntry).toBeDefined();
    expect(staleEntry!.category).toBe('managed');
    expect(staleEntry!.stale).toBe(true);
    expect(staleEntry!.effectiveWorkflowCount).toBe(0);
    expect(staleEntry!.totalWorkflowCount).toBe(0);
    expect((staleEntry!.managed as { addedAtMs: number }).addedAtMs).toBeGreaterThanOrEqual(0);
  });

  it('surfaces a warning when the managed source store fails, without failing the call', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-v2-source-catalog-store-err-'));
    const workspace = path.join(tempRoot, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });

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

    const result = await handleV2ListWorkflows({ workspacePath: workspace }, ctx);

    expect(result.type).toBe('success');
    if (result.type !== 'success') return;

    const data = result.data as { warnings?: string[] };
    expect(Array.isArray(data.warnings)).toBe(true);
    expect(data.warnings!.some((w) => w.includes('MANAGED_SOURCE_IO_ERROR'))).toBe(true);
  });

  it('does not create duplicate catalog entry when managed source path matches WORKFLOW_STORAGE_PATH', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-v2-source-catalog-env-dedup-'));
    const workspace = path.join(tempRoot, 'workspace');
    const sharedDir = path.join(tempRoot, 'shared-workflows');

    fs.mkdirSync(workspace, { recursive: true });
    writeWorkflow(sharedDir, 'env-and-managed', 'Shared Workflow');

    const managedStore = new InMemoryManagedSourceStoreV2();
    await managedStore.attach(sharedDir);

    const previousEnv = process.env['WORKFLOW_STORAGE_PATH'];
    process.env['WORKFLOW_STORAGE_PATH'] = sharedDir;

    try {
      const result = await handleV2ListWorkflows(
        { workspacePath: workspace, includeSources: true },
        buildCtxWithManagedStore(rememberedRootsStore(), managedStore),
      );

      expect(result.type).toBe('success');
      if (result.type !== 'success') return;

      const data = result.data as { workflows: Array<{ workflowId: string }>; sources: Array<Record<string, unknown>> };

      // Workflow appears exactly once in the listing (no duplicate)
      const matches = data.workflows.filter((w) => w.workflowId === 'env-and-managed');
      expect(matches).toHaveLength(1);

      // Source catalog has exactly one entry for the shared dir
      const sourceKey = `custom:${path.resolve(sharedDir)}`;
      const catalogEntries = data.sources.filter((s) => s.sourceKey === sourceKey);
      expect(catalogEntries).toHaveLength(1);
    } finally {
      if (previousEnv === undefined) {
        delete process.env['WORKFLOW_STORAGE_PATH'];
      } else {
        process.env['WORKFLOW_STORAGE_PATH'] = previousEnv;
      }
    }
  });
});
