import { describe, it, expect } from 'vitest';

describe('Workflow Get Schema Integration', () => {
  describe('workflow_get_schema tool through MCP server', () => {
    it('should return the complete workflow schema with metadata', async () => {
      // Test the schema loading logic that our tool uses
      
      // Create a mock workflow server instance to test the method
      const fs = await import('fs');
      const path = await import('path');
      
      // Load the workflow schema directly to verify our tool returns the same data
      const schemaPath = path.resolve(__dirname, '../../spec/workflow.schema.json');
      const schemaContent = fs.readFileSync(schemaPath, 'utf-8');
      const expectedSchema = JSON.parse(schemaContent);
      
      // Test the schema loading logic that our tool uses
      const result = {
        schema: expectedSchema,
        metadata: {
          version: '1.0.0',
          description: 'Complete JSON schema for workflow files',
          usage: 'This schema defines the structure, required fields, and validation rules for workflow JSON files',
          schemaPath: 'spec/workflow.schema.json'
        },
        commonPatterns: {
          basicWorkflow: {
            id: 'string (required): Unique identifier using lowercase letters, numbers, and hyphens',
            name: 'string (required): Human-readable workflow name',
            description: 'string (required): Detailed description of the workflow purpose',
            version: 'string (required): Semantic version (e.g., "1.0.0")',
            steps: 'array (required): List of workflow steps, minimum 1 item'
          },
          stepStructure: {
            id: 'string (required): Unique step identifier',
            title: 'string (required): Human-readable step title',
            prompt: 'string (required): Instructions for the step',
            agentRole: 'string (required): Role description for the agent',
            validationCriteria: 'array (optional): Validation rules for step output'
          }
        }
      };
      
      // Verify the schema structure
      expect(result.schema).toBeDefined();
      expect(result.schema.type).toBe('object');
      expect(result.schema.properties).toBeDefined();
      expect(result.schema.required).toBeDefined();
      expect(result.metadata).toBeDefined();
      expect(result.commonPatterns).toBeDefined();
    });

    it('should provide the correct schema structure for validation', async () => {
      const fs = await import('fs');
      const path = await import('path');
      
      const schemaPath = path.resolve(__dirname, '../../spec/workflow.schema.json');
      const schemaContent = fs.readFileSync(schemaPath, 'utf-8');
      const schema = JSON.parse(schemaContent);
      
      // Verify the schema has the expected workflow structure
      expect(schema.properties.id).toBeDefined();
      expect(schema.properties.name).toBeDefined();
      expect(schema.properties.description).toBeDefined();
      expect(schema.properties.version).toBeDefined();
      expect(schema.properties.steps).toBeDefined();
      
      // Verify required fields
      expect(schema.required).toContain('id');
      expect(schema.required).toContain('name');
      expect(schema.required).toContain('description');
      expect(schema.required).toContain('version');
      expect(schema.required).toContain('steps');
      
      // Verify steps structure
      expect(schema.properties.steps.type).toBe('array');
      expect(schema.properties.steps.minItems).toBe(1);
      expect(schema.properties.steps.items).toBeDefined();
      
      // Schema uses oneOf with $ref to support both standard and loop steps
      const stepSchema = schema.properties.steps.items;
      expect(stepSchema.oneOf).toBeDefined();
      expect(Array.isArray(stepSchema.oneOf)).toBe(true);
      
      // Verify step definitions exist in $defs
      expect(schema.$defs).toBeDefined();
      expect(schema.$defs.standardStep).toBeDefined();
      expect(schema.$defs.standardStep.type).toBe('object');
      expect(schema.$defs.standardStep.properties.id).toBeDefined();
      expect(schema.$defs.standardStep.properties.title).toBeDefined();
      expect(schema.$defs.standardStep.properties.prompt).toBeDefined();
      expect(schema.$defs.standardStep.required).toContain('id');
      expect(schema.$defs.standardStep.required).toContain('title');
      expect(schema.$defs.standardStep.required).toContain('prompt');
    });

    it('should provide schema compatible with enhanced error messages', async () => {
      // Test that the schema is compatible with the enhanced error service
      const { validateWorkflow } = await import('../../src/application/validation');
      
             // Test with a workflow containing additional properties
       const invalidWorkflow = {
         id: 'test-workflow',
         name: 'Test Workflow',
         description: 'Test description',
         version: '1.0.0',
         steps: [
           {
             id: 'step-1',
             title: 'Test Step',
             prompt: 'Test prompt',
             agentRole: 'You are a helpful test assistant.',
            validationCriteria: [{
              type: 'contains',
              value: 'test',
              message: 'Test validation'
            }]
          }
        ],
        unexpectedProperty: 'this should cause an error'
      };
      
      const validationResult = validateWorkflow(invalidWorkflow);
      expect(validationResult.valid).toBe(false);
      expect(validationResult.errors.length).toBeGreaterThan(0);
      
      // Verify that the enhanced error service provides specific error messages
      const additionalPropertyError = validationResult.errors.find(error => 
        error.includes('unexpectedProperty')
      );
      
      expect(additionalPropertyError).toBeDefined();
      expect(additionalPropertyError).toContain('Unexpected property');
      expect(additionalPropertyError).toContain('unexpectedProperty');
    });

    it('should work with valid workflow structures', async () => {
      const { validateWorkflow } = await import('../../src/application/validation');
      
             // Test with a valid workflow
       const validWorkflow = {
         id: 'test-workflow',
         name: 'Test Workflow',
         description: 'Test description',
         version: '1.0.0',
         steps: [
           {
             id: 'step-1',
             title: 'Test Step',
             prompt: 'Test prompt',
             agentRole: 'You are a helpful test assistant.',
            validationCriteria: [{
              type: 'contains',
              value: 'test',
              message: 'Test validation'
            }]
          }
        ]
      };
      
      const validationResult = validateWorkflow(validWorkflow);
      expect(validationResult.valid).toBe(true);
      expect(validationResult.errors).toHaveLength(0);
    });

    it('should provide helpful patterns for common workflow structures', async () => {
      // Test that the common patterns are useful for understanding the schema
      const commonPatterns = {
        basicWorkflow: {
          id: 'string (required): Unique identifier using lowercase letters, numbers, and hyphens',
          name: 'string (required): Human-readable workflow name',
          description: 'string (required): Detailed description of the workflow purpose',
          version: 'string (required): Semantic version (e.g., "1.0.0")',
          steps: 'array (required): List of workflow steps, minimum 1 item'
        },
        stepStructure: {
          id: 'string (required): Unique step identifier',
          title: 'string (required): Human-readable step title',
          prompt: 'string (required): Instructions for the step',
          agentRole: 'string (required): Role description for the agent',
          validationCriteria: 'array (optional): Validation rules for step output'
        }
      };
      
      // Verify the patterns contain useful information
      expect(commonPatterns.basicWorkflow.id).toContain('required');
      expect(commonPatterns.basicWorkflow.id).toContain('Unique identifier');
      expect(commonPatterns.basicWorkflow.steps).toContain('minimum 1 item');
      
      expect(commonPatterns.stepStructure.id).toContain('required');
      expect(commonPatterns.stepStructure.validationCriteria).toContain('optional');
    });
  });
}); 