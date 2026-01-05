import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createEnhancedMultiSourceWorkflowStorage } from '../../src/infrastructure/storage/enhanced-multi-source-workflow-storage';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { toFileUrl } from '../helpers/platform.js';
import { gitExec } from '../helpers/git-test-utils.js';

/**
 * Real-world integration test that simulates MCP environment
 * WITHOUT skipSandboxCheck - this is what users actually experience
 */
describe('GitWorkflowStorage - Real-world MCP Sandbox', () => {
  const testRepoDir = path.join(os.tmpdir(), 'workrail-realworld-test-' + Date.now());
  const cacheDir = path.join(os.tmpdir(), 'workrail-cache-realworld-' + Date.now());
  let originalEnv: NodeJS.ProcessEnv;

  beforeAll(async () => {
    originalEnv = { ...process.env };
    process.env['WORKRAIL_CACHE_DIR'] = cacheDir;
    
    // Create a test Git repository with a workflow
    await fs.mkdir(testRepoDir, { recursive: true });
    await fs.mkdir(path.join(testRepoDir, 'workflows'), { recursive: true });
    
    // Initialize Git repo
    await gitExec(testRepoDir, ['init']);
    await gitExec(testRepoDir, ['config', 'user.email', 'test@test.com']);
    await gitExec(testRepoDir, ['config', 'user.name', 'Test User']);
    
    // Create a valid test workflow
    const testWorkflow = {
      id: 'realworld-test',
      name: 'Real World Test',
      description: 'Test workflow for real-world scenario',
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
      path.join(testRepoDir, 'workflows', 'realworld-test.json'),
      JSON.stringify(testWorkflow, null, 2)
    );
    
    // Commit the workflow
    await gitExec(testRepoDir, ['add', '.']);
    await gitExec(testRepoDir, ['commit', '--no-gpg-sign', '-m', 'Add test workflow']);
    
    // Ensure we're on main branch (Git 2.28+ uses different default)
    try {
      await gitExec(testRepoDir, ['branch', '-M', 'main']);
    } catch (e) {
      // Already on main
    }
  });

  afterAll(async () => {
    process.env = originalEnv;
    
    if (existsSync(testRepoDir)) {
      await fs.rm(testRepoDir, { recursive: true, force: true });
    }

    if (existsSync(cacheDir)) {
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('should load workflows from file:// URL without skipSandboxCheck (real MCP scenario)', async () => {
    // Simulate MCP environment - set env var only
    process.env['WORKFLOW_GIT_REPOS'] = toFileUrl(testRepoDir);
    
    // Create storage WITHOUT skipSandboxCheck (this is what happens in real MCP)
    const storage = createEnhancedMultiSourceWorkflowStorage();
    
    // Wait a bit for Git clone to complete
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Should be able to load the workflow
    const workflow = await storage.getWorkflowById('realworld-test');
    expect(workflow).toBeDefined();
    expect(workflow?.definition.name).toBe('Real World Test');
    
    const summaries = await storage.listWorkflowSummaries();
    const testWorkflow = summaries.find(w => w.id === 'realworld-test');
    expect(testWorkflow).toBeDefined();
  }, 10000);

  it('should work with explicit WORKRAIL_CACHE_DIR (for actual remote repos)', async () => {
    // Note: file:// URLs are now optimized to use direct file access,
    // so cache is NOT created for them. This is expected behavior.
    // The cache directory is only used for actual remote Git repos.
    
    process.env['WORKFLOW_GIT_REPOS'] = toFileUrl(testRepoDir);
    
    const storage = createEnhancedMultiSourceWorkflowStorage();
    
    // file:// URLs use direct file access (no caching)
    const workflow = await storage.getWorkflowById('realworld-test');
    expect(workflow).toBeDefined();
    expect(workflow?.definition.name).toBe('Real World Test');
    
    // Verify workflow can be loaded from the local path
    const sourceInfo = storage.getSourceInfo();
    const customSources = sourceInfo.filter(s => s.source.kind === 'custom');
    expect(customSources.length).toBeGreaterThanOrEqual(1);
  }, 10000);
});

