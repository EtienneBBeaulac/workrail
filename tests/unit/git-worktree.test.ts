/**
 * Unit Tests: Git Worktree Support
 * 
 * Tests that the git worktree detection logic works correctly.
 * These tests focus on the pure utility functions without requiring
 * full DI container setup.
 */

import 'reflect-metadata';
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { initializeContainer, resetContainer, container } from '../../src/di/container';
import { DI } from '../../src/di/tokens';
import { SessionManager } from '../../src/infrastructure/session/SessionManager';
import { execSync } from 'child_process';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';

/**
 * Test utility: Generate project ID the same way SessionManager does
 */
function hashProjectPath(projectPath: string): string {
  return createHash('sha256')
    .update(path.resolve(projectPath))
    .digest('hex')
    .substring(0, 12);
}

/**
 * Test utility: Find git repo root
 */
function findGitRepoRoot(startPath: string): string | null {
  try {
    const result = execSync('git rev-parse --show-toplevel', {
      cwd: startPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();
    return result;
  } catch {
    return null;
  }
}

describe('Git Worktree Detection Logic', () => {
  let tempDir: string;
  let mainRepo: string;
  let worktree1: string;
  let worktree2: string;
  
  beforeEach(async () => {
    // Create temporary directory structure
    tempDir = path.join(os.tmpdir(), `workrail-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    
    mainRepo = path.join(tempDir, 'main-repo');
    worktree1 = path.join(tempDir, 'worktree-feature');
    worktree2 = path.join(tempDir, 'worktree-hotfix');
    
    // Initialize main repository
    await fs.mkdir(mainRepo);
    execSync('git init', { cwd: mainRepo, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: mainRepo, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: mainRepo, stdio: 'ignore' });
    
    // Create initial commit
    await fs.writeFile(path.join(mainRepo, 'README.md'), '# Test');
    execSync('git add .', { cwd: mainRepo, stdio: 'ignore' });
    execSync('git commit -m "Initial commit"', { cwd: mainRepo, stdio: 'ignore' });
    
    // Create worktrees
    execSync(`git worktree add ${worktree1} -b feature`, { cwd: mainRepo, stdio: 'ignore' });
    execSync(`git worktree add ${worktree2} -b hotfix`, { cwd: mainRepo, stdio: 'ignore' });
  });
  
  afterEach(async () => {
    // Clean up
    try {
      // Remove worktrees first
      execSync('git worktree remove --force ' + worktree1, { cwd: mainRepo, stdio: 'ignore' });
      execSync('git worktree remove --force ' + worktree2, { cwd: mainRepo, stdio: 'ignore' });
      execSync('git worktree prune', { cwd: mainRepo, stdio: 'ignore' });
    } catch {}
    
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {}
  });
  
  it('should detect main repo as git root', () => {
    const gitRoot = findGitRepoRoot(mainRepo);
    // Use realpath to handle macOS /private symlink
    expect(fsSync.realpathSync(gitRoot!)).toBe(fsSync.realpathSync(mainRepo));
  });
  
  it('should detect worktrees as valid git repositories', () => {
    // Each worktree should be detected as a git repository
    const root1 = findGitRepoRoot(worktree1);
    const root2 = findGitRepoRoot(worktree2);
    
    // Note: git rev-parse returns the worktree path, not the main repo
    // SessionManager has additional logic to resolve to main repo
    expect(root1).not.toBeNull();
    expect(root2).not.toBeNull();
  });
  
  it('should generate different IDs for worktrees using only git rev-parse', () => {
    // This test verifies that git rev-parse alone doesn't unify worktrees
    // SessionManager adds additional logic to resolve worktrees to main repo
    const mainRepoRoot = findGitRepoRoot(mainRepo);
    const worktree1Root = findGitRepoRoot(worktree1);
    const worktree2Root = findGitRepoRoot(worktree2);
    
    // git rev-parse returns paths that resolve to the same location
    // (macOS may add /private prefix, so we compare resolved paths)
    expect(fsSync.realpathSync(mainRepoRoot!)).toBe(fsSync.realpathSync(mainRepo));
    expect(fsSync.realpathSync(worktree1Root!)).toBe(fsSync.realpathSync(worktree1));
    expect(fsSync.realpathSync(worktree2Root!)).toBe(fsSync.realpathSync(worktree2));
    
    // Without SessionManager's additional logic, IDs would be different
    const id1 = hashProjectPath(mainRepoRoot!);
    const id2 = hashProjectPath(worktree1Root!);
    const id3 = hashProjectPath(worktree2Root!);
    
    // These would be different without SessionManager's worktree resolution
    expect(id1).not.toBe(id2);
    expect(id2).not.toBe(id3);
  });
  
  it('should handle non-Git directories gracefully', async () => {
    const nonGitDir = path.join(tempDir, 'non-git');
    await fs.mkdir(nonGitDir, { recursive: true });
    
    const gitRoot = findGitRepoRoot(nonGitDir);
    expect(gitRoot).toBeNull();
  });
  
  it('should generate deterministic project IDs', () => {
    const id1 = hashProjectPath(mainRepo);
    const id2 = hashProjectPath(mainRepo);
    
    // Same path should always generate same ID
    expect(id1).toBe(id2);
  });
  
  it('should generate different project IDs for different repos', async () => {
    const otherRepo = path.join(tempDir, 'other-repo');
    await fs.mkdir(otherRepo, { recursive: true });
    execSync('git init', { cwd: otherRepo, stdio: 'ignore' });
    
    const id1 = hashProjectPath(mainRepo);
    const id2 = hashProjectPath(otherRepo);
    
    // Different paths should generate different IDs
    expect(id1).not.toBe(id2);
  });
});

describe('Project ID Generation', () => {
  it('should resolve relative paths to absolute', () => {
    const relativePath = '.';
    const absolutePath = process.cwd();
    
    const id1 = hashProjectPath(relativePath);
    const id2 = hashProjectPath(absolutePath);
    
    // Both should resolve to the same absolute path
    expect(id1).toBe(id2);
  });
  
  it('should normalize paths with trailing slashes', () => {
    const testPath = '/tmp/test-project-normalize';
    
    const id1 = hashProjectPath(testPath);
    const id2 = hashProjectPath(testPath + '/');
    
    // path.resolve removes trailing slashes, so these should be equal
    expect(id1).toBe(id2);
  });
  
  it('should generate 12-character hex project IDs', () => {
    const projectId = hashProjectPath('/tmp/test');
    
    expect(projectId).toMatch(/^[a-f0-9]{12}$/);
    expect(projectId.length).toBe(12);
  });
});

describe('SessionManager Git Integration', () => {
  let sessionManager: SessionManager;
  
  beforeAll(async () => {
    await initializeContainer();
    sessionManager = container.resolve<SessionManager>(DI.Infra.SessionManager);
  });
  
  afterAll(() => {
    resetContainer();
  });
  
  it('should return valid project ID', () => {
    const projectId = sessionManager.getProjectId();
    
    expect(projectId).toMatch(/^[a-f0-9]{12}$/);
    expect(projectId.length).toBe(12);
  });
  
  it('should return valid project path', () => {
    const projectPath = sessionManager.getProjectPath();
    
    expect(typeof projectPath).toBe('string');
    expect(projectPath.length).toBeGreaterThan(0);
    expect(path.isAbsolute(projectPath)).toBe(true);
  });
  
  it('should return valid sessions root', () => {
    const sessionsRoot = sessionManager.getSessionsRoot();
    
    expect(typeof sessionsRoot).toBe('string');
    expect(sessionsRoot).toContain('.workrail');
    expect(sessionsRoot).toContain('sessions');
  });
});
