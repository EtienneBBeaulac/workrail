import { describe, it, expect, beforeEach } from 'vitest';
import { SchemaRegistry } from '../../web/assets/services/schema-registry.js';

describe('SchemaRegistry', () => {
  let registry;
  
  beforeEach(() => {
    registry = new SchemaRegistry();
  });
  
  describe('Built-in Schemas', () => {
    it('should register bug-investigation schema', () => {
      expect(registry.has('bug-investigation')).toBe(true);
      const schema = registry.get('bug-investigation');
      expect(schema.name).toBe('Bug Investigation');
      expect(schema.fields).toHaveProperty('dashboard');
      expect(schema.fields).toHaveProperty('hypotheses');
    });
    
    it('should register code-review schema', () => {
      expect(registry.has('code-review')).toBe(true);
      const schema = registry.get('code-review');
      expect(schema.name).toBe('Code Review');
      expect(schema.fields).toHaveProperty('changes');
      expect(schema.fields).toHaveProperty('findings');
    });
    
    it('should register test-results schema', () => {
      expect(registry.has('test-results')).toBe(true);
      const schema = registry.get('test-results');
      expect(schema.name).toBe('Test Results');
      expect(schema.fields).toHaveProperty('tests');
      expect(schema.fields).toHaveProperty('summary');
    });
  });
  
  describe('Schema Registration', () => {
    it('should register custom schema', () => {
      const schema = {
        name: 'Custom Workflow',
        description: 'Test workflow',
        fields: {
          title: { type: 'string', required: true }
        }
      };
      
      registry.register('custom', schema);
      expect(registry.has('custom')).toBe(true);
      expect(registry.get('custom')).toEqual(schema);
    });
    
    it('should throw error for invalid workflow type', () => {
      expect(() => registry.register(null, {})).toThrow();
      expect(() => registry.register('', {})).toThrow();
    });
    
    it('should throw error for invalid schema', () => {
      expect(() => registry.register('test', null)).toThrow();
      expect(() => registry.register('test', 'not-an-object')).toThrow();
    });
  });
  
  describe('Field Validation - Strings', () => {
    it('should validate required string field', () => {
      const errors = registry.validateField(null, { type: 'string', required: true }, 'field');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toContain('required');
    });
    
    it('should accept valid string', () => {
      const errors = registry.validateField('test', { type: 'string' }, 'field');
      expect(errors).toHaveLength(0);
    });
    
    it('should validate string enum', () => {
      const errors = registry.validateField('invalid', { 
        type: 'string', 
        enum: ['pending', 'active', 'done'] 
      }, 'status');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toContain('one of');
    });
    
    it('should accept valid enum value', () => {
      const errors = registry.validateField('active', { 
        type: 'string', 
        enum: ['pending', 'active', 'done'] 
      }, 'status');
      expect(errors).toHaveLength(0);
    });
    
    it('should validate ISO date format', () => {
      const errors = registry.validateField('not-a-date', { 
        type: 'string', 
        format: 'iso-date' 
      }, 'timestamp');
      expect(errors.length).toBeGreaterThan(0);
    });
    
    it('should accept valid ISO date', () => {
      const errors = registry.validateField('2025-10-11T12:00:00Z', { 
        type: 'string', 
        format: 'iso-date' 
      }, 'timestamp');
      expect(errors).toHaveLength(0);
    });
    
    it('should validate string length', () => {
      const errors = registry.validateField('ab', { 
        type: 'string', 
        minLength: 5 
      }, 'field');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toContain('at least 5');
    });
  });
  
  describe('Field Validation - Numbers', () => {
    it('should accept valid number', () => {
      const errors = registry.validateField(42, { type: 'number' }, 'field');
      expect(errors).toHaveLength(0);
    });
    
    it('should validate number range - minimum', () => {
      const errors = registry.validateField(5, { type: 'number', min: 10 }, 'field');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toContain('at least 10');
    });
    
    it('should validate number range - maximum', () => {
      const errors = registry.validateField(15, { type: 'number', max: 10 }, 'field');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toContain('not exceed 10');
    });
    
    it('should validate integer constraint', () => {
      const errors = registry.validateField(3.14, { type: 'number', integer: true }, 'field');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toContain('integer');
    });
    
    it('should accept valid integer', () => {
      const errors = registry.validateField(42, { type: 'number', integer: true }, 'field');
      expect(errors).toHaveLength(0);
    });
  });
  
  describe('Field Validation - Arrays', () => {
    it('should accept valid array', () => {
      const errors = registry.validateField([1, 2, 3], { type: 'array' }, 'field');
      expect(errors).toHaveLength(0);
    });
    
    it('should validate array length - minimum', () => {
      const errors = registry.validateField([1], { type: 'array', minItems: 3 }, 'field');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toContain('at least 3 items');
    });
    
    it('should validate array length - maximum', () => {
      const errors = registry.validateField([1, 2, 3, 4], { type: 'array', maxItems: 2 }, 'field');
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toContain('not exceed 2 items');
    });
    
    it('should validate array items', () => {
      const data = [
        { name: 'test', value: 5 },
        { name: 'test2' }  // missing value
      ];
      
      const errors = registry.validateField(data, {
        type: 'array',
        itemSchema: {
          name: { type: 'string', required: true },
          value: { type: 'number', required: true }
        }
      }, 'items');
      
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.path.includes('[1]'))).toBe(true);
    });
  });
  
  describe('Field Validation - Objects', () => {
    it('should validate nested object fields', () => {
      const data = {
        title: 'Test',
        value: 'not-a-number'  // should be number
      };
      
      const errors = registry.validateField(data, {
        type: 'object',
        schema: {
          title: { type: 'string', required: true },
          value: { type: 'number', required: true }
        }
      }, 'obj');
      
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.path === 'obj.value')).toBe(true);
    });
    
    it('should validate required nested fields', () => {
      const data = {
        title: 'Test'
        // missing required field
      };
      
      const errors = registry.validateField(data, {
        type: 'object',
        schema: {
          title: { type: 'string', required: true },
          value: { type: 'number', required: true }
        }
      }, 'obj');
      
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.message.includes('required'))).toBe(true);
    });
  });
  
  describe('Full Data Validation', () => {
    it('should validate bug-investigation data', () => {
      const validData = {
        dashboard: {
          title: 'Test Bug',
          status: 'in_progress',
          progress: 50,
          confidence: 7
        },
        hypotheses: [
          {
            description: 'Hypothesis 1',
            status: 'active',
            confidence: 6
          }
        ]
      };
      
      const result = registry.validate(validData, 'bug-investigation');
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
    
    it('should detect invalid dashboard status', () => {
      const invalidData = {
        dashboard: {
          title: 'Test',
          status: 'invalid-status'  // not in enum
        }
      };
      
      const result = registry.validate(invalidData, 'bug-investigation');
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
    
    it('should detect invalid progress range', () => {
      const invalidData = {
        dashboard: {
          title: 'Test',
          progress: 150  // exceeds max of 100
        }
      };
      
      const result = registry.validate(invalidData, 'bug-investigation');
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.path === 'dashboard.progress')).toBe(true);
    });
    
    it('should warn about unknown fields', () => {
      const dataWithUnknown = {
        dashboard: { title: 'Test' },
        unknownField: 'value'
      };
      
      const result = registry.validate(dataWithUnknown, 'bug-investigation');
      expect(result.warnings.some(w => w.includes('unknownField'))).toBe(true);
    });
    
    it('should return warning for unknown workflow type', () => {
      const result = registry.validate({}, 'unknown-workflow');
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('No schema found');
    });
  });
  
  describe('TypeScript Generation', () => {
    it('should generate TypeScript interface', () => {
      const ts = registry.generateTypeScript('bug-investigation');
      expect(ts).toContain('export interface');
      expect(ts).toContain('BugInvestigationData');
      expect(ts).toContain('dashboard');
      expect(ts).toContain('hypotheses');
    });
    
    it('should handle optional fields', () => {
      registry.register('test', {
        name: 'Test',
        description: 'Test schema',
        fields: {
          required: { type: 'string', required: true },
          optional: { type: 'string', required: false }
        }
      });
      
      const ts = registry.generateTypeScript('test');
      expect(ts).toContain('required: string');
      expect(ts).toContain('optional?: string');
    });
    
    it('should handle enum types', () => {
      const ts = registry.generateTypeScript('bug-investigation');
      expect(ts).toContain("'pending' | 'in_progress' | 'completed'");
    });
    
    it('should return comment for unknown workflow', () => {
      const ts = registry.generateTypeScript('unknown');
      expect(ts).toContain('No schema found');
    });
  });
  
  describe('Schema Listing', () => {
    it('should list all registered schemas', () => {
      const schemas = registry.list();
      expect(schemas.length).toBeGreaterThanOrEqual(3);  // At least the 3 built-in schemas
      
      expect(schemas.some(s => s.type === 'bug-investigation')).toBe(true);
      expect(schemas.some(s => s.type === 'code-review')).toBe(true);
      expect(schemas.some(s => s.type === 'test-results')).toBe(true);
    });
    
    it('should include schema metadata', () => {
      const schemas = registry.list();
      const bugSchema = schemas.find(s => s.type === 'bug-investigation');
      
      expect(bugSchema).toHaveProperty('name');
      expect(bugSchema).toHaveProperty('description');
      expect(bugSchema).toHaveProperty('fieldCount');
      expect(bugSchema.fieldCount).toBeGreaterThan(0);
    });
  });
  
  describe('Validation Summary', () => {
    it('should format valid result', () => {
      const result = { valid: true, errors: [], warnings: [] };
      const summary = registry.getValidationSummary(result);
      expect(summary).toContain('✅');
      expect(summary).toContain('valid');
    });
    
    it('should format errors', () => {
      const result = {
        valid: false,
        errors: [
          { path: 'field1', message: 'Error 1' },
          { path: 'field2', message: 'Error 2' }
        ],
        warnings: []
      };
      const summary = registry.getValidationSummary(result);
      expect(summary).toContain('❌');
      expect(summary).toContain('Error 1');
      expect(summary).toContain('Error 2');
    });
    
    it('should format warnings', () => {
      const result = {
        valid: true,
        errors: [],
        warnings: ['Warning 1', 'Warning 2']
      };
      const summary = registry.getValidationSummary(result);
      expect(summary).toContain('⚠️');
      expect(summary).toContain('Warning 1');
    });
    
    it('should limit warnings display', () => {
      const result = {
        valid: true,
        errors: [],
        warnings: Array(10).fill('Warning')
      };
      const summary = registry.getValidationSummary(result);
      expect(summary).toContain('and 5 more');
    });
  });
});






