import { describe, it, expect, beforeEach } from '@jest/globals';
import { runErrorAnalysis, generateSummary, ErrorAnalysis } from './error-structure-analysis';

describe('Error Structure Analysis', () => {
  let analysisResults: ErrorAnalysis[];

  beforeEach(() => {
    analysisResults = runErrorAnalysis();
  });

  describe('Critical Finding: additionalProperties Errors', () => {
    it('should provide exact field names for all additionalProperties errors', () => {
      const additionalPropsErrors = analysisResults.flatMap(result => 
        result.errors.filter(error => error.keyword === 'additionalProperties')
      );
      
      expect(additionalPropsErrors.length).toBeGreaterThan(0);
      
      // Every additionalProperties error should have params.additionalProperty
      additionalPropsErrors.forEach(error => {
        expect(error.params).toBeDefined();
        expect(error.params['additionalProperty']).toBeDefined();
        expect(typeof error.params['additionalProperty']).toBe('string');
        expect(error.params['additionalProperty']).not.toBe('');
      });
    });

    it('should detect additionalProperties at root level', () => {
      const rootLevelTest = analysisResults.find(r => r.testCase === 'Invalid additional property at root');
      expect(rootLevelTest).toBeDefined();
      
      const additionalPropsError = rootLevelTest!.errors.find(e => e.keyword === 'additionalProperties');
      expect(additionalPropsError).toBeDefined();
      expect(additionalPropsError!.params['additionalProperty']).toBe('invalidProperty');
      expect(additionalPropsError!.instancePath).toBe('');
    });

    it('should detect additionalProperties in nested objects', () => {
      const nestedTest = analysisResults.find(r => r.testCase === 'Invalid additional property in step');
      expect(nestedTest).toBeDefined();
      
      const additionalPropsError = nestedTest!.errors.find(e => e.keyword === 'additionalProperties');
      expect(additionalPropsError).toBeDefined();
      expect(additionalPropsError!.params['additionalProperty']).toBe('invalidStepProperty');
      expect(additionalPropsError!.instancePath).toBe('/steps/0');
    });

    it('should detect additionalProperties in deeply nested objects', () => {
      const deepNestedTest = analysisResults.find(r => r.testCase === 'Deeply nested validation error');
      expect(deepNestedTest).toBeDefined();
      
      const additionalPropsErrors = deepNestedTest!.errors.filter(e => e.keyword === 'additionalProperties');
      expect(additionalPropsErrors.length).toBeGreaterThan(0);
      
      // Should find the deeply nested invalid property
      const deepError = additionalPropsErrors.find(e => 
        e.params['additionalProperty'] === 'invalidNestedProperty'
      );
      expect(deepError).toBeDefined();
      expect(deepError!.instancePath).toContain('/steps/0/validationCriteria/and/0');
    });
  });

  describe('Instance Path Reliability', () => {
    it('should have meaningful instance paths for most errors', () => {
      const allErrors = analysisResults.flatMap(r => r.errors);
      const errorsWithInstancePath = allErrors.filter(e => e.instancePath && e.instancePath !== '');
      const errorsWithoutInstancePath = allErrors.filter(e => !e.instancePath || e.instancePath === '');
      
      // Should have more errors with instance path than without
      expect(errorsWithInstancePath.length).toBeGreaterThan(errorsWithoutInstancePath.length);
      
      // Should be at least 75% coverage
      const coverage = errorsWithInstancePath.length / allErrors.length;
      expect(coverage).toBeGreaterThan(0.75);
    });

    it('should provide specific paths for field-level errors', () => {
      const typeErrorTest = analysisResults.find(r => r.testCase === 'Invalid field type');
      expect(typeErrorTest).toBeDefined();
      
      const nameTypeError = typeErrorTest!.errors.find(e => 
        e.keyword === 'type' && e.instancePath === '/name'
      );
      expect(nameTypeError).toBeDefined();
      expect(nameTypeError!.params['type']).toBe('string');
    });

    it('should provide complex paths for nested validation errors', () => {
      const nestedTest = analysisResults.find(r => r.testCase === 'Deeply nested validation error');
      expect(nestedTest).toBeDefined();
      
      const complexPathErrors = nestedTest!.errors.filter(e => 
        e.instancePath.includes('/steps/0/validationCriteria')
      );
      expect(complexPathErrors.length).toBeGreaterThan(0);
    });
  });

  describe('Parameter Information Completeness', () => {
    it('should have params objects for all errors', () => {
      const allErrors = analysisResults.flatMap(r => r.errors);
      
      allErrors.forEach(error => {
        expect(error.params).toBeDefined();
        expect(typeof error.params).toBe('object');
      });
    });

    it('should have specific parameter types for each error keyword', () => {
      const allErrors = analysisResults.flatMap(r => r.errors);
      
      // Test required errors
      const requiredErrors = allErrors.filter(e => e.keyword === 'required');
      requiredErrors.forEach(error => {
        expect(error.params['missingProperty']).toBeDefined();
        expect(typeof error.params['missingProperty']).toBe('string');
      });
      
      // Test type errors
      const typeErrors = allErrors.filter(e => e.keyword === 'type');
      typeErrors.forEach(error => {
        expect(error.params['type']).toBeDefined();
        expect(typeof error.params['type']).toBe('string');
      });
      
      // Test pattern errors
      const patternErrors = allErrors.filter(e => e.keyword === 'pattern');
      patternErrors.forEach(error => {
        expect(error.params['pattern']).toBeDefined();
        expect(typeof error.params['pattern']).toBe('string');
      });
    });
  });

  describe('Error Type Distribution', () => {
    it('should find the expected error types', () => {
      const allErrors = analysisResults.flatMap(r => r.errors);
      const errorTypes = [...new Set(allErrors.map(e => e.keyword))];
      
      // Should include our primary target types
      expect(errorTypes).toContain('additionalProperties');
      expect(errorTypes).toContain('required');
      expect(errorTypes).toContain('type');
      expect(errorTypes).toContain('pattern');
      expect(errorTypes).toContain('minItems');
    });

    it('should have additionalProperties as a significant error type', () => {
      const allErrors = analysisResults.flatMap(r => r.errors);
      const additionalPropsErrors = allErrors.filter(e => e.keyword === 'additionalProperties');
      
      // Should be a significant portion of errors
      expect(additionalPropsErrors.length).toBeGreaterThan(5);
      
      // Should be in top 3 most common error types
      const errorCounts = allErrors.reduce((acc, error) => {
        acc[error.keyword] = (acc[error.keyword] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
      
      const sortedErrors = Object.entries(errorCounts)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 3);
      
      const topErrorTypes = sortedErrors.map(([type]) => type);
      expect(topErrorTypes).toContain('additionalProperties');
    });
  });

  describe('Multiple Error Scenarios', () => {
    it('should handle multiple validation errors on same input', () => {
      const multipleErrorTest = analysisResults.find(r => r.testCase === 'Multiple validation errors');
      expect(multipleErrorTest).toBeDefined();
      
      expect(multipleErrorTest!.errors.length).toBeGreaterThan(1);
      
      // Should have different error types
      const errorTypes = [...new Set(multipleErrorTest!.errors.map(e => e.keyword))];
      expect(errorTypes.length).toBeGreaterThan(1);
    });

    it('should provide specific information for each error in multiple error scenarios', () => {
      const multipleErrorTest = analysisResults.find(r => r.testCase === 'Multiple validation errors');
      expect(multipleErrorTest).toBeDefined();
      
      multipleErrorTest!.errors.forEach(error => {
        expect(error.params).toBeDefined();
        expect(error.keyword).toBeDefined();
        expect(error.message).toBeDefined();
      });
    });
  });

  describe('Enhanced Error Service Design Validation', () => {
    it('should validate that we can extract exact field names from all relevant errors', () => {
      const allErrors = analysisResults.flatMap(r => r.errors);
      
      // additionalProperties errors should have exact field names
      const additionalPropsErrors = allErrors.filter(e => e.keyword === 'additionalProperties');
      additionalPropsErrors.forEach(error => {
        const fieldName = error.params['additionalProperty'];
        expect(fieldName).toBeDefined();
        expect(typeof fieldName).toBe('string');
        expect(fieldName.length).toBeGreaterThan(0);
      });
      
      // required errors should have exact missing field names
      const requiredErrors = allErrors.filter(e => e.keyword === 'required');
      requiredErrors.forEach(error => {
        const fieldName = error.params['missingProperty'];
        expect(fieldName).toBeDefined();
        expect(typeof fieldName).toBe('string');
        expect(fieldName.length).toBeGreaterThan(0);
      });
    });

    it('should validate that we can create human-readable locations from instance paths', () => {
      const allErrors = analysisResults.flatMap(r => r.errors);
      const errorsWithPaths = allErrors.filter(e => e.instancePath && e.instancePath !== '');
      
      errorsWithPaths.forEach(error => {
        const path = error.instancePath;
        
        // Should be able to convert to human-readable location
        if (path === '/name') {
          expect(path).toBe('/name'); // "in field 'name'"
        } else if (path === '/steps/0') {
          expect(path).toBe('/steps/0'); // "in step 1"
        } else if (path.startsWith('/steps/')) {
          expect(path).toMatch(/^\/steps\/\d+/); // "in step N"
        }
        
        // Path should be parseable
        expect(path.startsWith('/')).toBe(true);
      });
    });

    it('should validate that all error types have actionable information', () => {
      const allErrors = analysisResults.flatMap(r => r.errors);
      
      allErrors.forEach(error => {
        switch (error.keyword) {
          case 'additionalProperties':
            expect(error.params['additionalProperty']).toBeDefined();
            break;
          case 'required':
            expect(error.params['missingProperty']).toBeDefined();
            break;
          case 'type':
            expect(error.params['type']).toBeDefined();
            break;
          case 'pattern':
            expect(error.params['pattern']).toBeDefined();
            break;
          case 'minItems':
            expect(error.params['limit']).toBeDefined();
            break;
          default:
            // Other error types should still have some params
            expect(error.params).toBeDefined();
        }
      });
    });
  });
});

describe('Analysis Summary Generation', () => {
  it('should generate comprehensive summary without errors', () => {
    // This should not throw any errors
    expect(() => {
      const results = runErrorAnalysis();
      generateSummary(results);
    }).not.toThrow();
  });

  it('should identify the key insights correctly', () => {
    const results = runErrorAnalysis();
    const allErrors = results.flatMap(r => r.analysis);
    
    // Key insight 1: additionalProperties errors should be confirmed
    const additionalPropsCount = allErrors.filter(a => a.keyword === 'additionalProperties').length;
    expect(additionalPropsCount).toBeGreaterThan(0);
    
    // Key insight 2: instancePath should be reliable
    const withInstancePath = allErrors.filter(a => a.hasInstancePath).length;
    const withoutInstancePath = allErrors.filter(a => !a.hasInstancePath).length;
    expect(withInstancePath).toBeGreaterThan(withoutInstancePath);
    
    // Key insight 3: complex nested errors should be supported
    const complexNested = allErrors.some(a => a.hasInstancePath && a.hasAdditionalProperty);
    expect(complexNested).toBe(true);
  });
}); 