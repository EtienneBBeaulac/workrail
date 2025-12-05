import { describe, it, expect } from 'vitest';
import { validateWorkflow } from '../../src/application/validation';

describe('Enhanced Validation Integration', () => {
  describe('validateWorkflow with Enhanced Error Service', () => {
    it('should provide exact field names for additional properties errors', () => {
      const invalidWorkflow = {
        id: 'test-workflow',
        name: 'Test Workflow',
        description: 'Test description',
        version: '0.0.1',
        steps: [],
        unexpectedField: 'This should not be here' // This is the invalid field
      };

      const result = validateWorkflow(invalidWorkflow);
      
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      
      // Find the additional property error
      const additionalPropertyError = result.errors.find(error => 
        error.includes('unexpectedField')
      );
      
      expect(additionalPropertyError).toBeDefined();
      expect(additionalPropertyError).toContain('unexpectedField');
      expect(additionalPropertyError).toContain('found at root level');
      expect(additionalPropertyError).toContain('This property is not defined in the workflow schema');
    });

    it('should provide exact field names for step-level additional properties', () => {
      const invalidWorkflow = {
        id: 'test-workflow',
        name: 'Test Workflow',
        description: 'Test description',
        version: '0.0.1',
        steps: [
          {
            id: 'step-1',
            title: 'Test Step',
            prompt: 'Test prompt',
            agentRole: 'Test role',
            unexpectedStepField: 'This should not be here' // Invalid field in step
          }
        ]
      };

      const result = validateWorkflow(invalidWorkflow);
      
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      
      // Find the additional property error
      const additionalPropertyError = result.errors.find(error => 
        error.includes('unexpectedStepField')
      );
      
      expect(additionalPropertyError).toBeDefined();
      expect(additionalPropertyError).toContain('unexpectedStepField');
      expect(additionalPropertyError).toContain('found in step 1');
      expect(additionalPropertyError).toContain('This property is not defined in the workflow schema');
    });

    it('should provide specific missing field names for required property errors', () => {
      const invalidWorkflow = {
        id: 'test-workflow',
        // Missing required fields: name, description, version, steps
      };

      const result = validateWorkflow(invalidWorkflow);
      
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      
      // Check that at least one error mentions a specific missing field
      const hasSpecificMissingField = result.errors.some(error => 
        error.includes('Missing required field') && 
        (error.includes('name') || error.includes('description') || error.includes('version') || error.includes('steps'))
      );
      
      expect(hasSpecificMissingField).toBe(true);
    });

    it('should prioritize critical errors (additional properties, required fields) first', () => {
      const invalidWorkflow = {
        id: 'test-workflow',
        name: 123, // Type error (should be string)
        version: '0.0.1',
        steps: [],
        unexpectedField: 'additional property error' // Additional property error
        // Missing required field: description
      };

      const result = validateWorkflow(invalidWorkflow);
      
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      
      // Critical errors (additional properties, required fields) should come first
      expect(result.errors.length).toBeGreaterThan(0);
      const firstError = result.errors[0];
      expect(firstError).toBeDefined();
      
      const isCriticalError = firstError!.includes('Unexpected property') || 
                             firstError!.includes('Missing required field');
      
      expect(isCriticalError).toBe(true);
    });

    it('should handle multiple errors with enhanced messages', () => {
      const invalidWorkflow = {
        id: 'test-workflow',
        name: 'Test Workflow',
        description: 'Test description',
        version: '0.0.1',
        steps: [],
        unexpectedField1: 'first invalid field',
        unexpectedField2: 'second invalid field'
      };

      const result = validateWorkflow(invalidWorkflow);
      
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(1);
      
      // Each error should be specific
      const hasSpecificError1 = result.errors.some(error => 
        error.includes('unexpectedField1') && error.includes('found at root level')
      );
      const hasSpecificError2 = result.errors.some(error => 
        error.includes('unexpectedField2') && error.includes('found at root level')
      );
      
      expect(hasSpecificError1).toBe(true);
      expect(hasSpecificError2).toBe(true);
    });

    it('should maintain backward compatibility with valid workflows', () => {
      const validWorkflow = {
        id: 'test-workflow',
        name: 'Test Workflow',
        description: 'Test description',
        version: '0.0.1',
        steps: [
          {
            id: 'step-1',
            title: 'Test Step',
            prompt: 'Test prompt',
            agentRole: 'You are a test assistant.',
            validationCriteria: [
              {
                type: 'contains',
                value: 'test',
                message: 'Implementation should include test functionality'
              }
            ]
          }
        ]
      };

      const result = validateWorkflow(validWorkflow);
      
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });
}); 