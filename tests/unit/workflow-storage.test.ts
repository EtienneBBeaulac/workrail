import { describe, it, expect } from 'vitest';
import { createDefaultWorkflowStorage } from '../../src/infrastructure/storage';

describe('Workflow Storage (Provider)', () => {
  const provider = createDefaultWorkflowStorage();

  it('should fetch all valid workflows from the examples directory', async () => {
    const result = await provider.fetchAll();
    expect(result.isOk()).toBe(true);
    
    if (result.isOk()) {
      const workflows = result.value;
      expect(Array.isArray(workflows)).toBe(true);
      expect(workflows.length).toBeGreaterThan(0);
      for (const wf of workflows) {
        expect(typeof wf.id).toBe('string');
        expect(typeof wf.name).toBe('string');
        expect(Array.isArray(wf.steps)).toBe(true);
      }
    }
  });

  it('should get a workflow by ID if it exists', async () => {
    const allResult = await provider.fetchAll();
    expect(allResult.isOk()).toBe(true);
    
    if (allResult.isOk()) {
      const workflows = allResult.value;
      const first = workflows[0];
      if (!first) {
        // Skip test if no workflows are loaded
        return;
      }
      const foundResult = await provider.fetchById(first.id as any);
      expect(foundResult.isOk()).toBe(true);
      if (foundResult.isOk()) {
        expect(foundResult.value.id).toBe(first.id);
      }
    }
  });

  it('should return error for a missing workflow ID', async () => {
    const result = await provider.fetchById('nonexistent-id-123' as any);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error._tag).toBe('WorkflowNotFound');
    }
  });

  it('should list workflow summaries via fetchAll', async () => {
    const result = await provider.fetchAll();
    expect(result.isOk()).toBe(true);
    
    if (result.isOk()) {
      const workflows = result.value;
      expect(Array.isArray(workflows)).toBe(true);
      expect(workflows.length).toBeGreaterThan(0);
      for (const wf of workflows) {
        expect(typeof wf.id).toBe('string');
        expect(typeof wf.name).toBe('string');
        expect(typeof wf.description).toBe('string');
      }
    }
  });
});
