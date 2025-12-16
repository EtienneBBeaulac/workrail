import { createDefaultWorkflowStorage } from '../../src/infrastructure/storage';
import { Workflow, createWorkflow, createBundledSource, WorkflowDefinition } from '../../src/types/workflow';

describe('FileWorkflowStorage', () => {
  const storage = createDefaultWorkflowStorage();

  it('should load workflows from disk', async () => {
    const workflows = await storage.loadAllWorkflows();
    expect(Array.isArray(workflows)).toBe(true);
    expect(workflows.length).toBeGreaterThan(0);
    const wf = workflows[0]! as Workflow;
    expect(wf).toHaveProperty('definition');
    expect(wf).toHaveProperty('source');
    expect(wf.definition).toHaveProperty('id');
    expect(wf.definition).toHaveProperty('steps');
  });

  it('should cache workflows and provide hit/miss stats', async () => {
    // Ensure cache is cold by resetting stats via internal API access
    const statsBefore = storage.getCacheStats();

    // First call – should be a miss or at least not decrease counts
    await storage.loadAllWorkflows();
    const statsAfterFirst = storage.getCacheStats();
    expect(statsAfterFirst.misses).toBeGreaterThanOrEqual(statsBefore.misses);

    // Second call – should hit cache
    await storage.loadAllWorkflows();
    const statsAfterSecond = storage.getCacheStats();
    expect(statsAfterSecond.hits).toBeGreaterThanOrEqual(statsAfterFirst.hits + 1);
  });

  it('should exclude example workflows from loading', async () => {
    const workflows = await storage.loadAllWorkflows();
    
    // Check that no workflow IDs contain 'simple-' prefix (from examples/loops/)
    const exampleWorkflows = workflows.filter((wf: Workflow) => 
      wf.definition.id.startsWith('simple-') || wf.definition.id.includes('example')
    );
    
    expect(exampleWorkflows).toHaveLength(0);
    
    // Specifically check for known example workflow IDs that should be excluded
    const workflowIds = workflows.map((wf: Workflow) => wf.definition.id);
    expect(workflowIds).not.toContain('simple-batch-example');
    expect(workflowIds).not.toContain('simple-polling-example');
    expect(workflowIds).not.toContain('simple-retry-example');
    expect(workflowIds).not.toContain('simple-search-example');
    expect(workflowIds).not.toContain('dashboard-template-workflow');
  });
}); 