import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { GitWorkflowStorage } from '../../src/infrastructure/storage/git-workflow-storage';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Integration tests for Git-based workflow storage
 * These tests use a real test repository
 */

describe('GitWorkflowStorage Integration', () => {
  const testDir = path.join(os.tmpdir(), 'workrail-git-test-' + Date.now());
  const cacheDir = path.join(testDir, 'cache');
  
  // We'll create a local test Git repository
  const testRepoDir = path.join(testDir, 'test-repo');

  beforeAll(async () => {
    // Create test directory
    await fs.mkdir(testDir, { recursive: true });
    
    // Create a test Git repository
    await fs.mkdir(testRepoDir, { recursive: true });
    await fs.mkdir(path.join(testRepoDir, 'workflows'), { recursive: true });
    
    // Initialize Git repo
    await execAsync('git init', { cwd: testRepoDir });
    await execAsync('git config user.email "test@test.com"', { cwd: testRepoDir });
    await execAsync('git config user.name "Test User"', { cwd: testRepoDir });
    
    // Create a test workflow
    const testWorkflow = {
      id: 'test-workflow',
      name: 'Test Workflow',
      description: 'A test workflow',
      version: '1.0.0',
      steps: [
        {
          id: 'step-1',
          title: 'Test Step',
          prompt: 'Do something'
        }
      ]
    };
    
    await fs.writeFile(
      path.join(testRepoDir, 'workflows', 'test-workflow.json'),
      JSON.stringify(testWorkflow, null, 2)
    );
    
    // Commit the workflow
    await execAsync('git add .', { cwd: testRepoDir });
    await execAsync('git commit -m "Initial commit"', { cwd: testRepoDir });
    await execAsync('git branch -M main', { cwd: testRepoDir });
  });

  afterAll(async () => {
    // Clean up test directory
    if (existsSync(testDir)) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  beforeEach(async () => {
    // Clear cache directory before each test
    if (existsSync(cacheDir)) {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
    await fs.mkdir(cacheDir, { recursive: true });
  });

  describe('Local Repository Cloning', () => {
    it('should clone a local Git repository', async () => {
      const storage = new GitWorkflowStorage({
        repositoryUrl: testRepoDir,
        branch: 'main',
        localPath: path.join(cacheDir, 'local-test')
      });

      const workflows = await storage.loadAllWorkflows();

      expect(workflows).toHaveLength(1);
      expect(workflows[0]?.definition.id).toBe('test-workflow');
      expect(workflows[0]?.definition.name).toBe('Test Workflow');
    });

    it('should load workflows from cloned repository', async () => {
      const storage = new GitWorkflowStorage({
        repositoryUrl: testRepoDir,
        branch: 'main',
        localPath: path.join(cacheDir, 'workflow-test')
      });

      const summaries = await storage.listWorkflowSummaries();

      expect(summaries).toHaveLength(1);
      expect(summaries[0]?.id).toBe('test-workflow');
      expect(summaries[0]?.source.kind).toBe('git');
    });

    it('should get specific workflow by ID', async () => {
      const storage = new GitWorkflowStorage({
        repositoryUrl: testRepoDir,
        branch: 'main',
        localPath: path.join(cacheDir, 'get-test')
      });

      const workflow = await storage.getWorkflowById('test-workflow');

      expect(workflow).not.toBeNull();
      expect(workflow?.definition.id).toBe('test-workflow');
      expect(workflow?.definition.steps).toHaveLength(1);
    });

    it('should return null for non-existent workflow', async () => {
      const storage = new GitWorkflowStorage({
        repositoryUrl: testRepoDir,
        branch: 'main',
        localPath: path.join(cacheDir, 'null-test')
      });

      const workflow = await storage.getWorkflowById('non-existent');

      expect(workflow).toBeNull();
    });
  });

  describe('Caching and Offline Support', () => {
    it('should work offline after initial clone', async () => {
      const localPath = path.join(cacheDir, 'offline-test');
      
      // First load - clones the repo
      const storage1 = new GitWorkflowStorage({
        repositoryUrl: testRepoDir,
        branch: 'main',
        localPath,
        syncInterval: 9999 // Very long interval
      });

      const workflows1 = await storage1.loadAllWorkflows();
      expect(workflows1).toHaveLength(1);

      // Second load - uses cached clone (even with invalid URL)
      const storage2 = new GitWorkflowStorage({
        repositoryUrl: 'https://invalid-url-that-does-not-exist.com/repo.git',
        branch: 'main',
        localPath, // Same local path
        syncInterval: 9999
      });

      const workflows2 = await storage2.loadAllWorkflows();
      expect(workflows2).toHaveLength(1);
      expect(workflows2[0]?.definition.id).toBe('test-workflow');
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid repository URL', async () => {
      const storage = new GitWorkflowStorage({
        repositoryUrl: 'https://github.com/nonexistent/repo-that-does-not-exist.git',
        branch: 'main',
        localPath: path.join(cacheDir, 'error-test'),
        syncInterval: 0 // Force immediate sync
      });

      // Should throw a StorageError
      await expect(storage.loadAllWorkflows()).rejects.toThrow();
    });

    it('should handle invalid branch name by falling back to default', async () => {
      const storage = new GitWorkflowStorage({
        repositoryUrl: testRepoDir,
        branch: 'nonexistent-branch',
        localPath: path.join(cacheDir, 'branch-error-test')
      });

      // GitWorkflowStorage now gracefully falls back to default branch when requested branch doesn't exist
      const workflows = await storage.loadAllWorkflows();
      expect(workflows).toHaveLength(1);
      expect(workflows[0]?.definition.id).toBe('test-workflow');
    });

    it('should accept any valid HTTPS URL with proper structure', () => {
      // Now accepts any properly-formed HTTPS URL to support self-hosted Git servers
      expect(() => new GitWorkflowStorage({
        repositoryUrl: 'https://custom-git-host.example.com/org/repo.git',
        branch: 'main'
      })).not.toThrow();
    });

    it('should accept whitelisted Git hosts', () => {
      // Should accept common hosts
      const validHosts = [
        'https://github.com/org/repo.git',
        'https://gitlab.com/org/repo.git',
        'https://bitbucket.org/org/repo.git'
      ];

      for (const url of validHosts) {
        expect(() => new GitWorkflowStorage({
          repositoryUrl: url,
          branch: 'main'
        })).not.toThrow();
      }
    });

    it('should accept SSH URLs', () => {
      // SSH URLs should be accepted
      const sshUrls = [
        'git@github.com:org/repo.git',
        'ssh://git@gitlab.com/org/repo.git',
        'git@git.company.com:repo.git'
      ];

      for (const url of sshUrls) {
        expect(() => new GitWorkflowStorage({
          repositoryUrl: url,
          branch: 'main'
        })).not.toThrow();
      }
    });
  });

  describe('Multiple Workflows', () => {
    it('should handle repository with multiple workflows', async () => {
      // Add another workflow to test repo
      const workflow2 = {
        id: 'second-workflow',
        name: 'Second Workflow',
        description: 'Another test',
        version: '1.0.0',
        steps: [
          {
            id: 'step-1',
            title: 'Second Step',
            prompt: 'Do something else'
          }
        ]
      };

      await fs.writeFile(
        path.join(testRepoDir, 'workflows', 'second-workflow.json'),
        JSON.stringify(workflow2, null, 2)
      );

      await execAsync('git add .', { cwd: testRepoDir });
      await execAsync('git commit -m "Add second workflow"', { cwd: testRepoDir });

      const storage = new GitWorkflowStorage({
        repositoryUrl: testRepoDir,
        branch: 'main',
        localPath: path.join(cacheDir, 'multi-test')
      });

      const workflows = await storage.loadAllWorkflows();

      expect(workflows.length).toBeGreaterThanOrEqual(2);
      expect(workflows.some(w => w.definition.id === 'test-workflow')).toBe(true);
      expect(workflows.some(w => w.definition.id === 'second-workflow')).toBe(true);
    });
  });

  describe('File Size Limits', () => {
    it('should reject files that exceed maxFileSize setting', async () => {
      // Create a very large workflow (over default limit)
      const largeWorkflow = {
        id: 'large-workflow',
        name: 'Large Workflow',
        description: 'A' + 'x'.repeat(2 * 1024 * 1024), // 2MB description
        version: '1.0.0',
        steps: [{ id: 's1', title: 'Step', prompt: 'Do' }]
      };

      await fs.writeFile(
        path.join(testRepoDir, 'workflows', 'large-workflow.json'),
        JSON.stringify(largeWorkflow, null, 2)
      );

      await execAsync('git add .', { cwd: testRepoDir });
      await execAsync('git commit -m "Add large workflow"', { cwd: testRepoDir });

      const storage = new GitWorkflowStorage({
        repositoryUrl: testRepoDir,
        branch: 'main',
        localPath: path.join(cacheDir, 'size-test'),
        maxFileSize: 1024 * 1024 // 1MB limit
      });

      // Should throw SecurityError for file exceeding size limit
      await expect(storage.loadAllWorkflows()).rejects.toThrow(/File exceeds size limit/);
    });
  });
});

describe('GitWorkflowStorage URL Formats', () => {
  it('should detect SSH URLs correctly', () => {
    const sshUrls = [
      'git@github.com:org/repo.git',
      'git@gitlab.com:user/project.git',
      'ssh://git@github.com/org/repo.git',
      'git@git.company.com:path/to/repo.git'
    ];

    // All should be accepted as valid
    for (const url of sshUrls) {
      expect(() => new GitWorkflowStorage({
        repositoryUrl: url,
        branch: 'main'
      })).not.toThrow();
    }
  });

  it('should detect HTTPS URLs correctly', () => {
    const httpsUrls = [
      'https://github.com/org/repo.git',
      'https://gitlab.com/user/project.git',
      'https://bitbucket.org/team/repo.git'
    ];

    for (const url of httpsUrls) {
      expect(() => new GitWorkflowStorage({
        repositoryUrl: url,
        branch: 'main'
      })).not.toThrow();
    }
  });
});

