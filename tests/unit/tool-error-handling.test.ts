import { getWorkflow } from '../../src/application/use-cases/get-workflow';
import { WorkflowNotFoundError } from '../../src/core/error-handler';
import { describe, it, expect } from 'vitest';

const stubService = {
  async listWorkflowSummaries() {
    return [];
  },
  async getWorkflowById() {
    return null;
  },
  async getNextStep() {
    return { kind: 'err', error: { kind: 'workflow_not_found', workflowId: 'missing' } };
  },
  async validateStepOutput() {
    return { valid: false, issues: [], suggestions: [] };
  },
} as any;

describe('Tool error handling', () => {
  it('getWorkflow should throw WorkflowNotFoundError for missing id', async () => {
    await expect(getWorkflow(stubService, 'non-existent')).rejects.toBeInstanceOf(WorkflowNotFoundError);
  });
}); 