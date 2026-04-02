import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
    process.env['WORKFLOW_GIT_REPOS'] = `file://${envRepo}`;

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
});
