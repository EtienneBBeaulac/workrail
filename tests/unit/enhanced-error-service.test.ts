import { describe, it, expect } from 'vitest';
import { ErrorObject } from 'ajv';
import { EnhancedErrorService } from '../../src/application/services/enhanced-error-service';

describe('EnhancedErrorService', () => {
  describe('enhanceErrors', () => {
    it('should return empty array for empty input', () => {
      expect(EnhancedErrorService.enhanceErrors([])).toEqual([]);
    });

    it('should return empty array for null/undefined input', () => {
      expect(EnhancedErrorService.enhanceErrors(null as any)).toEqual([]);
      expect(EnhancedErrorService.enhanceErrors(undefined as any)).toEqual([]);
    });

    it('should prioritize critical errors first', () => {
      const errors: ErrorObject[] = [
        {
          keyword: 'oneOf',
          instancePath: '/steps/0',
          schemaPath: '#/steps/0/oneOf',
          params: {},
          message: 'must match exactly one schema in oneOf'
        },
        {
          keyword: 'additionalProperties',
          instancePath: '/steps/0',
          schemaPath: '#/steps/0/additionalProperties',
          params: { additionalProperty: 'invalidField' },
          message: 'must NOT have additional properties'
        },
        {
          keyword: 'required',
          instancePath: '/steps/0',
          schemaPath: '#/steps/0/required',
          params: { missingProperty: 'name' },
          message: 'must have required property \'name\''
        }
      ];

      const result = EnhancedErrorService.enhanceErrors(errors);
      
      // Critical errors (additionalProperties, required) should come first
      expect(result[0]).toContain('Unexpected property');
      expect(result[1]).toContain('Missing required field');
      expect(result[2]).toContain('must match exactly one');
    });
  });

  describe('additionalProperties error handling', () => {
    it('should provide exact field name for root level additional properties', () => {
      const error: ErrorObject = {
        keyword: 'additionalProperties',
        instancePath: '',
        schemaPath: '#/additionalProperties',
        params: { additionalProperty: 'invalidField' },
        message: 'must NOT have additional properties'
      };

      const result = EnhancedErrorService.enhanceErrors([error]);
      
      expect(result[0]).toBe(
        "Unexpected property 'invalidField' found at root level. This property is not defined in the workflow schema. Please remove it or check for typos."
      );
    });

    it('should provide exact field name for step level additional properties', () => {
      const error: ErrorObject = {
        keyword: 'additionalProperties',
        instancePath: '/steps/0',
        schemaPath: '#/steps/0/additionalProperties',
        params: { additionalProperty: 'invalidStepProperty' },
        message: 'must NOT have additional properties'
      };

      const result = EnhancedErrorService.enhanceErrors([error]);
      
      expect(result[0]).toBe(
        "Unexpected property 'invalidStepProperty' found in step 1. This property is not defined in the workflow schema. Please remove it or check for typos."
      );
    });

    it('should provide exact field name for deeply nested additional properties', () => {
      const error: ErrorObject = {
        keyword: 'additionalProperties',
        instancePath: '/steps/0/validationCriteria/and/0',
        schemaPath: '#/steps/0/validationCriteria/and/0/additionalProperties',
        params: { additionalProperty: 'invalidNestedProperty' },
        message: 'must NOT have additional properties'
      };

      const result = EnhancedErrorService.enhanceErrors([error]);
      
      expect(result[0]).toBe(
        "Unexpected property 'invalidNestedProperty' found in step 1, validation criteria. This property is not defined in the workflow schema. Please remove it or check for typos."
      );
    });

    it('should handle missing additionalProperty parameter gracefully', () => {
      const error: ErrorObject = {
        keyword: 'additionalProperties',
        instancePath: '/steps/0',
        schemaPath: '#/steps/0/additionalProperties',
        params: {},
        message: 'must NOT have additional properties'
      };

      const result = EnhancedErrorService.enhanceErrors([error]);
      
      expect(result[0]).toBe(
        "Unexpected property found in step 1. Please check the workflow schema for allowed properties."
      );
    });
  });

  describe('required field error handling', () => {
    it('should provide exact missing field name', () => {
      const error: ErrorObject = {
        keyword: 'required',
        instancePath: '/steps/0',
        schemaPath: '#/steps/0/required',
        params: { missingProperty: 'name' },
        message: 'must have required property \'name\''
      };

      const result = EnhancedErrorService.enhanceErrors([error]);
      
      expect(result[0]).toBe(
        "Missing required field 'name' in step 1. This field is mandatory and must be provided."
      );
    });

    it('should handle missing missingProperty parameter gracefully', () => {
      const error: ErrorObject = {
        keyword: 'required',
        instancePath: '',
        schemaPath: '#/required',
        params: {},
        message: 'must have required property'
      };

      const result = EnhancedErrorService.enhanceErrors([error]);
      
      expect(result[0]).toBe(
        "Missing required field at root level. Please check the workflow schema for required properties."
      );
    });
  });

  describe('type mismatch error handling', () => {
    it('should provide expected type information', () => {
      const error: ErrorObject = {
        keyword: 'type',
        instancePath: '/name',
        schemaPath: '#/properties/name/type',
        params: { type: 'string' },
        message: 'must be string'
      };

      const result = EnhancedErrorService.enhanceErrors([error]);
      
      expect(result[0]).toBe(
        "Invalid data type in field 'name'. Expected 'string' but received a different type."
      );
    });

    it('should handle missing type parameter gracefully', () => {
      const error: ErrorObject = {
        keyword: 'type',
        instancePath: '/version',
        schemaPath: '#/properties/version/type',
        params: {},
        message: 'must be string'
      };

      const result = EnhancedErrorService.enhanceErrors([error]);
      
      expect(result[0]).toBe(
        "Invalid data type in field 'version'. Please check the expected type in the workflow schema."
      );
    });
  });

  describe('pattern validation error handling', () => {
    it('should provide the specific pattern that failed', () => {
      const error: ErrorObject = {
        keyword: 'pattern',
        instancePath: '/name',
        schemaPath: '#/properties/name/pattern',
        params: { pattern: '^[a-zA-Z][a-zA-Z0-9_-]*$' },
        message: 'must match pattern "^[a-zA-Z][a-zA-Z0-9_-]*$"'
      };

      const result = EnhancedErrorService.enhanceErrors([error]);
      
      expect(result[0]).toBe(
        "Value in field 'name' does not match the required pattern: ^[a-zA-Z][a-zA-Z0-9_-]*$"
      );
    });
  });

  describe('array constraint error handling', () => {
    it('should handle minItems errors with specific limits', () => {
      const error: ErrorObject = {
        keyword: 'minItems',
        instancePath: '/steps',
        schemaPath: '#/properties/steps/minItems',
        params: { limit: 1 },
        message: 'must NOT have fewer than 1 items'
      };

      const result = EnhancedErrorService.enhanceErrors([error]);
      
      expect(result[0]).toBe(
        "Array in 'steps' array must contain at least 1 item(s)."
      );
    });

    it('should handle maxItems errors with specific limits', () => {
      const error: ErrorObject = {
        keyword: 'maxItems',
        instancePath: '/steps',
        schemaPath: '#/properties/steps/maxItems',
        params: { limit: 10 },
        message: 'must NOT have more than 10 items'
      };

      const result = EnhancedErrorService.enhanceErrors([error]);
      
      expect(result[0]).toBe(
        "Array in 'steps' array must contain no more than 10 item(s)."
      );
    });
  });

  describe('enum validation error handling', () => {
    it('should provide allowed values for enum errors', () => {
      const error: ErrorObject = {
        keyword: 'enum',
        instancePath: '/steps/0/agentRole',
        schemaPath: '#/properties/steps/items/properties/agentRole/enum',
        params: { allowedValues: ['analyst', 'implementer', 'reviewer'] },
        message: 'must be equal to one of the allowed values'
      };

      const result = EnhancedErrorService.enhanceErrors([error]);
      
      expect(result[0]).toBe(
        "Value in step 1, field 'agentRole' must be one of: 'analyst', 'implementer', 'reviewer'"
      );
    });

    it('should handle missing allowedValues parameter gracefully', () => {
      const error: ErrorObject = {
        keyword: 'enum',
        instancePath: '/steps/0/agentRole',
        schemaPath: '#/properties/steps/items/properties/agentRole/enum',
        params: {},
        message: 'must be equal to one of the allowed values'
      };

      const result = EnhancedErrorService.enhanceErrors([error]);
      
      expect(result[0]).toBe(
        "Value in step 1, field 'agentRole' is not one of the allowed values."
      );
    });
  });

  describe('schema composition error handling', () => {
    it('should handle oneOf errors with clear guidance', () => {
      const error: ErrorObject = {
        keyword: 'oneOf',
        instancePath: '/steps/0/validationCriteria',
        schemaPath: '#/properties/steps/items/properties/validationCriteria/oneOf',
        params: {},
        message: 'must match exactly one schema in oneOf'
      };

      const result = EnhancedErrorService.enhanceErrors([error]);
      
      expect(result[0]).toBe(
        "Value in step 1, field 'validationCriteria' must match exactly one of the allowed schema patterns. Please check the workflow schema for valid formats."
      );
    });

    it('should handle anyOf errors with clear guidance', () => {
      const error: ErrorObject = {
        keyword: 'anyOf',
        instancePath: '/steps/0/condition',
        schemaPath: '#/properties/steps/items/properties/condition/anyOf',
        params: {},
        message: 'must match a schema in anyOf'
      };

      const result = EnhancedErrorService.enhanceErrors([error]);
      
      expect(result[0]).toBe(
        "Value in step 1, field 'condition' must match at least one of the allowed schema patterns. Please check the workflow schema for valid formats."
      );
    });
  });

  describe('location description generation', () => {
    it('should handle common field paths correctly', () => {
      const testCases = [
        { path: '', expected: 'at root level' },
        { path: '/name', expected: "in field 'name'" },
        { path: '/description', expected: "in field 'description'" },
        { path: '/version', expected: "in field 'version'" },
        { path: '/steps', expected: "in 'steps' array" },
        { path: '/steps/0', expected: 'in step 1' },
        { path: '/steps/5', expected: 'in step 6' },
        { path: '/steps/0/name', expected: "in step 1, field 'name'" },
        { path: '/steps/0/validationCriteria/and/0', expected: 'in step 1, validation criteria' },
        { path: '/complex/nested/path', expected: "at 'complex.nested.path'" }
      ];

      testCases.forEach(({ path, expected }) => {
        const error: ErrorObject = {
          keyword: 'additionalProperties',
          instancePath: path,
          schemaPath: '#/additionalProperties',
          params: { additionalProperty: 'test' },
          message: 'must NOT have additional properties'
        };

        const result = EnhancedErrorService.enhanceErrors([error]);
        expect(result[0]).toContain(expected);
      });
    });
  });

  describe('generic error handling', () => {
    it('should handle unknown error types gracefully', () => {
      const error: ErrorObject = {
        keyword: 'unknownKeyword',
        instancePath: '/test',
        schemaPath: '#/test',
        params: {},
        message: 'unknown error occurred'
      };

      const result = EnhancedErrorService.enhanceErrors([error]);
      
      expect(result[0]).toBe(
        "Validation error at 'test': unknown error occurred"
      );
    });

    it('should handle missing error message gracefully', () => {
      const error: ErrorObject = {
        keyword: 'unknownKeyword',
        instancePath: '/test',
        schemaPath: '#/test',
        params: {},
        message: undefined as any
      };

      const result = EnhancedErrorService.enhanceErrors([error]);
      
      expect(result[0]).toBe(
        "Validation error at 'test': Unknown validation error"
      );
    });
  });

  describe('integration with real error scenarios', () => {
    it('should handle complex multi-error scenarios from our analysis', () => {
      const errors: ErrorObject[] = [
        // Root level additional property
        {
          keyword: 'additionalProperties',
          instancePath: '',
          schemaPath: '#/additionalProperties',
          params: { additionalProperty: 'invalidField' },
          message: 'must NOT have additional properties'
        },
        // Missing required field
        {
          keyword: 'required',
          instancePath: '/steps/0',
          schemaPath: '#/steps/0/required',
          params: { missingProperty: 'name' },
          message: 'must have required property \'name\''
        },
        // Type mismatch
        {
          keyword: 'type',
          instancePath: '/version',
          schemaPath: '#/properties/version/type',
          params: { type: 'string' },
          message: 'must be string'
        },
        // Array constraint
        {
          keyword: 'minItems',
          instancePath: '/steps',
          schemaPath: '#/properties/steps/minItems',
          params: { limit: 1 },
          message: 'must NOT have fewer than 1 items'
        }
      ];

      const result = EnhancedErrorService.enhanceErrors(errors);
      
      expect(result).toHaveLength(4);
      
      // Check that all errors are enhanced with specific details
      expect(result[0]).toContain('invalidField');
      expect(result[1]).toContain('name');
      expect(result[2]).toContain('string');
      expect(result[3]).toContain('at least 1');
      
      // Check that they're prioritized correctly (critical errors first)
      expect(result[0]).toContain('Unexpected property');
      expect(result[1]).toContain('Missing required field');
    });
  });
}); 