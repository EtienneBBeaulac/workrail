import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { discoverRootedWorkflowDirectories, clearWalkCacheForTesting } from '../../src/mcp/handlers/shared/request-workflow-reader.js';

/**
 * Latency regression tests for discoverRootedWorkflowDirectories.
 *
 * Purpose: prevent regressions (removing skip list, raising MAX_WALK_DEPTH,
 * reverting to sequential scan) from slipping past CI.
 *
 * Each test uses a unique mkdtemp path so each call uses a different cache key,
 * guaranteeing a cold walk. clearWalkCacheForTesting() in afterEach cleans up
 * any entries written by the test.
 */
describe('[PERF] discoverRootedWorkflowDirectories latency', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    clearWalkCacheForTesting();
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    tempDirs.length = 0;
  });

  async function buildSyntheticTree(root: string, depth: number, breadth: number): Promise<void> {
    if (depth === 0) return;
    const children = Array.from({ length: breadth }, (_, i) => path.join(root, `dir${i}`));
    await Promise.all(
      children.map(async (child) => {
        await fs.mkdir(child, { recursive: true });
        await buildSyntheticTree(child, depth - 1, breadth);
      }),
    );
  }

  it('completes within 500ms on a depth-5 breadth-3 synthetic tree', async () => {
    const treeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workrail-perf-'));
    tempDirs.push(treeRoot);
    await buildSyntheticTree(treeRoot, 5, 3);

    const start = Date.now();
    await discoverRootedWorkflowDirectories([treeRoot]);
    const elapsed = Date.now() - start;

    console.log(`[PERF] depth-5 breadth-3 tree: ${elapsed}ms`);
    expect(elapsed).toBeLessThan(500);
  });

  it('returns empty discovered list when tree has no .workrail directories', async () => {
    const treeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workrail-perf-no-wrkrl-'));
    tempDirs.push(treeRoot);
    await buildSyntheticTree(treeRoot, 3, 2);

    const result = await discoverRootedWorkflowDirectories([treeRoot]);

    expect(result.discovered).toHaveLength(0);
    expect(result.stale).toHaveLength(0);
  });

  it('finds .workrail/workflows under a remembered root within budget', async () => {
    const treeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workrail-perf-with-wrkrl-'));
    tempDirs.push(treeRoot);
    await buildSyntheticTree(treeRoot, 3, 2);

    const workrailDir = path.join(treeRoot, 'dir0', 'dir1', '.workrail', 'workflows');
    await fs.mkdir(workrailDir, { recursive: true });

    const start = Date.now();
    const result = await discoverRootedWorkflowDirectories([treeRoot]);
    const elapsed = Date.now() - start;

    console.log(`[PERF] with .workrail at depth 2: ${elapsed}ms`);
    expect(elapsed).toBeLessThan(500);
    expect(result.discovered).toContain(path.resolve(workrailDir));
  });

  it('skip list gates the budget: walk with large build/ tree completes within 200ms', async () => {
    // This test WOULD fail without the skip list. A build/ tree with 500 dirs
    // at depth 5 takes 500-2000ms without skipping; with SKIP_DIRS it is ~5ms.
    // If shouldSkipDirectory is removed or build/ is dropped, this test fails CI.
    const treeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'workrail-perf-skip-'));
    tempDirs.push(treeRoot);

    // Plant a legitimate .workrail/workflows at root level
    const workrailDir = path.join(treeRoot, '.workrail', 'workflows');
    await fs.mkdir(workrailDir, { recursive: true });

    // Plant a large build/ tree: 5 levels deep, branching factor 5 = 3905 dirs.
    // Without skip list, this dominates the walk time significantly.
    const buildRoot = path.join(treeRoot, 'build');
    await buildSyntheticTree(buildRoot, 5, 5);

    const start = Date.now();
    const result = await discoverRootedWorkflowDirectories([treeRoot]);
    const elapsed = Date.now() - start;

    console.log(`[PERF] tree with large build/ subtree (skip list active): ${elapsed}ms`);
    // Tight budget -- only possible because build/ is skipped entirely.
    expect(elapsed).toBeLessThan(200);
    // The .workrail at root is still found despite the large build/ tree.
    expect(result.discovered).toContain(path.resolve(workrailDir));
    // Nothing from inside build/ was discovered.
    expect(result.discovered.some((d) => d.includes('build'))).toBe(false);
  });
});
