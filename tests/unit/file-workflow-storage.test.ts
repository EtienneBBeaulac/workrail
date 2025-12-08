import { createDefaultWorkflowStorage } from '../../src/infrastructure/storage';
import type { Workflow } from '../../src/types/schemas.js';

describe('FileWorkflowProvider', () => {
  const provider = createDefaultWorkflowStorage();

  it('should load workflows from disk', async () => {
    const result = await provider.fetchAll();
    expect(result.isOk()).toBe(true);
    
    if (result.isOk()) {
      const workflows = result.value;
      expect(Array.isArray(workflows)).toBe(true);
      expect(workflows.length).toBeGreaterThan(0);
      const wf = workflows[0]! as Workflow;
      expect(wf).toHaveProperty('id');
      expect(wf).toHaveProperty('steps');
    }
  });

  it('should cache workflows (implicit via EnhancedMultiSource)', async () => {
    // Note: Caching moved to repository layer
    // This test now just verifies provider returns consistent results
    const result1 = await provider.fetchAll();
    const result2 = await provider.fetchAll();
    
    expect(result1.isOk()).toBe(true);
    expect(result2.isOk()).toBe(true);
    
    if (result1.isOk() && result2.isOk()) {
      expect(result1.value.length).toBe(result2.value.length);
    }
  });

  it('should exclude example workflows from loading', async () => {
    const result = await provider.fetchAll();
    expect(result.isOk()).toBe(true);
    
    if (result.isOk()) {
      const workflows = result.value;
      
      // Check that no workflow IDs contain 'simple-' prefix (from examples/loops/)
      const exampleWorkflows = workflows.filter((wf: Workflow) => 
        (wf.id as any).startsWith('simple-') || (wf.id as any).includes('example')
      );
      
      expect(exampleWorkflows).toHaveLength(0);
      
      // Specifically check for known example workflow IDs that should be excluded
      const workflowIds = workflows.map((wf: Workflow) => wf.id as any);
      expect(workflowIds).not.toContain('simple-batch-example');
      expect(workflowIds).not.toContain('simple-polling-example');
      expect(workflowIds).not.toContain('simple-retry-example');
      expect(workflowIds).not.toContain('simple-search-example');
      expect(workflowIds).not.toContain('dashboard-template-workflow');
    }
  });
});
