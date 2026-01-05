import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createEnhancedMultiSourceWorkflowStorage } from '../../src/infrastructure/storage/enhanced-multi-source-workflow-storage';
import { GitWorkflowStorage } from '../../src/infrastructure/storage/git-workflow-storage';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { gitExec } from '../helpers/git-test-utils.js';

/**
 * REAL INTEGRATION TESTS - No mocking, no excuses
 * These tests create actual Git repositories and prove the feature works
 */

describe('External Workflows - REAL Integration Tests', () => {
  const testRootDir = path.join(os.tmpdir(), 'workrail-real-test-' + Date.now());
  const repo1Dir = path.join(testRootDir, 'repo1');
  const repo2Dir = path.join(testRootDir, 'repo2');
  const repo3Dir = path.join(testRootDir, 'repo3-self-hosted');
  const cacheDir = path.join(testRootDir, 'cache');

  async function createRealGitRepo(repoDir: string, workflowId: string, workflowName: string) {
    await fs.mkdir(path.join(repoDir, 'workflows'), { recursive: true });
    
    // Create actual Git repo
    await gitExec(repoDir, ['init']);
    await gitExec(repoDir, ['config', 'user.email', 'test@test.com']);
    await gitExec(repoDir, ['config', 'user.name', 'Test User']);
    
    // Create real workflow file
    const workflow = {
      id: workflowId,
      name: workflowName,
      description: `Real workflow from ${repoDir}`,
      version: '1.0.0',
      steps: [
        {
          id: 'step-1',
          title: 'Real Step',
          prompt: 'This is a real workflow that was actually cloned'
        }
      ]
    };
    
    await fs.writeFile(
      path.join(repoDir, 'workflows', `${workflowId}.json`),
      JSON.stringify(workflow, null, 2)
    );
    
    // Commit it
    await gitExec(repoDir, ['add', '.']);
    await gitExec(repoDir, ['commit', '--no-gpg-sign', '-m', 'Add workflow']);
    await gitExec(repoDir, ['branch', '-M', 'main']);
  }

  beforeAll(async () => {
    console.log('🔧 Setting up REAL Git repositories...');
    await fs.mkdir(testRootDir, { recursive: true });
    
    // Create 3 real Git repos
    await createRealGitRepo(repo1Dir, 'github-workflow', 'GitHub Workflow');
    await createRealGitRepo(repo2Dir, 'gitlab-workflow', 'GitLab Workflow');
    await createRealGitRepo(repo3Dir, 'selfhosted-workflow', 'Self-Hosted Workflow');
    
    console.log('✅ Real Git repositories created');
  });

  afterAll(async () => {
    if (existsSync(testRootDir)) {
      await fs.rm(testRootDir, { recursive: true, force: true });
    }
  });

  describe('✅ PROOF: Git Cloning Works', () => {
    it('PROVES git clone actually works with real repository', async () => {
      const localPath = path.join(cacheDir, 'test-clone');
      
      const storage = new GitWorkflowStorage({
        repositoryUrl: repo1Dir,
        branch: 'main',
        localPath
      });

      // Actually clone and load workflows
      const workflows = await storage.loadAllWorkflows();

      // PROOF: We got real workflows
      expect(workflows).toBeDefined();
      expect(workflows.length).toBe(1);
      expect(workflows[0]?.definition.id).toBe('github-workflow');
      expect(workflows[0]?.definition.name).toBe('GitHub Workflow');
      expect(workflows[0]?.definition.steps[0]?.prompt).toContain('real workflow');
      
      // PROOF: Files actually exist on disk
      const clonedFile = path.join(localPath, 'workflows', 'github-workflow.json');
      expect(existsSync(clonedFile)).toBe(true);
      
      console.log('✅ PROVEN: Git clone works, files on disk, workflows loaded');
    });

    it('PROVES workflows can be retrieved by ID', async () => {
      const localPath = path.join(cacheDir, 'test-get-by-id');
      
      const storage = new GitWorkflowStorage({
        repositoryUrl: repo1Dir,
        branch: 'main',
        localPath
      });

      const workflow = await storage.getWorkflowById('github-workflow');

      // PROOF: Retrieved the exact workflow
      expect(workflow).not.toBeNull();
      expect(workflow?.definition.id).toBe('github-workflow');
      expect(workflow?.definition.steps).toHaveLength(1);
      
      console.log('✅ PROVEN: getWorkflowById works');
    });
  });

  describe('✅ PROOF: Multiple Repositories Work', () => {
    it('PROVES multiple repos can be loaded simultaneously', async () => {
      // Don't use environment variables - test directly
      const originalEnv = process.env;
      
      try {
        process.env = {
          ...originalEnv,
          WORKFLOW_INCLUDE_BUNDLED: 'false',
          WORKFLOW_INCLUDE_USER: 'false',
          WORKFLOW_INCLUDE_PROJECT: 'false',
          WORKFLOW_GIT_REPOS: `${repo1Dir},${repo2Dir}`
        };

        const storage = createEnhancedMultiSourceWorkflowStorage();
        const workflows = await storage.loadAllWorkflows();

        // PROOF: We got workflows from BOTH repos
        expect(workflows.length).toBeGreaterThanOrEqual(2);
        expect(workflows.some(w => w.definition.id === 'github-workflow')).toBe(true);
        expect(workflows.some(w => w.definition.id === 'gitlab-workflow')).toBe(true);
        
        console.log(`✅ PROVEN: Loaded ${workflows.length} workflows from multiple repos`);
        
      } finally {
        process.env = originalEnv;
      }
    });

    it('PROVES workflow precedence (later repos override earlier)', async () => {
      // Create same workflow ID in both repos
      const conflictWorkflow = {
        id: 'conflict-test',
        name: 'Version 1',
        description: 'From repo1',
        version: '1.0.0',
        steps: [{ id: 's1', title: 'Step', prompt: 'First' }]
      };

      await fs.writeFile(
        path.join(repo1Dir, 'workflows', 'conflict-test.json'),
        JSON.stringify(conflictWorkflow, null, 2)
      );
      await gitExec(repo1Dir, ['add', '.']);
      await gitExec(repo1Dir, ['commit', '--no-gpg-sign', '-m', 'Add conflict']);

      const conflictWorkflow2 = {
        ...conflictWorkflow,
        name: 'Version 2',
        description: 'From repo2'
      };

      await fs.writeFile(
        path.join(repo2Dir, 'workflows', 'conflict-test.json'),
        JSON.stringify(conflictWorkflow2, null, 2)
      );
      await gitExec(repo2Dir, ['add', '.']);
      await gitExec(repo2Dir, ['commit', '--no-gpg-sign', '-m', 'Add conflict']);

      const originalEnv = process.env;
      try {
        process.env = {
          ...originalEnv,
          WORKFLOW_INCLUDE_BUNDLED: 'false',
          WORKFLOW_INCLUDE_USER: 'false',
          WORKFLOW_INCLUDE_PROJECT: 'false',
          WORKFLOW_GIT_REPOS: `${repo1Dir},${repo2Dir}`
        };

        const storage = createEnhancedMultiSourceWorkflowStorage();
        const workflow = await storage.getWorkflowById('conflict-test');

        // PROOF: repo2 wins (higher priority)
        expect(workflow?.definition.name).toBe('Version 2');
        expect(workflow?.definition.description).toBe('From repo2');
        
        console.log('✅ PROVEN: Later repos override earlier ones');
        
      } finally {
        process.env = originalEnv;
      }
    });
  });

  describe('✅ PROOF: Caching Works (Offline Support)', () => {
    it('PROVES workflows work offline after initial clone', async () => {
      const localPath = path.join(cacheDir, 'test-offline');
      
      // First load - clones the repo
      const storage1 = new GitWorkflowStorage({
        repositoryUrl: repo1Dir,
        branch: 'main',
        localPath,
        syncInterval: 9999 // Don't sync again
      });

      const workflows1 = await storage1.loadAllWorkflows();
      // Could be more than 1 if conflict-test was created in earlier tests
      expect(workflows1.length).toBeGreaterThanOrEqual(1);
      expect(workflows1.some(w => w.definition.id === 'github-workflow')).toBe(true);

      // PROOF: Files are on disk
      expect(existsSync(localPath)).toBe(true);

      // Second load - uses cache (simulate offline by pointing to invalid URL)
      const storage2 = new GitWorkflowStorage({
        repositoryUrl: 'file:///this/does/not/exist',
        branch: 'main',
        localPath, // Same cache path
        syncInterval: 9999
      });

      const workflows2 = await storage2.loadAllWorkflows();
      
      // PROOF: Still works from cache even though URL is invalid
      expect(workflows2.length).toBeGreaterThanOrEqual(1);
      expect(workflows2.some(w => w.definition.id === 'github-workflow')).toBe(true);
      
      console.log('✅ PROVEN: Offline caching works');
    });
  });

  describe('✅ PROOF: Configuration Options Work', () => {
    it('PROVES includeBundled flag actually works', async () => {
      const originalEnv = process.env;
      try {
        process.env = {
          ...originalEnv,
          WORKFLOW_INCLUDE_BUNDLED: 'false',
          WORKFLOW_INCLUDE_USER: 'false',
          WORKFLOW_INCLUDE_PROJECT: 'false'
        };

        const storage = createEnhancedMultiSourceWorkflowStorage();
        const sourceInfo = storage.getSourceInfo();

        // PROOF: No bundled source
        expect(sourceInfo.every(s => s.definition.name !== 'bundled')).toBe(true);
        
        console.log('✅ PROVEN: includeBundled=false works');
        
      } finally {
        process.env = originalEnv;
      }
    });

    it('PROVES local repos are added as file sources for efficiency', async () => {
      const originalEnv = process.env;
      try {
        process.env = {
          ...originalEnv,
          WORKFLOW_INCLUDE_BUNDLED: 'false',
          WORKFLOW_INCLUDE_USER: 'false',
          WORKFLOW_INCLUDE_PROJECT: 'false',
          WORKFLOW_GIT_REPOS: `${repo1Dir},${repo2Dir},${repo3Dir}`
        };

        const storage = createEnhancedMultiSourceWorkflowStorage();
        const sourceInfo = storage.getSourceInfo();

        // PROOF: Local paths are optimized to use direct file access (custom sources)
        // This is more efficient than git cloning for local directories
        const customSources = sourceInfo.filter(s => s.source.kind === 'custom');
        expect(customSources.length).toBe(3);
        
        console.log(`✅ PROVEN: ${customSources.length} local sources configured as direct file access`);
        
      } finally {
        process.env = originalEnv;
      }
    });
  });

  describe('✅ PROOF: Error Handling Works', () => {
    it('PROVES graceful degradation when one repo fails', async () => {
      const originalEnv = process.env;
      try {
        process.env = {
          ...originalEnv,
          WORKFLOW_INCLUDE_BUNDLED: 'false',
          WORKFLOW_INCLUDE_USER: 'false',
          WORKFLOW_INCLUDE_PROJECT: 'false',
          // Mix valid and invalid repos
          WORKFLOW_GIT_REPOS: `${repo1Dir},file:///nonexistent/path,${repo2Dir}`
        };

        const storage = createEnhancedMultiSourceWorkflowStorage();
        
        // Should NOT throw - graceful degradation
        const workflows = await storage.loadAllWorkflows();
        
        // PROOF: Got workflows from the valid repos
        expect(workflows.length).toBeGreaterThan(0);
        expect(workflows.some(w => w.definition.id === 'github-workflow' || w.definition.id === 'gitlab-workflow')).toBe(true);
        
        console.log('✅ PROVEN: Graceful degradation works');
        
      } finally {
        process.env = originalEnv;
      }
    });

    it('PROVES invalid JSON in env vars is handled', async () => {
      const originalEnv = process.env;
      try {
        process.env = {
          ...originalEnv,
          WORKFLOW_INCLUDE_BUNDLED: 'false',
          WORKFLOW_INCLUDE_USER: 'false',
          WORKFLOW_INCLUDE_PROJECT: 'false',
          WORKFLOW_GIT_REPOS: '[invalid json}'
        };

        // Should NOT throw
        const storage = createEnhancedMultiSourceWorkflowStorage();
        expect(storage).toBeDefined();
        
        console.log('✅ PROVEN: Invalid JSON handled gracefully');
        
      } finally {
        process.env = originalEnv;
      }
    });
  });

  describe('✅ PROOF: Backward Compatibility', () => {
    it('PROVES feature works without any Git config (backward compatible)', async () => {
      const originalEnv = process.env;
      try {
        // No Git configuration at all
        process.env = {
          ...originalEnv,
          WORKFLOW_INCLUDE_BUNDLED: 'true',
          WORKFLOW_INCLUDE_USER: 'false', // Don't check user dir
          WORKFLOW_INCLUDE_PROJECT: 'false' // Don't check project dir
        };

        const storage = createEnhancedMultiSourceWorkflowStorage();
        
        // Should work fine without Git repos
        expect(storage).toBeDefined();
        const sourceInfo = storage.getSourceInfo();
        
        // Should have bundled, but no Git
        expect(sourceInfo.some(s => s.source.kind === 'bundled')).toBe(true);
        expect(sourceInfo.every(s => s.source.kind !== 'git')).toBe(true);
        
        console.log('✅ PROVEN: Backward compatible (works without Git config)');
        
      } finally {
        process.env = originalEnv;
      }
    });
  });

  describe('✅ PROOF: Real-World Scenario', () => {
    it('PROVES complete real-world workflow: multiple repos + local', async () => {
      const originalEnv = process.env;
      try {
        // Simulate real company setup: bundled + Git repos
        process.env = {
          ...originalEnv,
          WORKFLOW_INCLUDE_BUNDLED: 'true',
          WORKFLOW_INCLUDE_USER: 'false',
          WORKFLOW_INCLUDE_PROJECT: 'false',
          WORKFLOW_GIT_REPOS: `${repo1Dir},${repo2Dir}`
        };

        const storage = createEnhancedMultiSourceWorkflowStorage();
        
        // Load ALL workflows
        const workflows = await storage.loadAllWorkflows();
        const sourceInfo = storage.getSourceInfo();
        
        // PROOF: Multiple sources active
        expect(sourceInfo.length).toBeGreaterThan(1);
        
        // PROOF: Got workflows from Git repos
        expect(workflows.some(w => w.definition.id === 'github-workflow')).toBe(true);
        expect(workflows.some(w => w.definition.id === 'gitlab-workflow')).toBe(true);
        
        // PROOF: Can list summaries
        const summaries = await storage.listWorkflowSummaries();
        expect(summaries.length).toBeGreaterThan(0);
        
        // PROOF: Can get specific workflow
        const specific = await storage.getWorkflowById('github-workflow');
        expect(specific).not.toBeNull();
        
        console.log(`✅ PROVEN: Real-world scenario works!`);
        console.log(`   - ${sourceInfo.length} sources active`);
        console.log(`   - ${workflows.length} workflows loaded`);
        console.log(`   - ${summaries.length} summaries available`);
        
      } finally {
        process.env = originalEnv;
      }
    });
  });
});

