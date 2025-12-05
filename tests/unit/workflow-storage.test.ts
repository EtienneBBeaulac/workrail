import { describe, it, expect } from 'vitest';
import { createDefaultWorkflowStorage } from '../../src/infrastructure/storage';

describe('Workflow Storage', () => {
  const storage = createDefaultWorkflowStorage();

  it('should load all valid workflows from the examples directory', async () => {
    const workflows = await storage.loadAllWorkflows();
    expect(Array.isArray(workflows)).toBe(true);
    expect(workflows.length).toBeGreaterThan(0);
    for (const wf of workflows) {
      expect(typeof wf.id).toBe('string');
      expect(typeof wf.name).toBe('string');
      expect(Array.isArray(wf.steps)).toBe(true);
    }
  });

  it('should get a workflow by ID if it exists', async () => {
    const workflows = await storage.loadAllWorkflows();
    const first = workflows[0];
    if (!first) {
      // Skip test if no workflows are loaded
      return;
    }
    const found = await storage.getWorkflowById(first.id);
    expect(found).toBeDefined();
    expect(found?.id).toBe(first.id);
  });

  it('should return null for a missing workflow ID', async () => {
    const found = await storage.getWorkflowById('nonexistent-id-123');
    expect(found).toBeNull();
  });

  it('should list workflow summaries', async () => {
    const summaries = await storage.listWorkflowSummaries();
    expect(Array.isArray(summaries)).toBe(true);
    expect(summaries.length).toBeGreaterThan(0);
    for (const summary of summaries) {
      expect(typeof summary.id).toBe('string');
      expect(typeof summary.name).toBe('string');
      expect(typeof summary.description).toBe('string');
    }
  });
}); 