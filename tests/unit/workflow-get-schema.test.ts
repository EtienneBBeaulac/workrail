import { describe, it, expect, beforeEach } from 'vitest';

// Mock the WorkflowOrchestrationServer since we need to access the private class
class TestWorkflowServer {
  public async getWorkflowSchema() {
    // Import fs and path for schema loading
    const fs = await import('fs');
    const path = await import('path');
    
    // Load the workflow schema
    const schemaPath = path.resolve(__dirname, '../../spec/workflow.schema.json');
    const schemaContent = fs.readFileSync(schemaPath, 'utf-8');
    const schema = JSON.parse(schemaContent);
    
    // Add helpful metadata
    const result = {
      schema,
      metadata: {
        version: '1.0.0',
        description: 'Complete JSON schema for workflow files',
        usage: 'This schema defines the structure, required fields, and validation rules for workflow JSON files',
        lastUpdated: new Date().toISOString(),
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
    
    return {
      content: [{
        type: "text",
        text: JSON.stringify(result, null, 2)
      }]
    };
  }
}

describe('Workflow Get Schema Tool', () => {
  let server: TestWorkflowServer;

  beforeEach(() => {
    server = new TestWorkflowServer();
  });

  describe('getWorkflowSchema', () => {
    it('should return the complete workflow schema', async () => {
      const result = await server.getWorkflowSchema();
      
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toBeDefined();
      expect(result.content[0]!.type).toBe('text');
      
      const responseData = JSON.parse(result.content[0]!.text);
      expect(responseData.schema).toBeDefined();
      expect(responseData.metadata).toBeDefined();
      expect(responseData.commonPatterns).toBeDefined();
    });

    it('should include schema metadata with version and description', async () => {
      const result = await server.getWorkflowSchema();
      expect(result.content[0]).toBeDefined();
      const responseData = JSON.parse(result.content[0]!.text);
      
      expect(responseData.metadata.version).toBe('1.0.0');
      expect(responseData.metadata.description).toBe('Complete JSON schema for workflow files');
      expect(responseData.metadata.usage).toContain('structure, required fields, and validation rules');
      expect(responseData.metadata.schemaPath).toBe('spec/workflow.schema.json');
      expect(responseData.metadata.lastUpdated).toBeDefined();
    });

    it('should include common patterns for basic workflow structure', async () => {
      const result = await server.getWorkflowSchema();
      expect(result.content[0]).toBeDefined();
      const responseData = JSON.parse(result.content[0]!.text);
      
      expect(responseData.commonPatterns.basicWorkflow).toBeDefined();
      expect(responseData.commonPatterns.basicWorkflow.id).toContain('Unique identifier');
      expect(responseData.commonPatterns.basicWorkflow.name).toContain('Human-readable workflow name');
      expect(responseData.commonPatterns.basicWorkflow.description).toContain('Detailed description');
      expect(responseData.commonPatterns.basicWorkflow.version).toContain('Semantic version');
      expect(responseData.commonPatterns.basicWorkflow.steps).toContain('minimum 1 item');
    });

    it('should include common patterns for step structure', async () => {
      const result = await server.getWorkflowSchema();
      expect(result.content[0]).toBeDefined();
      const responseData = JSON.parse(result.content[0]!.text);
      
      expect(responseData.commonPatterns.stepStructure).toBeDefined();
      expect(responseData.commonPatterns.stepStructure.id).toContain('Unique step identifier');
      expect(responseData.commonPatterns.stepStructure.title).toContain('Human-readable step title');
      expect(responseData.commonPatterns.stepStructure.prompt).toContain('Instructions for the step');
      expect(responseData.commonPatterns.stepStructure.agentRole).toContain('Role description');
      expect(responseData.commonPatterns.stepStructure.validationCriteria).toContain('optional');
    });

    it('should return the actual JSON schema structure', async () => {
      const result = await server.getWorkflowSchema();
      expect(result.content[0]).toBeDefined();
      const responseData = JSON.parse(result.content[0]!.text);
      
      // Verify the schema has the expected structure
      expect(responseData.schema).toBeDefined();
      expect(responseData.schema.type).toBe('object');
      expect(responseData.schema.properties).toBeDefined();
      expect(responseData.schema.required).toBeDefined();
      
      // Check for key workflow properties
      expect(responseData.schema.properties.id).toBeDefined();
      expect(responseData.schema.properties.name).toBeDefined();
      expect(responseData.schema.properties.description).toBeDefined();
      expect(responseData.schema.properties.version).toBeDefined();
      expect(responseData.schema.properties.steps).toBeDefined();
      
      // Check required fields
      expect(responseData.schema.required).toContain('id');
      expect(responseData.schema.required).toContain('name');
      expect(responseData.schema.required).toContain('description');
      expect(responseData.schema.required).toContain('version');
      expect(responseData.schema.required).toContain('steps');
    });

    it('should provide steps array schema definition', async () => {
      const result = await server.getWorkflowSchema();
      expect(result.content[0]).toBeDefined();
      const responseData = JSON.parse(result.content[0]!.text);
      
      expect(responseData.schema.properties.steps).toBeDefined();
      expect(responseData.schema.properties.steps.type).toBe('array');
      expect(responseData.schema.properties.steps.minItems).toBe(1);
      expect(responseData.schema.properties.steps.items).toBeDefined();
      
      // Schema uses oneOf with $ref to support both standard and loop steps
      const stepSchema = responseData.schema.properties.steps.items;
      expect(stepSchema.oneOf).toBeDefined();
      expect(Array.isArray(stepSchema.oneOf)).toBe(true);
      expect(stepSchema.oneOf.length).toBeGreaterThan(0);
      
      // Check that standard step is referenced
      const standardStepRef = stepSchema.oneOf.find(
        (ref: any) => ref.$ref === '#/$defs/standardStep'
      );
      expect(standardStepRef).toBeDefined();
      
      // Check that loop step is referenced
      const loopStepRef = stepSchema.oneOf.find(
        (ref: any) => ref.$ref === '#/$defs/loopStep'
      );
      expect(loopStepRef).toBeDefined();
      
      // Verify the $defs contain the actual step definitions
      expect(responseData.schema.$defs).toBeDefined();
      expect(responseData.schema.$defs.standardStep).toBeDefined();
      expect(responseData.schema.$defs.standardStep.type).toBe('object');
      expect(responseData.schema.$defs.standardStep.properties.id).toBeDefined();
      expect(responseData.schema.$defs.standardStep.properties.title).toBeDefined();
      expect(responseData.schema.$defs.standardStep.properties.prompt).toBeDefined();
    });

    it('should be formatted as valid JSON', async () => {
      const result = await server.getWorkflowSchema();
      expect(result.content[0]).toBeDefined();
      
      // This should not throw an error
      expect(() => JSON.parse(result.content[0]!.text)).not.toThrow();
      
      const responseData = JSON.parse(result.content[0]!.text);
      expect(typeof responseData).toBe('object');
      expect(responseData).not.toBeNull();
    });

    it('should return response in MCP tool format', async () => {
      const result = await server.getWorkflowSchema();
      
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toBeDefined();
      expect(result.content[0]!.type).toBe('text');
      expect(result.content[0]!.text).toBeDefined();
      expect(typeof result.content[0]!.text).toBe('string');
    });
  });
}); 