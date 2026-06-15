import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { copyWorkspace, linkAllNodeModules, cleanupSandbox, findGitRoot } from '../../src/daemon/tools/spawn-agent.js';

describe('Out-of-Tree Copy Sandbox Integration Tests', () => {
  const tempTestDir = path.join(os.tmpdir(), 'workrail-sandbox-tests-' + Math.random().toString(36).substring(2));

  beforeEach(async () => {
    await fs.mkdir(tempTestDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tempTestDir, { recursive: true, force: true });
    } catch {}
  });

  it('should find git root correctly', async () => {
    const gitDir = path.join(tempTestDir, 'repo');
    const subDir = path.join(gitDir, 'packages', 'app');
    await fs.mkdir(path.join(gitDir, '.git'), { recursive: true });
    await fs.mkdir(subDir, { recursive: true });

    const root = await findGitRoot(subDir);
    expect(root).toBe(path.resolve(gitDir));
  });

  it('should copy workspace excluding build artifacts and node_modules under 500ms', async () => {
    const srcDir = path.join(tempTestDir, 'src-workspace');
    const destDir = path.join(tempTestDir, 'dest-workspace');

    await fs.mkdir(srcDir, { recursive: true });
    await fs.mkdir(path.join(srcDir, '.git'), { recursive: true });
    await fs.mkdir(path.join(srcDir, 'node_modules'), { recursive: true });
    await fs.mkdir(path.join(srcDir, 'dist'), { recursive: true });

    await fs.writeFile(path.join(srcDir, 'index.ts'), 'console.log("hello");');
    await fs.writeFile(path.join(srcDir, 'package.json'), '{}');
    await fs.writeFile(path.join(srcDir, 'node_modules', 'some-pkg.js'), 'module.exports = {}');
    await fs.writeFile(path.join(srcDir, 'dist', 'bundle.js'), 'console.log("bundle");');

    const start = Date.now();
    await copyWorkspace(srcDir, destDir);
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(500);

    // Verify correct files were copied
    expect(await fs.stat(path.join(destDir, 'index.ts')).then(() => true).catch(() => false)).toBe(true);
    expect(await fs.stat(path.join(destDir, 'package.json')).then(() => true).catch(() => false)).toBe(true);

    // Verify excluded files were not copied
    expect(await fs.stat(path.join(destDir, '.git')).then(() => true).catch(() => false)).toBe(false);
    expect(await fs.stat(path.join(destDir, 'node_modules')).then(() => true).catch(() => false)).toBe(false);
    expect(await fs.stat(path.join(destDir, 'dist')).then(() => true).catch(() => false)).toBe(false);
  });

  it('should link node_modules using symlinks or junctions', async () => {
    const srcDir = path.join(tempTestDir, 'src-modules');
    const destDir = path.join(tempTestDir, 'dest-modules');

    await fs.mkdir(path.join(srcDir, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(srcDir, 'node_modules', 'test.txt'), 'node_modules content');

    // Create a mock structure in destDir
    await fs.mkdir(destDir, { recursive: true });

    await linkAllNodeModules(srcDir, destDir);

    const destLink = path.join(destDir, 'node_modules');
    const lstat = await fs.lstat(destLink);
    expect(lstat.isSymbolicLink() || lstat.isDirectory()).toBe(true);

    // Verify content resolves through the link
    const content = await fs.readFile(path.join(destLink, 'test.txt'), 'utf8');
    expect(content).toBe('node_modules content');
  });

  it('should safely clean up sandbox without deleting host directories', async () => {
    const hostDir = path.join(tempTestDir, 'host');
    const sandboxDir = path.join(tempTestDir, 'sandbox');

    await fs.mkdir(path.join(hostDir, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(hostDir, 'node_modules', 'essential.txt'), 'DONT DELETE ME');

    await fs.mkdir(sandboxDir, { recursive: true });
    await fs.writeFile(path.join(sandboxDir, 'test.ts'), 'sandbox code');

    // Link host node_modules into sandbox
    try {
      await fs.symlink(path.join(hostDir, 'node_modules'), path.join(sandboxDir, 'node_modules'), 'dir');
    } catch {
      await fs.symlink(path.join(hostDir, 'node_modules'), path.join(sandboxDir, 'node_modules'), 'junction');
    }

    // Run cleanup
    await cleanupSandbox(sandboxDir);

    // Verify sandbox is deleted
    expect(await fs.stat(sandboxDir).then(() => true).catch(() => false)).toBe(false);

    // Verify host node_modules and its contents are intact!
    expect(await fs.stat(path.join(hostDir, 'node_modules')).then(() => true).catch(() => false)).toBe(true);
    expect(await fs.readFile(path.join(hostDir, 'node_modules', 'essential.txt'), 'utf8')).toBe('DONT DELETE ME');
  });
});
