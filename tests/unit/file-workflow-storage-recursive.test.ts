import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { FileWorkflowStorage } from '../../src/infrastructure/storage/file-workflow-storage';
import { IFeatureFlagProvider } from '../../src/config/feature-flags';
import { createCustomDirectorySource } from '../../src/types/workflow';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('FileWorkflowStorage (Recursive & Flags)', () => {
  let tempDir: string;
  
  // Mock feature flag provider
  const createMockFlags = (
    agenticEnabled: boolean,
    v2Enabled: boolean = false,
  ): IFeatureFlagProvider => ({
    isEnabled: (flag: string) => {
      if (flag === 'agenticRoutines') return agenticEnabled;
      if (flag === 'v2Tools') return v2Enabled;
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
      steps: []
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
    // 6. Standard / agentic / v2 precedence fixtures
    await fs.writeFile(path.join(tempDir, 'same.json'), JSON.stringify({
      id: 'same',
      name: 'Workflow same standard',
      description: 'Standard variant',
      version: '1.0.0',
      steps: []
    }));
    await fs.writeFile(path.join(tempDir, 'same.agentic.json'), JSON.stringify({
      id: 'same',
      name: 'Workflow same agentic',
      description: 'Agentic variant',
      version: '1.1.0',
      steps: []
    }));
    await fs.writeFile(path.join(tempDir, 'same.v2.json'), JSON.stringify({
      id: 'same',
      name: 'Workflow same v2',
      description: 'V2 variant',
      version: '2.0.0',
      steps: []
    }));
  });

  afterEach(async () => {
    // Cleanup
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should find recursively nested workflows', async () => {
    // Enable flags so everything is visible
    const storage = new FileWorkflowStorage(
      tempDir,
      createCustomDirectorySource(tempDir, 'Test'),
      createMockFlags(true),
      {}
    );

    const summaries = await storage.listWorkflowSummaries();
    const ids = summaries.map(s => s.id).sort();

    expect(ids).toContain('root');
    expect(ids).toContain('nested');
    expect(ids).toContain('deep');
    expect(ids).toContain('routine-test');
    expect(ids).toContain('routine-root');
    expect(ids).toContain('same');
    expect(ids.length).toBe(6);
  });

  it('should hide routines when agenticRoutines flag is disabled', async () => {
    // Disable flags
    const storage = new FileWorkflowStorage(
      tempDir,
      createCustomDirectorySource(tempDir, 'Test'),
      createMockFlags(false),
      {}
    );

    const summaries = await storage.listWorkflowSummaries();
    const ids = summaries.map(s => s.id).sort();

    // Should verify recursive scanning works for non-routines
    expect(ids).toContain('root');
    expect(ids).toContain('nested');
    expect(ids).toContain('deep');

    // Should filter out routines
    expect(ids).not.toContain('routine-test'); // In routines/ dir
    expect(ids).not.toContain('routine-root'); // Starts with routine-
    expect(ids).toContain('same');
    expect(ids.length).toBe(4);
  });

  it('should show routines when agenticRoutines flag is enabled', async () => {
    // Enable flags
    const storage = new FileWorkflowStorage(
      tempDir,
      createCustomDirectorySource(tempDir, 'Test'),
      createMockFlags(true),
      {}
    );

    const summaries = await storage.listWorkflowSummaries();
    const ids = summaries.map(s => s.id).sort();

    // Should show everything
    expect(ids).toContain('routine-test');
    expect(ids).toContain('routine-root');
    expect(ids.length).toBe(6);
  });
  it('prefers .v2. override when v2Tools is enabled', async () => {
    const storage = new FileWorkflowStorage(
      tempDir,
      createCustomDirectorySource(tempDir, 'Test'),
      createMockFlags(true, true),
      {}
    );
    const workflow = await storage.getWorkflowById('same');
    expect(workflow?.definition.name).toBe('Workflow same v2');
  });
  it('prefers .agentic. override over standard when agenticRoutines is enabled and v2Tools is disabled', async () => {
    const storage = new FileWorkflowStorage(
      tempDir,
      createCustomDirectorySource(tempDir, 'Test'),
      createMockFlags(true, false),
      {}
    );
    const workflow = await storage.getWorkflowById('same');
    expect(workflow?.definition.name).toBe('Workflow same agentic');
  });
  it('prefers standard workflow when both v2Tools and agenticRoutines are disabled', async () => {
    const storage = new FileWorkflowStorage(
      tempDir,
      createCustomDirectorySource(tempDir, 'Test'),
      createMockFlags(false, false),
      {}
    );
    const workflow = await storage.getWorkflowById('same');
    expect(workflow?.definition.name).toBe('Workflow same standard');
  });
});

