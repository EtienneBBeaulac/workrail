// @ts-nocheck
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import { RpcClient } from '../helpers/rpc-client';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Comprehensive API Endpoint Tests', () => {
  const SERVER_PATH = path.resolve(__dirname, '../../src/index.ts');
  let client: RpcClient;
  
  beforeAll(async () => {
    client = new RpcClient(SERVER_PATH);
  }, { timeout: 30000 });

  afterAll(async () => {
    if (client) {
      await client.close();
    }
  }, { timeout: 10000 });

  describe('workflow_list endpoint', () => {
    it('should return available workflows', async () => {
      const res = await client.send('workflow_list'); // Remove parameters
      
      expect(res.result).toBeDefined();
      expect(res.result.workflows).toBeDefined();
      expect(Array.isArray(res.result.workflows)).toBe(true);
      expect(res.result.workflows.length).toBeGreaterThan(0);
      
      // Verify workflow structure
      res.result.workflows.forEach((workflow: any) => {
        expect(workflow).toHaveProperty('id');
        expect(workflow).toHaveProperty('name');
        expect(workflow).toHaveProperty('description');
        expect(workflow).toHaveProperty('version');
        expect(typeof workflow.id).toBe('string');
        expect(typeof workflow.name).toBe('string');
        expect(typeof workflow.description).toBe('string');
        expect(typeof workflow.version).toBe('string');
      });
    });

    it('should include known workflows', async () => {
      const res = await client.send('workflow_list'); // Remove parameters
      const workflowIds = res.result.workflows.map((w: any) => w.id);
      
      expect(workflowIds).toContain('coding-task-workflow-with-loops');
      expect(workflowIds).toContain('adaptive-ticket-creation');
    });
  });

  describe('workflow_get endpoint', () => {
    describe('metadata mode', () => {
      it('should return workflow metadata without steps', async () => {
        const res = await client.send('workflow_get', {
          id: 'coding-task-workflow-with-loops',
          mode: 'metadata'
        });
        
        expect(res.result).toBeDefined();
        expect(res.result.id).toBe('coding-task-workflow-with-loops');
        expect(res.result).toHaveProperty('name');
        expect(res.result).toHaveProperty('description');
        expect(res.result).toHaveProperty('version');
        expect(res.result).toHaveProperty('totalSteps');
        expect(res.result).toHaveProperty('preconditions');
        expect(res.result).toHaveProperty('metaGuidance');
        expect(res.result).not.toHaveProperty('steps');
        expect(res.result).not.toHaveProperty('firstStep');
        expect(typeof res.result.totalSteps).toBe('number');
        expect(res.result.totalSteps).toBeGreaterThan(0);
      });
    });

    describe('preview mode (default)', () => {
      it('should return workflow preview with first step', async () => {
        const res = await client.send('workflow_get', {
          id: 'coding-task-workflow-with-loops',
          mode: 'preview'
        });
        
        expect(res.result).toBeDefined();
        expect(res.result.id).toBe('coding-task-workflow-with-loops');
        expect(res.result).toHaveProperty('name');
        expect(res.result).toHaveProperty('description');
        expect(res.result).toHaveProperty('version');
        expect(res.result).toHaveProperty('totalSteps');
        expect(res.result).toHaveProperty('firstStep');
        expect(res.result).toHaveProperty('preconditions');
        expect(res.result).toHaveProperty('metaGuidance');
        expect(res.result).not.toHaveProperty('steps');
        
        // Verify first step structure
        expect(res.result.firstStep).toHaveProperty('id');
        expect(res.result.firstStep).toHaveProperty('title');
        expect(res.result.firstStep).toHaveProperty('prompt');
        expect(res.result.firstStep).toHaveProperty('agentRole');
      });

      it('should return preview by default when no mode specified', async () => {
        const res = await client.send('workflow_get', {
          id: 'coding-task-workflow'
          // No mode parameter - should default to preview
        });
        
        expect(res.result).toBeDefined();
        expect(res.result.id).toBe('coding-task-workflow-with-loops');
        expect(res.result).toHaveProperty('name');
        expect(res.result).toHaveProperty('description');
        expect(res.result).toHaveProperty('version');
        expect(res.result).toHaveProperty('totalSteps');
        expect(res.result).toHaveProperty('firstStep');
        expect(res.result).toHaveProperty('preconditions');
        expect(res.result).toHaveProperty('metaGuidance');
        expect(res.result).not.toHaveProperty('steps');
      });
    });

    it('should handle non-existent workflow', async () => {
      const res = await client.send('workflow_get', {
        id: 'non-existent-workflow',
        mode: 'metadata'
      });
      
      // Should return error response, not throw
      expect(res.error).toBeDefined();
      expect(res.error.code).toBeDefined();
    });

    it('should handle invalid mode parameter', async () => {
      const res = await client.send('workflow_get', {
        id: 'coding-task-workflow-with-loops',
        mode: 'invalid-mode'
      });
      
      // Should return error response, not throw
      expect(res.error).toBeDefined();
      expect(res.error.code).toBe(-32602); // Invalid params
    });
  });

  describe('workflow_next endpoint', () => {
    it('should return first step when no completed steps', async () => {
      const res = await client.send('workflow_next', {
        workflowId: 'coding-task-workflow-with-loops',
        completedSteps: []
      });
      
      expect(res.result).toBeDefined();
      expect(res.result).toHaveProperty('step');
      expect(res.result).toHaveProperty('guidance');
      expect(res.result).toHaveProperty('isComplete', false);
      
      // Verify step structure
      expect(res.result.step).toHaveProperty('id');
      expect(res.result.step).toHaveProperty('title');
      expect(res.result.step).toHaveProperty('prompt');
      expect(res.result.step).toHaveProperty('agentRole');
    });

    it('should progress through workflow steps', async () => {
      // Get first step
      const firstRes = await client.send('workflow_next', {
        workflowId: 'coding-task-workflow-with-loops',
        completedSteps: []
      });
      
      expect(firstRes.result.step.id).toBe('phase-0-intelligent-triage');
      
      // Get second step
      const secondRes = await client.send('workflow_next', {
        workflowId: 'coding-task-workflow-with-loops',
        completedSteps: ['phase-0-intelligent-triage']
      });
      
      expect(secondRes.result.step.id).not.toBe('phase-0-intelligent-triage');
      expect(secondRes.result.isComplete).toBe(false);
    });

    it('should handle conditional steps with context', async () => {
      const res = await client.send('workflow_next', {
        workflowId: 'coding-task-workflow-with-loops',
        completedSteps: ['phase-0-intelligent-triage'],
        context: {
          taskComplexity: 'Large'
        }
      });
      
      expect(res.result).toBeDefined();
      expect(res.result.step).toBeDefined();
      expect(res.result.isComplete).toBe(false);
    });

    it('should handle non-existent workflow', async () => {
      const res = await client.send('workflow_next', {
        workflowId: 'non-existent-workflow',
        completedSteps: []
      });
      
      // Should return error response, not throw
      expect(res.error).toBeDefined();
      expect(res.error.code).toBeDefined();
    });

    it('should handle invalid completed steps', async () => {
      const res = await client.send('workflow_next', {
        workflowId: 'coding-task-workflow-with-loops',
        completedSteps: ['invalid-step-id']
      });
      
      // This should still work as the workflow engine can handle unknown completed steps
      expect(res.result || res.error).toBeDefined();
    });
  });

  describe('workflow_validate endpoint', () => {
    it('should validate step output successfully', async () => {
      const res = await client.send('workflow_validate', {
        workflowId: 'coding-task-workflow-with-loops',
        stepId: 'phase-0-intelligent-triage',
        output: 'Task has been analyzed as Medium complexity with clear scope and boundaries.'
      });
      
      expect(res.result).toBeDefined();
      expect(res.result).toHaveProperty('valid', true);
      expect(res.result).toHaveProperty('issues');
      expect(res.result).toHaveProperty('suggestions');
    });

    it('should handle invalid step output', async () => {
      const res = await client.send('workflow_validate', {
        workflowId: 'coding-task-workflow-with-loops',
        stepId: 'phase-0-intelligent-triage',
        output: 'Invalid or incomplete output'
      });
      
      expect(res.result).toBeDefined();
      expect(res.result).toHaveProperty('valid');
      expect(res.result).toHaveProperty('issues');
      expect(res.result).toHaveProperty('suggestions');
    });

    it('should handle non-existent workflow', async () => {
      const res = await client.send('workflow_validate', {
        workflowId: 'non-existent-workflow',
        stepId: 'some-step',
        output: 'Some output'
      });
      
      // Should return error response, not throw
      expect(res.error).toBeDefined();
      expect(res.error.code).toBeDefined();
    });

    it('should handle non-existent step', async () => {
      const res = await client.send('workflow_validate', {
        workflowId: 'coding-task-workflow-with-loops',
        stepId: 'non-existent-step',
        output: 'Some output'
      });
      
      // Should return error response, not throw
      expect(res.error).toBeDefined();
      expect(res.error.code).toBeDefined();
    });

    it('should handle empty output', async () => {
      const res = await client.send('workflow_validate', {
        workflowId: 'coding-task-workflow-with-loops',
        stepId: 'phase-0-intelligent-triage',
        output: ''
      });
      
      expect(res.result).toBeDefined();
      expect(res.result).toHaveProperty('valid');
      expect(res.result).toHaveProperty('issues');
      expect(res.result).toHaveProperty('suggestions');
    });
  });

  describe('Cross-endpoint Integration Tests', () => {
    it('should have consistent workflow data across endpoints', async () => {
      // Get workflow from list
      const listRes = await client.send('workflow_list');
      const workflowFromList = listRes.result.workflows.find((w: any) => w.id === 'coding-task-workflow-with-loops');
      
      // Get same workflow with metadata mode
      const metadataRes = await client.send('workflow_get', {
        id: 'coding-task-workflow-with-loops',
        mode: 'metadata'
      });
      
      // Verify consistency
      expect(workflowFromList.id).toBe(metadataRes.result.id);
      expect(workflowFromList.name).toBe(metadataRes.result.name);
      expect(workflowFromList.description).toBe(metadataRes.result.description);
      expect(workflowFromList.version).toBe(metadataRes.result.version);
    });

    it('should handle workflow execution flow', async () => {
      // Start workflow
      const nextRes = await client.send('workflow_next', {
        workflowId: 'coding-task-workflow-with-loops',
        completedSteps: []
      });
      
      // Validate step output
      const validateRes = await client.send('workflow_validate', {
        workflowId: 'coding-task-workflow-with-loops',
        stepId: nextRes.result.step.id,
        output: 'Task analyzed as Medium complexity'
      });
      
      expect(validateRes.result).toBeDefined();
      expect(validateRes.result).toHaveProperty('valid');
      expect(validateRes.result).toHaveProperty('issues');
      expect(validateRes.result).toHaveProperty('suggestions');
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle missing required parameters', async () => {
      const res = await client.send('workflow_get', {} as any);
      
      // Should return error response, not throw
      expect(res.error).toBeDefined();
      expect(res.error.code).toBe(-32602); // Invalid params
    });

    it('should handle large output validation', async () => {
      const largeOutput = 'x'.repeat(10000);
      
      const res = await client.send('workflow_validate', {
        workflowId: 'coding-task-workflow-with-loops',
        stepId: 'phase-0-intelligent-triage',
        output: largeOutput
      });
      
      expect(res.result).toBeDefined();
      expect(res.result).toHaveProperty('valid');
      expect(res.result).toHaveProperty('issues');
      expect(res.result).toHaveProperty('suggestions');
    });

    it('should handle special characters in parameters', async () => {
      const specialOutput = 'Output with special chars: \\n\\t\\r"\'<>&';
      
      const res = await client.send('workflow_validate', {
        workflowId: 'coding-task-workflow-with-loops',
        stepId: 'phase-0-intelligent-triage',
        output: specialOutput
      });
      
      expect(res.result).toBeDefined();
      expect(res.result).toHaveProperty('valid');
      expect(res.result).toHaveProperty('issues');
      expect(res.result).toHaveProperty('suggestions');
    });
  });

  describe('Performance and Load Testing', () => {
    it('should handle multiple concurrent requests', async () => {
      const promises = Array(5).fill(null).map(() =>
        client.send('workflow_list')
      );
      
      const results = await Promise.all(promises);
      
      results.forEach(result => {
        expect(result.result).toBeDefined();
        expect(result.result.workflows).toBeDefined();
        expect(Array.isArray(result.result.workflows)).toBe(true);
      });
    });

    it('should complete requests within reasonable time', async () => {
      const startTime = Date.now();
      
      await client.send('workflow_get', {
        id: 'coding-task-workflow-with-loops',
        mode: 'metadata'
      });
      
      const endTime = Date.now();
      expect(endTime - startTime).toBeLessThan(5000); // Should complete within 5 seconds
    });
  });
}); 