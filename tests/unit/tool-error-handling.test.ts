import { getWorkflow } from '../../src/application/use-cases/get-workflow';
import { WorkflowNotFoundError } from '../../src/core/error-handler';
import { createWorkflowService } from '../../src/application/services/workflow-service';
import { createDefaultWorkflowStorage } from '../../src/infrastructure/storage';
import { describe, it, expect } from 'vitest';


describe('Tool error handling', () => {
  it('getWorkflow should throw WorkflowNotFoundError for missing id', async () => {
    const service = createWorkflowService(createDefaultWorkflowStorage());
    await expect(getWorkflow(service, 'non-existent')).rejects.toBeInstanceOf(WorkflowNotFoundError);
  });
}); 