import { describe, it, expect } from 'vitest';
import { extractValidationRequirements } from '../../../src/v2/durable-core/domain/validation-requirements-extractor.js';
import type { ValidationCriteria } from '../../../src/types/validation.js';

describe('extractValidationRequirements', () => {
  describe('contains rules', () => {
    it('extracts simple contains rule', () => {
      const criteria: ValidationCriteria = {
        type: 'contains',
        value: 'planningComplete = true',
        message: 'Must set flag',
      };
      
      const result = extractValidationRequirements(criteria);
      
      expect(result).toEqual(['Must contain: "planningComplete = true"']);
    });
    
    it('returns empty for contains rule without value', () => {
      const criteria: ValidationCriteria = {
        type: 'contains',
        value: undefined,
        message: 'Invalid rule',
      };
      
      const result = extractValidationRequirements(criteria);
      
      expect(result).toEqual([]);
    });
  });
  
  describe('regex rules', () => {
    it('extracts simple regex rule', () => {
      const criteria: ValidationCriteria = {
        type: 'regex',
        pattern: '^[a-z]+$',
        message: 'Lowercase only',
      };
      
      const result = extractValidationRequirements(criteria);
      
      expect(result).toEqual(['Must match pattern: ^[a-z]+$']);
    });
    
    it('includes flags when present', () => {
      const criteria: ValidationCriteria = {
        type: 'regex',
        pattern: '[A-Z]+',
        flags: 'i',
        message: 'Case insensitive',
      };
      
      const result = extractValidationRequirements(criteria);
      
      expect(result).toEqual(['Must match pattern: [A-Z]+ (flags: i)']);
    });
    
    it('returns empty for regex rule without pattern', () => {
      const criteria: ValidationCriteria = {
        type: 'regex',
        pattern: undefined,
        message: 'Invalid rule',
      };
      
      const result = extractValidationRequirements(criteria);
      
      expect(result).toEqual([]);
    });
  });
  
  describe('length rules', () => {
    it('extracts min and max', () => {
      const criteria: ValidationCriteria = {
        type: 'length',
        min: 100,
        max: 500,
        message: '100-500 chars',
      };
      
      const result = extractValidationRequirements(criteria);
      
      expect(result).toEqual(['Length: ≥100 chars, ≤500 chars']);
    });
    
    it('extracts min only', () => {
      const criteria: ValidationCriteria = {
        type: 'length',
        min: 50,
        message: 'At least 50',
      };
      
      const result = extractValidationRequirements(criteria);
      
      expect(result).toEqual(['Length: ≥50 chars']);
    });
    
    it('extracts max only', () => {
      const criteria: ValidationCriteria = {
        type: 'length',
        max: 200,
        message: 'Max 200',
      };
      
      const result = extractValidationRequirements(criteria);
      
      expect(result).toEqual(['Length: ≤200 chars']);
    });
    
    it('returns empty for length rule without min or max', () => {
      const criteria: ValidationCriteria = {
        type: 'length',
        message: 'Invalid rule',
      };
      
      const result = extractValidationRequirements(criteria);
      
      expect(result).toEqual([]);
    });
  });
  
  describe('and compositions', () => {
    it('flattens multiple rules from and composition', () => {
      const criteria: ValidationCriteria = {
        and: [
          { type: 'contains', value: 'complete', message: 'Must mark complete' },
          { type: 'regex', pattern: '^[A-Z]', message: 'Start with capital' },
          { type: 'length', min: 10, max: 100, message: '10-100 chars' },
        ],
      };
      
      const result = extractValidationRequirements(criteria);
      
      expect(result).toEqual([
        'Must contain: "complete"',
        'Must match pattern: ^[A-Z]',
        'Length: ≥10 chars, ≤100 chars',
      ]);
    });
    
    it('handles nested and compositions', () => {
      const criteria: ValidationCriteria = {
        and: [
          {
            and: [
              { type: 'contains', value: 'inner1', message: 'Inner 1' },
              { type: 'contains', value: 'inner2', message: 'Inner 2' },
            ],
          },
          { type: 'contains', value: 'outer', message: 'Outer' },
        ],
      };
      
      const result = extractValidationRequirements(criteria);
      
      expect(result).toEqual([
        'Must contain: "inner1"',
        'Must contain: "inner2"',
        'Must contain: "outer"',
      ]);
    });
  });
  
  describe('capping at 5 requirements', () => {
    it('returns only first 5 requirements when more exist', () => {
      const criteria: ValidationCriteria = {
        and: [
          { type: 'contains', value: 'req1', message: '1' },
          { type: 'contains', value: 'req2', message: '2' },
          { type: 'contains', value: 'req3', message: '3' },
          { type: 'contains', value: 'req4', message: '4' },
          { type: 'contains', value: 'req5', message: '5' },
          { type: 'contains', value: 'req6', message: '6' },
          { type: 'contains', value: 'req7', message: '7' },
        ],
      };
      
      const result = extractValidationRequirements(criteria);
      
      expect(result).toHaveLength(5);
      expect(result).toEqual([
        'Must contain: "req1"',
        'Must contain: "req2"',
        'Must contain: "req3"',
        'Must contain: "req4"',
        'Must contain: "req5"',
      ]);
    });
  });
  
  describe('edge cases', () => {
    it('returns empty for undefined criteria', () => {
      const result = extractValidationRequirements(undefined);
      expect(result).toEqual([]);
    });
    
    it('returns empty for empty and composition', () => {
      const criteria: ValidationCriteria = { and: [] };
      const result = extractValidationRequirements(criteria);
      expect(result).toEqual([]);
    });
    
    it('skips malformed rules in composition', () => {
      const criteria: ValidationCriteria = {
        and: [
          { type: 'contains', value: 'valid', message: 'Valid' },
          { type: 'contains', value: undefined, message: 'Invalid' }, // No value
          { type: 'regex', pattern: 'also-valid', message: 'Also valid' },
        ],
      };
      
      const result = extractValidationRequirements(criteria);
      
      expect(result).toEqual([
        'Must contain: "valid"',
        'Must match pattern: also-valid',
      ]);
    });
    
    it('skips schema rules (not supported)', () => {
      const criteria: ValidationCriteria = {
        type: 'schema',
        schema: { type: 'object' },
        message: 'Must be object',
      };
      
      const result = extractValidationRequirements(criteria);
      
      expect(result).toEqual([]);
    });
    
    it('handles or composition (currently skipped)', () => {
      const criteria: ValidationCriteria = {
        or: [
          { type: 'contains', value: 'option1', message: 'Option 1' },
          { type: 'contains', value: 'option2', message: 'Option 2' },
        ],
      };
      
      const result = extractValidationRequirements(criteria);
      
      // Currently or is not supported - returns empty
      expect(result).toEqual([]);
    });
  });
  
  describe('fail-safe behavior', () => {
    it('returns empty array for malformed criteria that throw during parsing', () => {
      // Simulate malformed structure that might throw
      const malformed = { badStructure: true } as unknown as ValidationCriteria;
      
      const result = extractValidationRequirements(malformed);
      
      // Should not throw, should return empty
      expect(result).toEqual([]);
    });
  });
});
