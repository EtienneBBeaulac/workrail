import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GitWorkflowStorage } from '../../src/infrastructure/storage/git-workflow-storage';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { toFileUrl } from '../helpers/platform.js';
import { gitExec } from '../helpers/git-test-utils.js';

/**
 * Test that GitWorkflowStorage handles repos with 'master' branch (not 'main')
 * This is a common scenario with older repositories
 */
describe('GitWorkflowStorage - Master Branch Support', () => {
  const testRepoDir = path.join(os.tmpdir(), 'workrail-master-test-' + Date.now());
  const cacheDir = path.join(testRepoDir, 'cache');

  beforeAll(async () => {
    // Create a test Git repository with master branch
    await fs.mkdir(testRepoDir, { recursive: true });
    await fs.mkdir(path.join(testRepoDir, 'workflows'), { recursive: true });
    
    // Initialize Git repo
    await gitExec(testRepoDir, ['init']);
    await gitExec(testRepoDir, ['config', 'user.email', 'test@test.com']);
    await gitExec(testRepoDir, ['config', 'user.name', 'Test User']);
    
    // Create a workflow
    const testWorkflow = {
      id: 'master-test',
      name: 'Master Branch Test',
      description: 'Test workflow on master branch',
      version: '1.0.0',
      category: 'testing',
      steps: [
        {
          id: 'step-1',
          title: 'Test Step',
          prompt: 'Do something',
          reasoning: 'Testing'
        }
      ],
      validation: {
        criteria: [
          {
            type: 'required_files',
            paths: ['test.txt']
          }
        ]
      }
    };
    
    await fs.writeFile(
      path.join(testRepoDir, 'workflows', 'master-test.json'),
      JSON.stringify(testWorkflow, null, 2)
    );
    
    // Commit on master branch (Git's old default)
    await gitExec(testRepoDir, ['add', '.']);
    await gitExec(testRepoDir, ['commit', '--no-gpg-sign', '-m', 'Add test workflow']);
    // Don't rename to main - keep it as master to test the fallback
  });

  afterAll(async () => {
    if (existsSync(testRepoDir)) {
      await fs.rm(testRepoDir, { recursive: true, force: true });
    }
    if (existsSync(cacheDir)) {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('should auto-detect and clone master branch when main is not found', async () => {
    const storage = new GitWorkflowStorage({
      repositoryUrl: toFileUrl(testRepoDir),
      branch: 'main', // Request main, but repo only has master
      localPath: path.join(cacheDir, 'master-test'),
      skipSandboxCheck: true
    });

    // Should successfully load the workflow despite branch mismatch
    const workflows = await storage.loadAllWorkflows();
    expect(workflows).toHaveLength(1);
    expect(workflows[0]?.definition.id).toBe('master-test');
    expect(workflows[0]?.definition.name).toBe('Master Branch Test');
  }, 15000);

  it('should work with explicit master branch specification', async () => {
    const storage = new GitWorkflowStorage({
      repositoryUrl: toFileUrl(testRepoDir),
      branch: 'master', // Explicitly request master
      localPath: path.join(cacheDir, 'master-test-explicit'),
      skipSandboxCheck: true
    });

    const workflows = await storage.loadAllWorkflows();
    expect(workflows).toHaveLength(1);
    expect(workflows[0]?.definition.id).toBe('master-test');
  }, 15000);
});

