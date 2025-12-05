import { InMemoryWorkflowStorage } from '../../src/infrastructure/storage/in-memory-storage';
import { describe, it, expect } from 'vitest';


describe('InMemoryWorkflowStorage', () => {
  it('should return workflows provided at construction', async () => {
    const storage = new InMemoryWorkflowStorage([
      {
        id: 'demo',
        name: 'Demo',
        description: 'Demo workflow',
        steps: [],
      },
    ] as any);

    const list = await storage.loadAllWorkflows();
    expect(list).toHaveLength(1);
    expect(await storage.getWorkflowById('demo')).not.toBeNull();
    expect(await storage.getWorkflowById('missing')).toBeNull();
  });
}); 