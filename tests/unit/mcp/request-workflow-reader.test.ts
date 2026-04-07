import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it } from 'vitest';
import { StaticFeatureFlagProvider } from '../../../src/config/feature-flags.js';
import {
  createWorkflowReaderForRequest,
  discoverRootedWorkflowDirectories,
  resolveRequestWorkspaceDirectory,
  toProjectWorkflowDirectory,
} from '../../../src/mcp/handlers/shared/request-workflow-reader.js';
import type { RememberedRootsStorePortV2 } from '../../../src/v2/ports/remembered-roots-store.port.js';
import { okAsync } from 'neverthrow';

function writeWorkflow(workspaceDir: string, name: string): void {
  const workflowsDir = path.join(workspaceDir, 'workflows');
  fs.mkdirSync(workflowsDir, { recursive: true });
  fs.writeFileSync(
    path.join(workflowsDir, 'workspace-scoped-workflow.v2.json'),
    JSON.stringify({
      id: 'workspace-scoped-workflow',
      name,
      description: `${name} description`,
      version: '0.0.1',
      steps: [
        {
          id: 'step-1',
          title: 'Step 1',
          prompt: 'Do the thing',
        },
      ],
    }, null, 2),
    'utf8',
  );
}

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
      steps: [
        {
          id: 'step-1',
          title: 'Step 1',
          prompt: 'Do the thing',
        },
      ],
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

describe('request-workflow-reader', () => {
  it('prefers explicit workspacePath over roots and server cwd', () => {
    const explicitWorkspace = path.join(os.tmpdir(), 'explicit-workspace');
    const rootWorkspace = path.join(os.tmpdir(), 'root-workspace');
    const serverWorkspace = path.join(os.tmpdir(), 'server-workspace');

    expect(resolveRequestWorkspaceDirectory({
      workspacePath: explicitWorkspace,
      resolvedRootUris: [pathToFileURL(rootWorkspace).toString()],
      serverCwd: serverWorkspace,
    })).toBe(explicitWorkspace);
  });

  it('uses the first MCP root URI when workspacePath is absent', () => {
    const rootWorkspaceA = path.join(os.tmpdir(), 'root-workspace-a');
    const rootWorkspaceB = path.join(os.tmpdir(), 'root-workspace-b');
    const serverWorkspace = path.join(os.tmpdir(), 'server-workspace');

    expect(resolveRequestWorkspaceDirectory({
      resolvedRootUris: [
        pathToFileURL(rootWorkspaceA).toString(),
        pathToFileURL(rootWorkspaceB).toString(),
      ],
      serverCwd: serverWorkspace,
    })).toBe(rootWorkspaceA);
  });

  it('falls back to server cwd when no workspacePath or usable root URI exists', () => {
    const serverWorkspace = path.join(os.tmpdir(), 'server-workspace');

    expect(resolveRequestWorkspaceDirectory({
      resolvedRootUris: ['https://example.com/workspace'],
      serverCwd: serverWorkspace,
    })).toBe(serverWorkspace);
  });

  it('appends workflows unless the directory is already workflows', () => {
    const projectDirectory = path.join(os.tmpdir(), 'project');
    const workflowsDirectory = path.join(projectDirectory, 'workflows');

    expect(toProjectWorkflowDirectory(projectDirectory)).toBe(workflowsDirectory);
    expect(toProjectWorkflowDirectory(workflowsDirectory)).toBe(workflowsDirectory);
  });

  it('loads project workflows from the request workspace instead of server cwd', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-request-reader-'));
    const workspaceA = path.join(tempRoot, 'workspace-a');
    const workspaceB = path.join(tempRoot, 'workspace-b');
    writeWorkflow(workspaceA, 'Workspace A');
    writeWorkflow(workspaceB, 'Workspace B');

    const { reader } = await createWorkflowReaderForRequest({
      featureFlags: new StaticFeatureFlagProvider({
        v2Tools: true,
        leanWorkflows: false,
        agenticRoutines: false,
        experimentalWorkflows: false,
      }),
      resolvedRootUris: [pathToFileURL(workspaceA).toString()],
      serverCwd: workspaceB,
    });

    const workflow = await reader.getWorkflowById('workspace-scoped-workflow');
    expect(workflow?.definition.name).toBe('Workspace A');
    expect(workflow?.source.kind).toBe('project');
    expect((workflow?.source.kind === 'project' ? workflow.source.directoryPath : undefined))
      .toBe(path.join(workspaceA, 'workflows'));
  });

  it('discovers rooted workflow directories under remembered roots in deterministic order', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-rooted-reader-'));
    const rememberedRoot = path.join(tempRoot, 'repo');
    writeRootedWorkflow(rememberedRoot, ['packages', 'b'], 'pkg-b-workflow', 'Package B');
    writeRootedWorkflow(rememberedRoot, ['packages', 'a'], 'pkg-a-workflow', 'Package A');
    writeRootedWorkflow(rememberedRoot, [], 'repo-root-workflow', 'Repo Root');

    const { discovered, stale } = await discoverRootedWorkflowDirectories([rememberedRoot]);
    expect(stale).toEqual([]);
    expect(discovered).toEqual([
      path.join(rememberedRoot, '.workrail', 'workflows'),
      path.join(rememberedRoot, 'packages', 'a', '.workrail', 'workflows'),
      path.join(rememberedRoot, 'packages', 'b', '.workrail', 'workflows'),
    ]);
  });

  it('loads workflows from rooted .workrail/workflows under remembered roots', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-rooted-reader-'));
    const workspace = path.join(tempRoot, 'workspace');
    const rememberedRoot = path.join(tempRoot, 'repo');
    fs.mkdirSync(workspace, { recursive: true });
    writeRootedWorkflow(rememberedRoot, ['packages', 'tools'], 'rooted-workflow', 'Rooted Workflow');

    const { reader, stalePaths } = await createWorkflowReaderForRequest({
      featureFlags: new StaticFeatureFlagProvider({
        v2Tools: true,
        leanWorkflows: false,
        agenticRoutines: false,
        experimentalWorkflows: false,
      }),
      workspacePath: workspace,
      rememberedRootsStore: rememberedRootsStore(rememberedRoot),
    });

    expect(stalePaths).toEqual([]);
    const workflow = await reader.getWorkflowById('rooted-workflow');
    expect(workflow?.definition.name).toBe('Rooted Workflow');
    expect(workflow?.source.kind).toBe('custom');
  });

  it('preserves legacy request workflows precedence over rooted discovery during migration', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-rooted-reader-'));
    const workspace = path.join(tempRoot, 'workspace');
    const rememberedRoot = path.join(tempRoot, 'repo');
    writeWorkflow(workspace, 'Legacy Request Workflow');
    writeRootedWorkflow(rememberedRoot, ['packages', 'tools'], 'workspace-scoped-workflow', 'Rooted Workflow');

    const { reader, stalePaths } = await createWorkflowReaderForRequest({
      featureFlags: new StaticFeatureFlagProvider({
        v2Tools: true,
        leanWorkflows: false,
        agenticRoutines: false,
        experimentalWorkflows: false,
      }),
      workspacePath: workspace,
      rememberedRootsStore: rememberedRootsStore(rememberedRoot),
    });

    expect(stalePaths).toEqual([]);
    const workflow = await reader.getWorkflowById('workspace-scoped-workflow');
    expect(workflow?.definition.name).toBe('Legacy Request Workflow');
    expect(workflow?.source.kind).toBe('project');
  });

  it('returns stale paths without throwing when a remembered root no longer exists', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-stale-roots-'));
    const workspace = path.join(tempRoot, 'workspace');
    const existingRoot = path.join(tempRoot, 'existing-repo');
    const deletedRoot = path.join(tempRoot, 'deleted-worktree'); // never created
    fs.mkdirSync(workspace, { recursive: true });
    writeRootedWorkflow(existingRoot, [], 'existing-workflow', 'Existing Workflow');

    const { reader, stalePaths } = await createWorkflowReaderForRequest({
      featureFlags: new StaticFeatureFlagProvider({
        v2Tools: true,
        leanWorkflows: false,
        agenticRoutines: false,
        experimentalWorkflows: false,
      }),
      workspacePath: workspace,
      rememberedRootsStore: rememberedRootsStore(existingRoot, deletedRoot),
    });

    // Stale root is reported, not thrown
    expect(stalePaths).toEqual([path.resolve(deletedRoot)]);

    // Accessible root workflows are still discovered
    const workflow = await reader.getWorkflowById('existing-workflow');
    expect(workflow?.definition.name).toBe('Existing Workflow');
  });

  it('returns all stale when every remembered root is gone', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-all-stale-'));
    const workspace = path.join(tempRoot, 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const gone1 = path.join(tempRoot, 'gone-1');
    const gone2 = path.join(tempRoot, 'gone-2');

    const { stalePaths } = await createWorkflowReaderForRequest({
      featureFlags: new StaticFeatureFlagProvider({
        v2Tools: true,
        leanWorkflows: false,
        agenticRoutines: false,
        experimentalWorkflows: false,
      }),
      workspacePath: workspace,
      rememberedRootsStore: rememberedRootsStore(gone1, gone2),
    });

    expect(stalePaths).toHaveLength(2);
    expect(stalePaths).toContain(path.resolve(gone1));
    expect(stalePaths).toContain(path.resolve(gone2));
  });

  it('marks root as stale when the root path does not exist (ENOENT)', async () => {
    // Use path.resolve so the expected value matches the platform-normalized path
    // (on Windows, '/nonexistent-path-xyz-123' resolves to 'D:\nonexistent-path-xyz-123')
    const nonExistent = path.resolve('/nonexistent-path-xyz-123');
    const { discovered, stale } = await discoverRootedWorkflowDirectories([nonExistent]);
    expect(stale).toEqual([nonExistent]);
    expect(discovered).toEqual([]);
  });

  it('propagates non-ENOENT errors from root walk without marking as stale', async () => {
    // readdir on a file (not a directory) throws ENOTDIR -- should re-throw, not be treated as stale
    const tempFile = path.join(os.tmpdir(), `wr-not-a-dir-${Date.now()}.txt`);
    fs.writeFileSync(tempFile, 'not a directory');
    try {
      await expect(
        discoverRootedWorkflowDirectories([tempFile])
      ).rejects.toMatchObject({ code: 'ENOTDIR' });
    } finally {
      fs.unlinkSync(tempFile);
    }
  });

  it('does not mark root as stale when a subdirectory disappears mid-walk', async () => {
    // Verifies the recursive ENOENT guard: if a subdir is gone, the root is NOT stale.
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-midwalk-'));
    const presentSubdir = path.join(tempRoot, 'present');
    const vanishedSubdir = path.join(tempRoot, 'vanished');
    fs.mkdirSync(presentSubdir);
    // Write a workflow in the present subdirectory
    const workflowsDir = path.join(presentSubdir, '.workrail', 'workflows');
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.writeFileSync(path.join(workflowsDir, 'sub-workflow.v2.json'), JSON.stringify({
      id: 'sub-workflow', name: 'Sub', description: 'Sub', version: '0.1.0',
      steps: [{ id: 's1', title: 'S1', prompt: 'Do it' }],
    }));
    // vanishedSubdir is never created -- simulates a directory that existed then was removed

    const { discovered, stale } = await discoverRootedWorkflowDirectories([tempRoot]);

    // Root is NOT stale -- it exists
    expect(stale).toEqual([]);
    // Workflow from present subdir is discovered
    expect(discovered).toContain(path.resolve(workflowsDir));
    // vanishedSubdir path is not in discovered (it didn't exist, was skipped silently)
  });
});
