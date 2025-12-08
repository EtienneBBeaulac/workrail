import { InMemoryWorkflowProvider } from '../../src/infrastructure/storage/in-memory-storage';
import { describe, it, expect } from 'vitest';


describe('InMemoryWorkflowProvider', () => {
  it('should return workflows provided at construction', async () => {
    const provider = new InMemoryWorkflowProvider([
      {
        id: 'demo',
        name: 'Demo',
        description: 'Demo workflow',
        steps: [],
      },
    ] as any);

    const listResult = await provider.fetchAll();
    expect(listResult.isOk()).toBe(true);
    if (listResult.isOk()) {
      expect(listResult.value).toHaveLength(1);
    }
    
    const foundResult = await provider.fetchById('demo' as any);
    expect(foundResult.isOk()).toBe(true);
    
    const missingResult = await provider.fetchById('missing' as any);
    expect(missingResult.isErr()).toBe(true);
    if (missingResult.isErr()) {
      expect(missingResult.error._tag).toBe('WorkflowNotFound');
    }
  });
});
