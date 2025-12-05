import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createEnhancedMultiSourceWorkflowStorage } from '../../src/infrastructure/storage/enhanced-multi-source-workflow-storage';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * End-to-end tests for external workflow feature
 * Tests the complete flow from config to workflow execution
 */

describe('External Workflows E2E', () => {
  const testDir = path.join(os.tmpdir(), 'workrail-e2e-' + Date.now());
  const repo1Dir = path.join(testDir, 'repo1');
  const repo2Dir = path.join(testDir, 'repo2');
  const cacheDir = path.join(testDir, 'cache');

  beforeAll(async () => {
    await fs.mkdir(testDir, { recursive: true });
    
    // Create two test repositories simulating different sources
    await createTestRepo(repo1Dir, 'community-workflow', 'Community Workflow');
    await createTestRepo(repo2Dir, 'team-workflow', 'Team Workflow');
  });

  afterAll(async () => {
    if (existsSync(testDir)) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  async function createTestRepo(repoDir: string, workflowId: string, workflowName: string) {
    await fs.mkdir(path.join(repoDir, 'workflows'), { recursive: true });
    
    await execAsync('git init', { cwd: repoDir });
    await execAsync('git config user.email "test@test.com"', { cwd: repoDir });
    await execAsync('git config user.name "Test"', { cwd: repoDir });
    
    const workflow = {
      id: workflowId,
      name: workflowName,
      description: `Test workflow from ${repoDir}`,
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
      path.join(repoDir, 'workflows', `${workflowId}.json`),
      JSON.stringify(workflow, null, 2)
    );
    
    await execAsync('git add .', { cwd: repoDir });
    await execAsync('git commit -m "Initial commit"', { cwd: repoDir });
    await execAsync('git branch -M main', { cwd: repoDir });
  }

  describe('Complete Workflow Flow', () => {
    it('should load workflows from multiple Git sources', async () => {
      // Simulate environment configuration
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        WORKFLOW_INCLUDE_BUNDLED: 'false', // Disable for cleaner test
        WORKFLOW_INCLUDE_USER: 'false',
        WORKFLOW_INCLUDE_PROJECT: 'false',
        WORKFLOW_GIT_REPOS: `${repo1Dir},${repo2Dir}`
      };

      const storage = createEnhancedMultiSourceWorkflowStorage();
      const workflows = await storage.loadAllWorkflows();

      // Should have workflows from both repos
      expect(workflows.length).toBeGreaterThanOrEqual(2);
      expect(workflows.some(w => w.id === 'community-workflow')).toBe(true);
      expect(workflows.some(w => w.id === 'team-workflow')).toBe(true);

      process.env = originalEnv;
    });

    it('should handle workflow precedence correctly', async () => {
      // Create conflicting workflow in both repos
      const conflictWorkflow = {
        id: 'conflict-test',
        name: 'First Version',
        description: 'From repo1',
        version: '1.0.0',
        steps: [{ id: 's1', title: 'Step', prompt: 'First' }]
      };

      await fs.writeFile(
        path.join(repo1Dir, 'workflows', 'conflict-test.json'),
        JSON.stringify(conflictWorkflow, null, 2)
      );
      await execAsync('git add . && git commit -m "Add conflict"', { cwd: repo1Dir });

      const conflictWorkflow2 = {
        ...conflictWorkflow,
        name: 'Second Version',
        description: 'From repo2'
      };

      await fs.writeFile(
        path.join(repo2Dir, 'workflows', 'conflict-test.json'),
        JSON.stringify(conflictWorkflow2, null, 2)
      );
      await execAsync('git add . && git commit -m "Add conflict"', { cwd: repo2Dir });

      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        WORKFLOW_INCLUDE_BUNDLED: 'false',
        WORKFLOW_INCLUDE_USER: 'false',
        WORKFLOW_INCLUDE_PROJECT: 'false',
        WORKFLOW_GIT_REPOS: `${repo1Dir},${repo2Dir}` // repo2 should win
      };

      const storage = createEnhancedMultiSourceWorkflowStorage();
      const workflow = await storage.getWorkflowById('conflict-test');

      // Later repo (repo2) should override earlier one (repo1)
      expect(workflow?.name).toBe('Second Version');
      expect(workflow?.description).toBe('From repo2');

      process.env = originalEnv;
    });

    it('should list all available workflows from all sources', async () => {
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        WORKFLOW_INCLUDE_BUNDLED: 'false',
        WORKFLOW_INCLUDE_USER: 'false',
        WORKFLOW_INCLUDE_PROJECT: 'false',
        WORKFLOW_GIT_REPOS: `${repo1Dir},${repo2Dir}`
      };

      const storage = createEnhancedMultiSourceWorkflowStorage();
      const summaries = await storage.listWorkflowSummaries();

      // Should have summaries from both repos
      expect(summaries.length).toBeGreaterThan(0);
      expect(summaries.some(s => s.id === 'community-workflow')).toBe(true);
      expect(summaries.some(s => s.id === 'team-workflow')).toBe(true);

      process.env = originalEnv;
    });
  });

  describe('Real-World Scenarios', () => {
    it('should simulate company setup: public + private repos', async () => {
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        WORKFLOW_INCLUDE_BUNDLED: 'true', // Include bundled
        WORKFLOW_INCLUDE_USER: 'true',
        WORKFLOW_INCLUDE_PROJECT: 'true',
        WORKFLOW_GIT_REPOS: `${repo1Dir},${repo2Dir}` // External repos
      };

      const storage = createEnhancedMultiSourceWorkflowStorage();
      const sourceInfo = storage.getSourceInfo();

      // Should have multiple sources
      expect(sourceInfo.length).toBeGreaterThan(2);
      
      // Local paths are optimized to use direct file access (custom) instead of git cloning
      const fileSources = sourceInfo.filter(s => s.type === 'file');
      expect(fileSources.length).toBeGreaterThanOrEqual(2);

      process.env = originalEnv;
    });

    it('should handle graceful degradation when one repo fails', async () => {
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        WORKFLOW_INCLUDE_BUNDLED: 'false',
        WORKFLOW_INCLUDE_USER: 'false',
        WORKFLOW_INCLUDE_PROJECT: 'false',
        // One valid, one invalid
        WORKFLOW_GIT_REPOS: `${repo1Dir},https://github.com/nonexistent/repo.git`,
        gracefulDegradation: 'true'
      };

      const storage = createEnhancedMultiSourceWorkflowStorage();
      
      // Should not throw, should load from valid repo only
      const workflows = await storage.loadAllWorkflows();
      expect(workflows.some(w => w.id === 'community-workflow')).toBe(true);

      process.env = originalEnv;
    });
  });

  describe('Configuration Validation', () => {
    it('should detect and report source information', () => {
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        WORKFLOW_GIT_REPOS: `${repo1Dir},${repo2Dir}`
      };

      const storage = createEnhancedMultiSourceWorkflowStorage();
      const sourceInfo = storage.getSourceInfo();

      // Local paths are optimized to use direct file access (custom) instead of git cloning
      // So they appear as file sources with custom: prefix
      const customSources = sourceInfo.filter(s => s.name.startsWith('custom:'));
      expect(customSources.length).toBe(2);
      expect(customSources.every(s => s.type === 'file')).toBe(true);

      process.env = originalEnv;
    });
  });
});

describe('External Workflows Performance', () => {
  it('should load workflows efficiently', async () => {
    const start = Date.now();
    
    const storage = createEnhancedMultiSourceWorkflowStorage({
      includeBundled: false,
      includeUser: false,
      includeProject: false
    });
    
    // Should create storage quickly (no Git operations yet)
    const createTime = Date.now() - start;
    expect(createTime).toBeLessThan(100); // Should be nearly instant
    
    // Actual loading might take longer due to Git operations
    // This is expected and acceptable
  });
});

