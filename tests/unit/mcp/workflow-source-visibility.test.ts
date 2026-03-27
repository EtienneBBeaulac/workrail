import path from 'path';
import { describe, expect, it } from 'vitest';
import { createWorkflow } from '../../../src/types/workflow.js';
import {
  createBundledSource,
  createCustomDirectorySource,
  createProjectDirectorySource,
} from '../../../src/types/workflow-source.js';
import type { ICompositeWorkflowStorage, IWorkflowStorage } from '../../../src/types/storage.js';
import {
  detectWorkflowMigrationGuidance,
  toWorkflowVisibility,
} from '../../../src/mcp/handlers/shared/workflow-source-visibility.js';

function workflow(id: string, source: ReturnType<typeof createBundledSource> | ReturnType<typeof createCustomDirectorySource> | ReturnType<typeof createProjectDirectorySource>) {
  return createWorkflow({
    id,
    name: id,
    description: `${id} description`,
    version: '1.0.0',
    steps: [{ id: 'step-1', title: 'Step 1', prompt: 'Do the thing' }],
  }, source);
}

describe('workflow-source-visibility', () => {
  it('exposes raw source info for bundled workflows without rooted-sharing context', () => {
    const result = toWorkflowVisibility(
      workflow('wr.test', createBundledSource()),
      []
    );

    expect(result).toEqual({
      category: 'built_in',
      source: {
        kind: 'bundled',
        displayName: 'Built-in',
      },
    });
  });

  it('derives rooted-sharing context for custom workflow directories under remembered roots', () => {
    const rootPath = '/tmp/repo';
    const sourcePath = path.join(rootPath, 'packages', 'tools', '.workrail', 'workflows');

    const result = toWorkflowVisibility(
      workflow('rooted.test', createCustomDirectorySource(sourcePath, 'workflows')),
      [{ path: rootPath, addedAtMs: 1, lastSeenAtMs: 1, source: 'explicit_workspace_path' }]
    );

    expect(result).toEqual({
      category: 'rooted_sharing',
      source: {
        kind: 'custom',
        displayName: 'workflows',
      },
      rootedSharing: {
        kind: 'remembered_root',
        rootPath,
        groupLabel: 'tools',
      },
    });
  });

  it('does not derive rooted-sharing context for custom workflow directories outside remembered roots', () => {
    const result = toWorkflowVisibility(
      workflow('custom.test', createCustomDirectorySource('/tmp/other/custom-workflows', 'custom-workflows')),
      [{ path: '/tmp/repo', addedAtMs: 1, lastSeenAtMs: 1, source: 'explicit_workspace_path' }]
    );

    expect(result).toEqual({
      category: 'external',
      source: {
        kind: 'custom',
        displayName: 'custom-workflows',
      },
    });
  });

  it('does not attach rooted-sharing context to project workflows even if their path is under a remembered root', () => {
    const sourcePath = '/tmp/repo/workflows';

    const result = toWorkflowVisibility(
      workflow('project.test', createProjectDirectorySource(sourcePath)),
      [{ path: '/tmp/repo', addedAtMs: 1, lastSeenAtMs: 1, source: 'explicit_workspace_path' }]
    );

    expect(result).toEqual({
      category: 'legacy_project',
      source: {
        kind: 'project',
        displayName: 'Project',
      },
    });
  });

  it('detects migration guidance when a project workflow shadows a rooted-sharing workflow with the same id', async () => {
    const tempRoot = path.join('/tmp', `wr-visibility-${Date.now()}`);
    const rootPath = path.join(tempRoot, 'repo');
    const rootedPath = path.join(rootPath, 'packages', 'tools', '.workrail', 'workflows');
    const projectPath = path.join(tempRoot, 'workspace', 'workflows');
    const projectWorkflow = workflow('shared.workflow', createProjectDirectorySource(projectPath));
    const rootedWorkflow = workflow('shared.workflow', createCustomDirectorySource(rootedPath, 'workflows'));

    const projectStorage: IWorkflowStorage = {
      kind: 'single',
      source: projectWorkflow.source,
      loadAllWorkflows: async () => [projectWorkflow],
      getWorkflowById: async (id: string) => (id === projectWorkflow.definition.id ? projectWorkflow : null),
      listWorkflowSummaries: async () => [],
    };

    const rootedStorage: IWorkflowStorage = {
      kind: 'single',
      source: rootedWorkflow.source,
      loadAllWorkflows: async () => [rootedWorkflow],
      getWorkflowById: async (id: string) => (id === rootedWorkflow.definition.id ? rootedWorkflow : null),
      listWorkflowSummaries: async () => [],
    };

    const reader: ICompositeWorkflowStorage = {
      kind: 'composite',
      loadAllWorkflows: async () => [projectWorkflow],
      getWorkflowById: async (id: string) => (id === projectWorkflow.definition.id ? projectWorkflow : null),
      listWorkflowSummaries: async () => [],
      getSources: () => [rootedWorkflow.source, projectWorkflow.source],
      getStorageInstances: () => [rootedStorage, projectStorage],
    };

    const migration = await detectWorkflowMigrationGuidance({
      workflow: projectWorkflow,
      workflowReader: reader,
      rememberedRoots: [{ path: rootPath, addedAtMs: 1, lastSeenAtMs: 1, source: 'explicit_workspace_path' }],
    });

    expect(migration).toEqual({
      preferredSource: 'rooted_sharing',
      currentSource: 'legacy_project',
      reason: 'legacy_project_precedence',
      summary:
        'Project-scoped ./workflows currently overrides rooted .workrail/workflows during migration. Prefer rooted sharing for new team-shared workflows.',
    });
  });
});
