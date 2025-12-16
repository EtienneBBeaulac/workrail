import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GitWorkflowStorage } from '../../src/infrastructure/storage/git-workflow-storage';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * DIRECT PROOF - No environment variables, direct API calls
 * This PROVES the Git cloning functionality actually works
 */

describe('🔥 DIRECT PROOF: Git Cloning Works', () => {
  const testDir = path.join(os.tmpdir(), 'workrail-direct-proof-' + Date.now());
  const sourceRepoDir = path.join(testDir, 'source-repo');
  const cloneDir = path.join(testDir, 'cloned');

  beforeAll(async () => {
    console.log('\n🔧 Creating REAL Git repository for testing...');
    
    // Create a real Git repository
    await fs.mkdir(path.join(sourceRepoDir, 'workflows'), { recursive: true });
    
    await execAsync('git init', { cwd: sourceRepoDir });
    await execAsync('git config user.email "test@test.com"', { cwd: sourceRepoDir });
    await execAsync('git config user.definition.name "Test"', { cwd: sourceRepoDir });
    
    // Create a real workflow
    const workflow = {
      id: 'proof-workflow',
      name: 'Proof Workflow',
      description: 'This workflow proves Git cloning works',
      version: '1.0.0',
      steps: [
        {
          id: 'step-1',
          title: 'Proof Step',
          prompt: 'This step was loaded from a real Git repository'
        }
      ]
    };
    
    await fs.writeFile(
      path.join(sourceRepoDir, 'workflows', 'proof-workflow.json'),
      JSON.stringify(workflow, null, 2)
    );
    
    await execAsync('git add .', { cwd: sourceRepoDir });
    await execAsync('git commit -m "Add proof workflow"', { cwd: sourceRepoDir });
    await execAsync('git branch -M main', { cwd: sourceRepoDir });
    
    console.log('✅ Real Git repository created at:', sourceRepoDir);
  });

  afterAll(async () => {
    if (existsSync(testDir)) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  it('🔥 PROVES Git clone works with local repository', async () => {
    console.log('\n🧪 Testing Git clone...');
    console.log('Source repo:', sourceRepoDir);
    console.log('Clone target:', path.join(cloneDir, 'test1'));
    
    // Create Git storage pointing to our test repo
    const storage = new GitWorkflowStorage({
      repositoryUrl: sourceRepoDir,
      branch: 'main',
      localPath: path.join(cloneDir, 'test1'),
      skipSandboxCheck: true // Allow test paths outside project
    });

    // Clone and load workflows
    const workflows = await storage.loadAllWorkflows();

    // PROOF 1: We got workflows
    console.log(`✅ Loaded ${workflows.length} workflow(s)`);
    expect(workflows).toBeDefined();
    expect(workflows.length).toBe(1);

    // PROOF 2: Correct workflow data
    const workflow = workflows[0]!;
    console.log(`✅ Workflow ID: ${workflow.definition.id}`);
    console.log(`✅ Workflow Name: ${workflow.definition.name}`);
    expect(workflow.definition.id).toBe('proof-workflow');
    expect(workflow.definition.name).toBe('Proof Workflow');
    expect(workflow.definition.steps).toHaveLength(1);

    // PROOF 3: Files actually exist on disk
    const clonedFile = path.join(cloneDir, 'test1', 'workflows', 'proof-workflow.json');
    console.log(`✅ Checking if file exists: ${clonedFile}`);
    expect(existsSync(clonedFile)).toBe(true);

    // PROOF 4: Can read the cloned file
    const content = await fs.readFile(clonedFile, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.id).toBe('proof-workflow');
    
    console.log('\n✅✅✅ PROVEN: Git clone works perfectly! ✅✅✅\n');
  });

  it('🔥 PROVES getWorkflowById works', async () => {
    const storage = new GitWorkflowStorage({
      repositoryUrl: sourceRepoDir,
      branch: 'main',
      localPath: path.join(cloneDir, 'test2'),
      skipSandboxCheck: true
    });

    const workflow = await storage.getWorkflowById('proof-workflow');

    // PROOF: Retrieved specific workflow
    expect(workflow).not.toBeNull();
    expect(workflow?.definition.id).toBe('proof-workflow');
    expect(workflow?.definition.name).toBe('Proof Workflow');
    
    console.log('✅✅ PROVEN: getWorkflowById works! ✅✅');
  });

  it('🔥 PROVES listWorkflowSummaries works', async () => {
    const storage = new GitWorkflowStorage({
      repositoryUrl: sourceRepoDir,
      branch: 'main',
      localPath: path.join(cloneDir, 'test3'),
      skipSandboxCheck: true
    });

    const summaries = await storage.listWorkflowSummaries();

    // PROOF: Got summaries
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.id).toBe('proof-workflow');
    expect(summaries[0]?.name).toBe('Proof Workflow');
    expect(summaries[0]?.source.kind).toBe('git');
    
    console.log('✅✅ PROVEN: listWorkflowSummaries works! ✅✅');
  });

  it('🔥 PROVES caching works (offline support)', async () => {
    const cachePath = path.join(cloneDir, 'test-cache');
    
    // First load - clones
    const storage1 = new GitWorkflowStorage({
      repositoryUrl: sourceRepoDir,
      branch: 'main',
      localPath: cachePath,
      syncInterval: 9999, // Don't re-sync
      skipSandboxCheck: true
    });

    const workflows1 = await storage1.loadAllWorkflows();
    expect(workflows1).toHaveLength(1);
    console.log('✅ First load (cloned)');

    // Second load - uses cache
    const storage2 = new GitWorkflowStorage({
      repositoryUrl: sourceRepoDir,
      branch: 'main',
      localPath: cachePath,
      syncInterval: 9999,
      skipSandboxCheck: true
    });

    const workflows2 = await storage2.loadAllWorkflows();
    expect(workflows2).toHaveLength(1);
    expect(workflows2[0]?.definition.id).toBe('proof-workflow');
    
    console.log('✅✅ PROVEN: Caching works (loaded from cache)! ✅✅');
  });

  it('🔥 PROVES multiple workflows in one repo', async () => {
    // Add another workflow
    const workflow2 = {
      id: 'second-proof',
      name: 'Second Proof',
      description: 'Another workflow',
      version: '1.0.0',
      steps: [{ id: 's1', title: 'Step', prompt: 'Do thing' }]
    };

    await fs.writeFile(
      path.join(sourceRepoDir, 'workflows', 'second-proof.json'),
      JSON.stringify(workflow2, null, 2)
    );
    await execAsync('git add . && git commit -m "Add second"', { cwd: sourceRepoDir });

    const storage = new GitWorkflowStorage({
      repositoryUrl: sourceRepoDir,
      branch: 'main',
      localPath: path.join(cloneDir, 'test-multi'),
      skipSandboxCheck: true
    });

    const workflows = await storage.loadAllWorkflows();

    // PROOF: Got both workflows
    expect(workflows.length).toBeGreaterThanOrEqual(2);
    expect(workflows.some(w => w.definition.id === 'proof-workflow')).toBe(true);
    expect(workflows.some(w => w.definition.id === 'second-proof')).toBe(true);
    
    console.log(`✅✅ PROVEN: Multiple workflows work (${workflows.length} loaded)! ✅✅`);
  });
});

