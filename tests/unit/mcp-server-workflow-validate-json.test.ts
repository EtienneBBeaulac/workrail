import { describe, it, expect, beforeEach } from 'vitest';
import { createValidateWorkflowJson } from '../../src/application/use-cases/validate-workflow-json';

// Test the workflow validation functionality that powers the MCP tool
describe('MCP Server - workflow_validate_json Integration', () => {
  let validateWorkflowJsonUseCase: (workflowJson: string) => Promise<any>;

  beforeEach(() => {
    // Test the use case directly since the MCP server class is not exported
    validateWorkflowJsonUseCase = createValidateWorkflowJson();
  });

  describe('workflow validation use case integration', () => {
    it('should validate a valid workflow JSON', async () => {
      const validWorkflow = JSON.stringify({
        id: 'test-workflow',
        name: 'Test Workflow',
        description: 'A test workflow',
        version: '0.0.1',
        steps: [{
          id: 'step-1',
          title: 'Test Step',
          prompt: 'Do something'
        }]
      });

      const result = await validateWorkflowJsonUseCase(validWorkflow);
      
      expect(result).toBeDefined();
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
      expect(result.suggestions).toHaveLength(0);
    });

    it('should reject invalid workflow JSON', async () => {
      const invalidWorkflow = JSON.stringify({
        id: 'test-workflow'
        // Missing required fields: name, description, version, steps
      });

      const result = await validateWorkflowJsonUseCase(invalidWorkflow);
      
      expect(result).toBeDefined();
      expect(result.valid).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.suggestions.length).toBeGreaterThan(0);
    });

    it('should handle malformed JSON', async () => {
      const malformedJson = '{ invalid json }';

      const result = await validateWorkflowJsonUseCase(malformedJson);
      
      expect(result).toBeDefined();
      expect(result.valid).toBe(false);
      expect(result.issues.some((issue: string) => issue.includes('Invalid JSON syntax'))).toBe(true);
      expect(result.suggestions.some((suggestion: string) => 
        suggestion.includes('Check for missing quotes, commas, or brackets')
      )).toBe(true);
    });

    it('should handle empty workflow JSON', async () => {
      const emptyJson = '';

      const result = await validateWorkflowJsonUseCase(emptyJson);
      
      expect(result).toBeDefined();
      expect(result.valid).toBe(false);
      expect(result.issues).toContain('Workflow JSON content is empty.');
      expect(result.suggestions).toContain('Provide valid JSON content for the workflow.');
    });

    it('should provide enhanced error messages for common issues', async () => {
      const workflowWithInvalidId = JSON.stringify({
        id: 'Test_Workflow!', // Invalid characters in ID
        name: 'Test Workflow',
        description: 'A test workflow',
        version: '0.0.1',
        steps: [{
          id: 'step-1',
          title: 'Test Step',
          prompt: 'Do something'
        }]
      });

      const result = await validateWorkflowJsonUseCase(workflowWithInvalidId);
      
      expect(result).toBeDefined();
      expect(result.valid).toBe(false);
      expect(result.suggestions.some((suggestion: string) => 
        suggestion.includes('lowercase letters, numbers, and hyphens only')
      )).toBe(true);
    });
  });
}); 