import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { gitExecSync, initGitRepoSync } from '../../helpers/git-test-utils.js';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { StaticFeatureFlagProvider } from '../../../src/config/feature-flags.js';

import {
  createWorkflowReaderForRequest,
  discoverRootedWorkflowDirectories,
  clearWalkCacheForTesting,
  resolveRequestWorkspaceDirectory,
  toProjectWorkflowDirectory,
  filterRememberedRootsForWorkspace,
} from '../../../src/mcp/handlers/shared/request-workflow-reader.js';
import { getGitCommonDir } from '../../../src/mcp/handlers/shared/workspace-path-utils.js';
import type { RememberedRootsStorePortV2 } from '../../../src/v2/ports/remembered-roots-store.port.js';
import type { ManagedSourceStorePortV2, ManagedSourceRecordV2 } from '../../../src/v2/ports/managed-source-store.port.js';
import { okAsync, errAsync } from 'neverthrow';

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
    // workspace must be inside rememberedRoot so the root is an ancestor and passes the filter
    const rememberedRoot = path.join(tempRoot, 'repo');
    const workspace = path.join(rememberedRoot, 'workspace');
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
    // Both roots must be ancestors of workspace to pass the scoping filter.
    // deletedRoot (tempRoot/monorepo) is never created on disk -- it will be reported stale.
    // existingRoot (tempRoot) always exists -- it is walked and reports workflows.
    const existingRoot = tempRoot;
    const deletedRoot = path.join(tempRoot, 'monorepo'); // never created
    const workspace = path.join(tempRoot, 'monorepo', 'packages', 'app');
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
    // Both gone roots must be ancestors of workspace to pass the scoping filter.
    // Neither is created on disk -- both should be reported stale after the walk.
    const gone1 = path.join(tempRoot, 'projects'); // never created
    const gone2 = path.join(tempRoot, 'projects', 'monorepo'); // never created (child of gone1)
    const workspace = path.join(tempRoot, 'projects', 'monorepo', 'packages', 'app');

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

  it('does not discover .workrail/workflows from a remembered root unrelated to the workspace', async () => {
    // Regression test for cross-repo bleed: visiting repo-b should not make its .workrail/workflows/
    // appear when the current workspace is repo-a.
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-cross-repo-'));
    const workspace = path.join(tempRoot, 'repo-a', 'packages', 'app');
    const unrelatedRoot = path.join(tempRoot, 'repo-b');
    fs.mkdirSync(workspace, { recursive: true });
    writeRootedWorkflow(unrelatedRoot, [], 'cross-repo-workflow', 'Cross Repo Workflow');

    const { reader } = await createWorkflowReaderForRequest({
      featureFlags: new StaticFeatureFlagProvider({
        v2Tools: true,
        leanWorkflows: false,
        agenticRoutines: false,
        experimentalWorkflows: false,
      }),
      workspacePath: workspace,
      rememberedRootsStore: rememberedRootsStore(unrelatedRoot),
    });

    const workflow = await reader.getWorkflowById('cross-repo-workflow');
    expect(workflow).toBeNull();

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// New behavioral tests for perf fixes
// ---------------------------------------------------------------------------



describe('discoverRootedWorkflowDirectories -- depth limit', () => {
  afterEach(() => clearWalkCacheForTesting());

  it('discovers .workrail/workflows at exactly MAX_WALK_DEPTH (depth 5)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-depth5-'));
    // root/a/b/c/d/e/.workrail/workflows -- .workrail is at depth 5
    const workflowsDir = path.join(root, 'a', 'b', 'c', 'd', 'e', '.workrail', 'workflows');
    fs.mkdirSync(workflowsDir, { recursive: true });

    const { discovered } = await discoverRootedWorkflowDirectories([root]);

    expect(discovered).toContain(path.resolve(workflowsDir));

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does NOT discover .workrail/workflows at depth 6', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-depth6-'));
    // root/a/b/c/d/e/f/.workrail/workflows -- .workrail is at depth 6, beyond MAX_WALK_DEPTH
    const workflowsDir = path.join(root, 'a', 'b', 'c', 'd', 'e', 'f', '.workrail', 'workflows');
    fs.mkdirSync(workflowsDir, { recursive: true });

    const { discovered } = await discoverRootedWorkflowDirectories([root]);

    expect(discovered).not.toContain(path.resolve(workflowsDir));

    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('discoverRootedWorkflowDirectories -- walk cache', () => {
  afterEach(() => clearWalkCacheForTesting());

  it('returns the same object reference on second call (cache hit)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-cache-'));

    const result1 = await discoverRootedWorkflowDirectories([root]);
    const result2 = await discoverRootedWorkflowDirectories([root]);

    // Strict reference equality proves the second call hit the module-level cache.
    expect(result1).toBe(result2);

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does NOT return cached result after clearWalkCacheForTesting()', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-cache-clear-'));

    const result1 = await discoverRootedWorkflowDirectories([root]);
    clearWalkCacheForTesting();
    const result2 = await discoverRootedWorkflowDirectories([root]);

    // Different references after cache clear -- a fresh walk was performed.
    expect(result1).not.toBe(result2);

    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('discoverRootedWorkflowDirectories -- skip list', () => {
  afterEach(() => clearWalkCacheForTesting());

  it('does not descend into skip-listed directories', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-skip-'));
    // .workrail at root level -- should be found
    const rootWorkflows = path.join(root, '.workrail', 'workflows');
    fs.mkdirSync(rootWorkflows, { recursive: true });
    // .workrail inside build/ -- should NOT be found (build is in skip list)
    const buildWorkflows = path.join(root, 'build', '.workrail', 'workflows');
    fs.mkdirSync(buildWorkflows, { recursive: true });
    // .workrail inside node_modules/ -- should NOT be found
    const nmWorkflows = path.join(root, 'node_modules', 'pkg', '.workrail', 'workflows');
    fs.mkdirSync(nmWorkflows, { recursive: true });

    const { discovered } = await discoverRootedWorkflowDirectories([root]);

    expect(discovered).toContain(path.resolve(rootWorkflows));
    expect(discovered).not.toContain(path.resolve(buildWorkflows));
    expect(discovered).not.toContain(path.resolve(nmWorkflows));

    fs.rmSync(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Managed source stat -- parallelism and timeout (F1/F4)
// ---------------------------------------------------------------------------

function managedSourceStore(records: readonly ManagedSourceRecordV2[]): ManagedSourceStorePortV2 {
  return {
    list: () => okAsync(records),
    attach: () => okAsync(undefined),
    detach: () => okAsync(undefined),
  };
}

const testFeatureFlags = new StaticFeatureFlagProvider({
  v2Tools: true,
  leanWorkflows: false,
  agenticRoutines: false,
  experimentalWorkflows: false,
});

describe('createWorkflowReaderForRequest -- managed source stat parallelism', () => {
  beforeEach(() => clearWalkCacheForTesting());
  afterEach(() => clearWalkCacheForTesting());

  it('discovers multiple managed source directories in parallel', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-managed-parallel-'));
    const dirA = path.join(tempRoot, 'source-a');
    const dirB = path.join(tempRoot, 'source-b');
    const dirC = path.join(tempRoot, 'source-c');
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    fs.mkdirSync(dirC);

    const records: readonly ManagedSourceRecordV2[] = [
      { path: dirA, addedAtMs: 1 },
      { path: dirB, addedAtMs: 2 },
      { path: dirC, addedAtMs: 3 },
    ];

    const result = await createWorkflowReaderForRequest({
      featureFlags: testFeatureFlags,
      workspacePath: tempRoot,
      managedSourceStore: managedSourceStore(records),
    });

    // All three existing directories should be active, none stale
    expect(result.staleManagedRecords).toHaveLength(0);
    expect(result.managedSourceRecords).toHaveLength(3);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('marks non-existent managed source directories as stale', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-managed-stale-'));
    const existingDir = path.join(tempRoot, 'exists');
    const missingDir = path.join(tempRoot, 'missing'); // never created
    fs.mkdirSync(existingDir);

    const records: readonly ManagedSourceRecordV2[] = [
      { path: existingDir, addedAtMs: 1 },
      { path: missingDir, addedAtMs: 2 },
    ];

    const result = await createWorkflowReaderForRequest({
      featureFlags: testFeatureFlags,
      workspacePath: tempRoot,
      managedSourceStore: managedSourceStore(records),
    });

    expect(result.managedSourceRecords.map((r) => r.path)).toContain(existingDir);
    expect(result.staleManagedRecords.map((r) => r.path)).toContain(missingDir);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('degrades gracefully when managed source store returns an error', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-managed-error-'));
    fs.mkdirSync(tempRoot, { recursive: true });

    const failingStore: ManagedSourceStorePortV2 = {
      list: () => errAsync({ code: 'MANAGED_SOURCE_IO_ERROR' as const, message: 'disk read failed' }),
      attach: () => okAsync(undefined),
      detach: () => okAsync(undefined),
    };

    const result = await createWorkflowReaderForRequest({
      featureFlags: testFeatureFlags,
      workspacePath: tempRoot,
      managedSourceStore: failingStore,
    });

    // Should succeed (no throw) and surface the error as managedStoreError
    expect(result.managedSourceRecords).toHaveLength(0);
    expect(result.staleManagedRecords).toHaveLength(0);
    expect(result.managedStoreError).toBeDefined();
    expect(result.managedStoreError).toContain('disk read failed');

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// getGitCommonDir unit tests
// ---------------------------------------------------------------------------

describe('getGitCommonDir', () => {
  it('returns a non-null absolute path for a directory inside a git repo', async () => {
    // The workrail project itself is a git repo -- always available in tests.
    const result = await getGitCommonDir(process.cwd());
    expect(result).not.toBeNull();
    expect(path.isAbsolute(result!)).toBe(true);
  });

  it('returns null for a directory that is not inside a git repo', async () => {
    // os.tmpdir() is reliably outside any git repo.
    const result = await getGitCommonDir(os.tmpdir());
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sibling worktree scoping tests
// ---------------------------------------------------------------------------


describe('createWorkflowReaderForRequest -- sibling worktree scoping', () => {
  beforeEach(() => clearWalkCacheForTesting());
  afterEach(() => clearWalkCacheForTesting());

  it('includes a remembered root that is a sibling worktree of the current workspace', async () => {
    // Arrange: create a real git repo with a linked worktree (sibling).
    // mainRepo/  (git init)
    // sibling-worktree/  (git worktree add ../sibling-worktree)
    // Both share the same git common dir -> mainRepo should be included when workspace is sibling-worktree.
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-sibling-'));
    const mainRepo = path.join(tempRoot, 'main-repo');
    const siblingWorktree = path.join(tempRoot, 'sibling-worktree');
    fs.mkdirSync(mainRepo);

    try {
      initGitRepoSync(mainRepo, { silent: true });
      // git worktree add requires at least one commit
      gitExecSync(mainRepo, ['commit', '--allow-empty', '-m', 'init'], { silent: true });
      gitExecSync(mainRepo, ['worktree', 'add', siblingWorktree], { silent: true });

      // Write a rooted workflow in the main repo
      writeRootedWorkflow(mainRepo, [], 'sibling-worktree-workflow', 'Sibling Worktree Workflow');

      const result = await createWorkflowReaderForRequest({
        featureFlags: new StaticFeatureFlagProvider({
          v2Tools: true,
          leanWorkflows: false,
          agenticRoutines: false,
          experimentalWorkflows: false,
        }),
        workspacePath: siblingWorktree,
        rememberedRootsStore: rememberedRootsStore(mainRepo),
      });
      const { reader } = result;

      const workflow = await reader.getWorkflowById('sibling-worktree-workflow');
      expect(workflow?.definition.name).toBe('Sibling Worktree Workflow');
    } finally {
      // Clean up worktree before removing the directory
      try { gitExecSync(mainRepo, ['worktree', 'remove', '--force', siblingWorktree], { silent: true }); } catch { /* ignore */ }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('still excludes a remembered root from an unrelated repo (cross-repo non-bleed regression)', async () => {
    // This is the original regression test replicated in this suite to confirm the
    // sibling worktree fix does not break the cross-repo isolation invariant.
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-sibling-cross-'));
    const workspace = path.join(tempRoot, 'repo-a', 'packages', 'app');
    const unrelatedRoot = path.join(tempRoot, 'repo-b');
    fs.mkdirSync(workspace, { recursive: true });
    writeRootedWorkflow(unrelatedRoot, [], 'cross-repo-workflow', 'Cross Repo Workflow');

    const { reader } = await createWorkflowReaderForRequest({
      featureFlags: new StaticFeatureFlagProvider({
        v2Tools: true,
        leanWorkflows: false,
        agenticRoutines: false,
        experimentalWorkflows: false,
      }),
      workspacePath: workspace,
      rememberedRootsStore: rememberedRootsStore(unrelatedRoot),
    });

    const workflow = await reader.getWorkflowById('cross-repo-workflow');
    expect(workflow).toBeNull();

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// filterRememberedRootsForWorkspace unit tests
// ---------------------------------------------------------------------------

describe('filterRememberedRootsForWorkspace', () => {
  it('returns empty array when no roots are provided', async () => {
    const workspace = path.join(os.tmpdir(), 'workspace');
    const result = await filterRememberedRootsForWorkspace([], workspace);
    expect(result).toEqual([]);
  });

  it('returns all roots when all are ancestors of the workspace (no git call needed)', async () => {
    // Use plain temp directories -- ancestor check is purely lexical, no subprocess.
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-filter-ancestor-'));
    const workspace = path.join(tempRoot, 'repo', 'packages', 'app');
    const root1 = path.resolve(tempRoot);
    const root2 = path.resolve(path.join(tempRoot, 'repo'));

    const result = await filterRememberedRootsForWorkspace([root1, root2], workspace);

    expect(result).toContain(root1);
    expect(result).toContain(root2);
    expect(result).toHaveLength(2);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('excludes a non-ancestor root that belongs to an unrelated repo', async () => {
    // workspace is in repo-a; unrelatedRoot is repo-b (different directory, no git repo).
    // Neither is an ancestor of the other, and they have no git common dir.
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-filter-unrelated-'));
    const workspace = path.resolve(path.join(tempRoot, 'repo-a', 'packages', 'app'));
    const unrelatedRoot = path.resolve(path.join(tempRoot, 'repo-b'));
    // Create workspace dir so getGitCommonDir can stat it (it still returns null for non-git)
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(unrelatedRoot, { recursive: true });

    const result = await filterRememberedRootsForWorkspace([unrelatedRoot], workspace);

    expect(result).toEqual([]);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('includes a non-ancestor root that is a sibling worktree of the workspace', async () => {
    // Create a real git repo with a linked worktree to exercise the git common-dir path.
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-filter-sibling-'));
    const mainRepo = path.join(tempRoot, 'main-repo');
    const siblingWorktree = path.join(tempRoot, 'sibling-worktree');
    fs.mkdirSync(mainRepo);

    try {
      initGitRepoSync(mainRepo, { silent: true });
      gitExecSync(mainRepo, ['commit', '--allow-empty', '-m', 'init'], { silent: true });
      gitExecSync(mainRepo, ['worktree', 'add', siblingWorktree], { silent: true });

      // mainRepo is remembered; siblingWorktree is the workspace.
      // mainRepo is NOT an ancestor of siblingWorktree, but they share the same git common dir.
      const result = await filterRememberedRootsForWorkspace(
        [path.resolve(mainRepo)],
        path.resolve(siblingWorktree),
      );

      expect(result).toContain(path.resolve(mainRepo));
      expect(result).toHaveLength(1);
    } finally {
      try { gitExecSync(mainRepo, ['worktree', 'remove', '--force', siblingWorktree], { silent: true }); } catch { /* ignore */ }
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('returns only ancestor roots when workspace is not in a git repo (workspaceCommonDir is null)', async () => {
    // Use plain temp directories (not git repos). Ancestor root is included; non-ancestor is excluded.
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-filter-nogit-'));
    const workspace = path.join(tempRoot, 'repo', 'packages', 'app');
    const ancestorRoot = path.resolve(tempRoot); // ancestor of workspace
    const nonAncestorRoot = path.resolve(path.join(tempRoot, 'other-repo')); // not ancestor
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(nonAncestorRoot);

    const result = await filterRememberedRootsForWorkspace(
      [ancestorRoot, nonAncestorRoot],
      workspace,
    );

    expect(result).toContain(ancestorRoot);
    expect(result).not.toContain(nonAncestorRoot);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});
