import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { FileWorkflowProvider } from '../../src/infrastructure/storage/file-workflow-storage';
import { IFeatureFlagProvider } from '../../src/config/feature-flags';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('FileWorkflowStorage (Recursive & Flags)', () => {
  let tempDir: string;
  
  // Mock feature flag provider
  const createMockFlags = (enabled: boolean): IFeatureFlagProvider => ({
    isEnabled: (flag: string) => {
      if (flag === 'agenticRoutines') return enabled;
      return false;
    },
    getAll: () => ({}) as any,
    getSummary: () => 'Mock Summary'
  });

  beforeEach(async () => {
    // Create a temp directory structure
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workrail-test-'));
    
    // Create subdirectories
    await fs.mkdir(path.join(tempDir, 'subdir'));
    await fs.mkdir(path.join(tempDir, 'routines'));
    await fs.mkdir(path.join(tempDir, 'deep/nested'), { recursive: true });

    // Create workflow files
    const workflowTemplate = (id: string) => JSON.stringify({
      id,
      name: `Workflow ${id}`,
      description: 'Test workflow',
      version: '1.0.0',
      steps: [
        { id: 'step-1', title: 'Step 1', prompt: 'Test step', agentRole: 'Test' }
      ]
    });

    // 1. Root workflow
    await fs.writeFile(path.join(tempDir, 'root.json'), workflowTemplate('root'));
    
    // 2. Nested workflow
    await fs.writeFile(path.join(tempDir, 'subdir', 'nested.json'), workflowTemplate('nested'));
    
    // 3. Deeply nested workflow
    await fs.writeFile(path.join(tempDir, 'deep/nested', 'deep.json'), workflowTemplate('deep'));
    
    // 4. Routine workflow (in routines/ dir)
    await fs.writeFile(path.join(tempDir, 'routines', 'routine-test.json'), workflowTemplate('routine-test'));
    
    // 5. Routine file at root (starts with routine-)
    await fs.writeFile(path.join(tempDir, 'routine-root.json'), workflowTemplate('routine-root'));
  });

  afterEach(async () => {
    // Cleanup
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should find recursively nested workflows', async () => {
    // Enable flags so everything is visible
    const provider = new FileWorkflowProvider(tempDir, {
      featureFlagProvider: createMockFlags(true)
    });

    const result = await provider.fetchAll();
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    
    const ids = result.value.map(w => w.id as any).sort();

    expect(ids).toContain('root');
    expect(ids).toContain('nested');
    expect(ids).toContain('deep');
    expect(ids).toContain('routine-test');
    expect(ids).toContain('routine-root');
    expect(ids.length).toBe(5);
  });

  it.skip('should hide routines when agenticRoutines flag is disabled (TODO: implement routine filtering)', async () => {
    // Disable flags
    const provider = new FileWorkflowProvider(tempDir, {
      featureFlagProvider: createMockFlags(false)
    });

    const result = await provider.fetchAll();
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    
    const ids = result.value.map(w => w.id as any).sort();

    // Should verify recursive scanning works for non-routines
    expect(ids).toContain('root');
    expect(ids).toContain('nested');
    expect(ids).toContain('deep');

    // Should filter out routines
    expect(ids).not.toContain('routine-test'); // In routines/ dir
    expect(ids).not.toContain('routine-root'); // Starts with routine-
    expect(ids.length).toBe(3);
  });

  it('should show routines when agenticRoutines flag is enabled', async () => {
    // Enable flags
    const provider = new FileWorkflowProvider(tempDir, {
      featureFlagProvider: createMockFlags(true)
    });

    const result = await provider.fetchAll();
    expect(result.isOk()).toBe(true);
    if (!result.isOk()) return;
    
    const ids = result.value.map(w => w.id as any).sort();

    // Should show everything
    expect(ids).toContain('routine-test');
    expect(ids).toContain('routine-root');
    expect(ids.length).toBe(5);
  });
});

