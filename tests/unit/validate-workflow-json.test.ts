import { describe, it, expect, beforeEach } from 'vitest';
import { 
  createValidateWorkflowJson, 
  validateWorkflowJson,
  WorkflowJsonValidationResult 
} from '../../src/application/use-cases/validate-workflow-json';

describe('Validate Workflow JSON Use Case', () => {
  let validateWorkflowJsonUseCase: (workflowJson: string) => Promise<WorkflowJsonValidationResult>;

  beforeEach(() => {
    validateWorkflowJsonUseCase = createValidateWorkflowJson();
  });

  describe('createValidateWorkflowJson factory', () => {
    it('should create a use case function', () => {
      const useCase = createValidateWorkflowJson();
      expect(typeof useCase).toBe('function');
    });

    it('should return async function', () => {
      const useCase = createValidateWorkflowJson();
      const result = useCase('{}');
      expect(result).toBeInstanceOf(Promise);
    });
  });

  describe('input validation', () => {
    it('should reject null input', async () => {
      const result = await validateWorkflowJsonUseCase(null as any);
      expect(result.valid).toBe(false);
      expect(result.issues).toContain('Workflow JSON content is required and must be a string.');
      expect(result.suggestions).toContain('Provide valid JSON content for the workflow.');
    });

    it('should reject undefined input', async () => {
      const result = await validateWorkflowJsonUseCase(undefined as any);
      expect(result.valid).toBe(false);
      expect(result.issues).toContain('Workflow JSON content is required and must be a string.');
      expect(result.suggestions).toContain('Provide valid JSON content for the workflow.');
    });

    it('should reject non-string input', async () => {
      const result = await validateWorkflowJsonUseCase(123 as any);
      expect(result.valid).toBe(false);
      expect(result.issues).toContain('Workflow JSON content is required and must be a string.');
      expect(result.suggestions).toContain('Provide valid JSON content for the workflow.');
    });

    it('should reject empty string', async () => {
      const result = await validateWorkflowJsonUseCase('');
      expect(result.valid).toBe(false);
      expect(result.issues).toContain('Workflow JSON content is empty.');
      expect(result.suggestions).toContain('Provide valid JSON content for the workflow.');
    });

    it('should reject whitespace-only string', async () => {
      const result = await validateWorkflowJsonUseCase('   \n  \t  ');
      expect(result.valid).toBe(false);
      expect(result.issues).toContain('Workflow JSON content is empty.');
      expect(result.suggestions).toContain('Provide valid JSON content for the workflow.');
    });
  });

  describe('JSON parsing errors', () => {
    it('should handle invalid JSON syntax', async () => {
      const result = await validateWorkflowJsonUseCase('{ invalid json }');
      expect(result.valid).toBe(false);
      expect(result.issues[0]).toContain('Invalid JSON syntax:');
      expect(result.suggestions).toContain('Check for missing quotes, commas, or brackets in the JSON.');
      expect(result.suggestions).toContain('Ensure all strings are properly quoted.');
      expect(result.suggestions).toContain('Verify that brackets and braces are properly matched.');
      expect(result.suggestions).toContain('Use a JSON formatter or validator to identify syntax errors.');
    });

    it('should handle missing quotes', async () => {
      const result = await validateWorkflowJsonUseCase('{ id: test }');
      expect(result.valid).toBe(false);
      expect(result.issues[0]).toContain('Invalid JSON syntax:');
      expect(result.suggestions).toContain('Ensure all strings are properly quoted.');
    });

    it('should handle trailing commas', async () => {
      const result = await validateWorkflowJsonUseCase('{ "id": "test", }');
      expect(result.valid).toBe(false);
      expect(result.issues[0]).toContain('Invalid JSON syntax:');
      expect(result.suggestions).toContain('Check for missing quotes, commas, or brackets in the JSON.');
    });

    it('should handle unmatched brackets', async () => {
      const result = await validateWorkflowJsonUseCase('{ "id": "test"');
      expect(result.valid).toBe(false);
      expect(result.issues[0]).toContain('Invalid JSON syntax:');
      expect(result.suggestions).toContain('Verify that brackets and braces are properly matched.');
    });
  });

  describe('valid workflow validation', () => {
    it('should validate minimal valid workflow', async () => {
      const validWorkflow = {
        id: 'test-workflow',
        name: 'Test Workflow',
        description: 'A test workflow',
        version: '0.0.1',
        steps: [{
          id: 'step-1',
          title: 'Test Step',
          prompt: 'Do something'
        }]
      };

      const result = await validateWorkflowJsonUseCase(JSON.stringify(validWorkflow));
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
      expect(result.suggestions).toHaveLength(0);
    });

    it('should validate complex valid workflow', async () => {
      const validWorkflow = {
        id: 'complex-workflow',
        name: 'Complex Test Workflow',
        description: 'A complex test workflow with multiple features',
        version: '1.0.0',
        preconditions: ['User has access to system'],
        metaGuidance: ['Follow best practices'],
        steps: [{
          id: 'step-1',
          title: 'First Step',
          prompt: 'Do the first task',
          guidance: ['Be careful', 'Double check'],
          askForFiles: true,
          requireConfirmation: false,
          runCondition: {
            var: 'complexity',
            equals: 'high'
          }
        }, {
          id: 'step-2',
          title: 'Second Step',
          prompt: 'Do the second task'
        }]
      };

      const result = await validateWorkflowJsonUseCase(JSON.stringify(validWorkflow));
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
      expect(result.suggestions).toHaveLength(0);
    });
  });

  describe('invalid workflow validation', () => {
    it('should detect missing required fields', async () => {
      const invalidWorkflow = {
        id: 'test-workflow'
        // Missing name, description, version, steps
      };

      const result = await validateWorkflowJsonUseCase(JSON.stringify(invalidWorkflow));
      expect(result.valid).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.suggestions.length).toBeGreaterThan(0);
    });

    it('should detect invalid field types', async () => {
      const invalidWorkflow = {
        id: 'test-workflow',
        name: 123, // Should be string
        description: 'Test description',
        version: '0.0.1',
        steps: []
      };

      const result = await validateWorkflowJsonUseCase(JSON.stringify(invalidWorkflow));
      expect(result.valid).toBe(false);
      expect(result.issues.some(issue => issue.includes('Expected \'string\' but received a different type'))).toBe(true);
    });

    it('should detect invalid ID pattern', async () => {
      const invalidWorkflow = {
        id: 'Test_Workflow!', // Invalid characters
        name: 'Test Workflow',
        description: 'A test workflow',
        version: '0.0.1',
        steps: [{
          id: 'step-1',
          title: 'Test Step',
          prompt: 'Do something'
        }]
      };

      const result = await validateWorkflowJsonUseCase(JSON.stringify(invalidWorkflow));
      expect(result.valid).toBe(false);
      expect(result.issues.some(issue => issue.includes('pattern'))).toBe(true);
      expect(result.suggestions.some(suggestion => 
        suggestion.includes('lowercase letters, numbers, and hyphens only')
      )).toBe(true);
    });

    it('should detect empty steps array', async () => {
      const invalidWorkflow = {
        id: 'test-workflow',
        name: 'Test Workflow',
        description: 'A test workflow',
        version: '0.0.1',
        steps: [] // Empty steps array
      };

      const result = await validateWorkflowJsonUseCase(JSON.stringify(invalidWorkflow));
      expect(result.valid).toBe(false);
      expect(result.suggestions.some(suggestion => 
        suggestion.includes('at least one step')
      )).toBe(true);
    });

    it('should detect invalid version format', async () => {
      const invalidWorkflow = {
        id: 'test-workflow',
        name: 'Test Workflow',
        description: 'A test workflow',
        version: 'invalid-version',
        steps: [{
          id: 'step-1',
          title: 'Test Step',
          prompt: 'Do something'
        }]
      };

      const result = await validateWorkflowJsonUseCase(JSON.stringify(invalidWorkflow));
      expect(result.valid).toBe(false);
      expect(result.suggestions.some(suggestion => 
        suggestion.includes('semantic versioning')
      )).toBe(true);
    });
  });

  describe('error message enhancement', () => {
    it('should enhance missing required property errors', async () => {
      const invalidWorkflow = {
        id: 'test-workflow'
        // Missing required fields
      };

      const result = await validateWorkflowJsonUseCase(JSON.stringify(invalidWorkflow));
      expect(result.valid).toBe(false);
      expect(result.issues.some(issue => 
        issue.includes('Missing required field') && issue.includes('This field is mandatory and must be provided')
      )).toBe(true);
    });

    it('should enhance additional properties errors', async () => {
      const invalidWorkflow = {
        id: 'test-workflow',
        name: 'Test Workflow',
        description: 'A test workflow',
        version: '0.0.1',
        steps: [{
          id: 'step-1',
          title: 'Test Step',
          prompt: 'Do something'
        }],
        invalidProperty: 'should not be here'
      };

      const result = await validateWorkflowJsonUseCase(JSON.stringify(invalidWorkflow));
      expect(result.valid).toBe(false);
      expect(result.issues.some(issue => 
        issue.includes('Unexpected property') && issue.includes('This property is not defined in the workflow schema')
      )).toBe(true);
    });
  });

  describe('suggestions generation', () => {
    it('should provide specific suggestions for common errors', async () => {
      const invalidWorkflow = {
        id: 'Test_Workflow!', // Invalid ID
        name: 123, // Invalid name type
        description: '', // Empty description
        version: 'bad-version', // Invalid version
        steps: [] // Empty steps
      };

      const result = await validateWorkflowJsonUseCase(JSON.stringify(invalidWorkflow));
      expect(result.valid).toBe(false);
      expect(result.suggestions).toContain('Ensure the workflow ID follows the pattern: lowercase letters, numbers, and hyphens only.');
      expect(result.suggestions).toContain('Provide a clear, descriptive name for the workflow.');
      expect(result.suggestions).toContain('Add a meaningful description explaining what the workflow accomplishes.');
      expect(result.suggestions).toContain('Use semantic versioning format (e.g., "0.0.1", "1.0.0").');
      expect(result.suggestions).toContain('Ensure the workflow has at least one step with id, title, and either prompt or promptBlocks.');
    });
  });

  describe('legacy function export', () => {
    it('should work with legacy validateWorkflowJson function', async () => {
      const validWorkflow = {
        id: 'test-workflow',
        name: 'Test Workflow',
        description: 'A test workflow',
        version: '0.0.1',
        steps: [{
          id: 'step-1',
          title: 'Test Step',
          prompt: 'Do something'
        }]
      };

      const result = await validateWorkflowJson(JSON.stringify(validWorkflow));
      expect(result.valid).toBe(true);
      expect(result.issues).toHaveLength(0);
      expect(result.suggestions).toHaveLength(0);
    });
  });
}); 