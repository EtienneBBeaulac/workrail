import { evaluateCondition, validateCondition } from '../../src/utils/condition-evaluator';

describe('Condition Evaluator', () => {
  describe('evaluateCondition', () => {
    it('should return true for null/undefined conditions', () => {
      expect(evaluateCondition(null)).toBe(true);
      expect(evaluateCondition(undefined)).toBe(true);
      expect(evaluateCondition({})).toBe(true);
    });

    it('should evaluate simple variable conditions', () => {
      const context = { taskScope: 'small', userLevel: 'expert' };
      
      expect(evaluateCondition({ var: 'taskScope', equals: 'small' }, context)).toBe(true);
      expect(evaluateCondition({ var: 'taskScope', equals: 'large' }, context)).toBe(false);
      expect(evaluateCondition({ var: 'userLevel', not_equals: 'novice' }, context)).toBe(true);
      expect(evaluateCondition({ var: 'userLevel', not_equals: 'expert' }, context)).toBe(false);
    });

    it('should evaluate numeric comparisons', () => {
      const context = { complexity: 0.7, score: 85 };
      
      expect(evaluateCondition({ var: 'complexity', gt: 0.5 }, context)).toBe(true);
      expect(evaluateCondition({ var: 'complexity', gt: 0.8 }, context)).toBe(false);
      expect(evaluateCondition({ var: 'complexity', gte: 0.7 }, context)).toBe(true);
      expect(evaluateCondition({ var: 'score', lt: 100 }, context)).toBe(true);
      expect(evaluateCondition({ var: 'score', lte: 85 }, context)).toBe(true);
      expect(evaluateCondition({ var: 'score', lte: 80 }, context)).toBe(false);
    });

    it('should evaluate logical operators', () => {
      const context = { taskScope: 'large', userLevel: 'expert', complexity: 0.8 };
      
      expect(evaluateCondition({
        and: [
          { var: 'taskScope', equals: 'large' },
          { var: 'userLevel', equals: 'expert' }
        ]
      }, context)).toBe(true);
      
      expect(evaluateCondition({
        or: [
          { var: 'taskScope', equals: 'small' },
          { var: 'userLevel', equals: 'expert' }
        ]
      }, context)).toBe(true);
      
      expect(evaluateCondition({
        not: { var: 'taskScope', equals: 'small' }
      }, context)).toBe(true);
    });

    it('should handle missing variables gracefully', () => {
      const context = { taskScope: 'small' };
      
      expect(evaluateCondition({ var: 'nonexistent', equals: 'value' }, context)).toBe(false);
      expect(evaluateCondition({ var: 'nonexistent', gt: 0 }, context)).toBe(false);
    });

    it('should handle invalid conditions safely', () => {
      const context = { taskScope: 'small' };
      
      // Test with invalid condition objects by casting to any
      expect(evaluateCondition({ invalid: 'operator' } as any, context)).toBe(false);
      expect(evaluateCondition({ and: 'not-an-array' } as any, context)).toBe(false);
    });

    it('should evaluate variable truthiness', () => {
      const context = { enabled: true, disabled: false, empty: '', value: 'test' };
      
      expect(evaluateCondition({ var: 'enabled' }, context)).toBe(true);
      expect(evaluateCondition({ var: 'disabled' }, context)).toBe(false);
      expect(evaluateCondition({ var: 'empty' }, context)).toBe(false);
      expect(evaluateCondition({ var: 'value' }, context)).toBe(true);
    });

    it('should perform case-insensitive string comparisons', () => {
      const context = { status: 'Active', mode: '  PRODUCTION  ' };
      
      // Case-insensitive equals
      expect(evaluateCondition({ var: 'status', equals: 'active' }, context)).toBe(true);
      expect(evaluateCondition({ var: 'status', equals: 'ACTIVE' }, context)).toBe(true);
      expect(evaluateCondition({ var: 'status', equals: 'inactive' }, context)).toBe(false);
      
      // Whitespace trimming
      expect(evaluateCondition({ var: 'mode', equals: 'production' }, context)).toBe(true);
      expect(evaluateCondition({ var: 'mode', equals: 'PRODUCTION' }, context)).toBe(true);
    });

    it('should perform type coercion for compatible types', () => {
      const context = { 
        stringNumber: '42',
        actualNumber: 42,
        stringBoolean: 'true',
        actualBoolean: true,
        stringFalse: 'false',
        zeroString: '0'
      };
      
      // String-number coercion
      expect(evaluateCondition({ var: 'stringNumber', equals: 42 }, context)).toBe(true);
      expect(evaluateCondition({ var: 'actualNumber', equals: '42' }, context)).toBe(true);
      expect(evaluateCondition({ var: 'stringNumber', equals: 41 }, context)).toBe(false);
      
      // String-boolean coercion
      expect(evaluateCondition({ var: 'stringBoolean', equals: true }, context)).toBe(true);
      expect(evaluateCondition({ var: 'stringFalse', equals: false }, context)).toBe(true);
      expect(evaluateCondition({ var: 'zeroString', equals: false }, context)).toBe(true);
    });

    it('should handle null and undefined equivalence', () => {
      const context = { nullValue: null, undefinedValue: undefined, emptyString: '' };
      
      expect(evaluateCondition({ var: 'nullValue', equals: null }, context)).toBe(true);
      expect(evaluateCondition({ var: 'nullValue', equals: undefined }, context)).toBe(true);
      expect(evaluateCondition({ var: 'undefinedValue', equals: null }, context)).toBe(true);
      expect(evaluateCondition({ var: 'emptyString', equals: null }, context)).toBe(false);
    });

    it('should evaluate string matching operators', () => {
      const context = { 
        description: '  This is a Test Description  ',
        filename: 'example.json',
        status: 'IN_PROGRESS'
      };
      
      // Contains (case-insensitive)
      expect(evaluateCondition({ var: 'description', contains: 'test' }, context)).toBe(true);
      expect(evaluateCondition({ var: 'description', contains: 'TEST' }, context)).toBe(true);
      expect(evaluateCondition({ var: 'description', contains: 'missing' }, context)).toBe(false);
      
      // StartsWith (case-insensitive, trimmed)
      expect(evaluateCondition({ var: 'description', startsWith: 'this' }, context)).toBe(true);
      expect(evaluateCondition({ var: 'description', startsWith: 'THIS IS' }, context)).toBe(true);
      expect(evaluateCondition({ var: 'description', startsWith: 'description' }, context)).toBe(false);
      
      // EndsWith (case-insensitive, trimmed)
      expect(evaluateCondition({ var: 'description', endsWith: 'description' }, context)).toBe(true);
      expect(evaluateCondition({ var: 'description', endsWith: 'DESCRIPTION' }, context)).toBe(true);
      expect(evaluateCondition({ var: 'filename', endsWith: '.json' }, context)).toBe(true);
      expect(evaluateCondition({ var: 'filename', endsWith: '.txt' }, context)).toBe(false);
      
      // Regex matches (case-insensitive by default)
      expect(evaluateCondition({ var: 'status', matches: '^in_.*' }, context)).toBe(true);
      expect(evaluateCondition({ var: 'filename', matches: '\\.(json|txt)$' }, context)).toBe(true);
      expect(evaluateCondition({ var: 'description', matches: 'test.*description' }, context)).toBe(true);
      expect(evaluateCondition({ var: 'status', matches: '^completed' }, context)).toBe(false);
    });

    it('should handle invalid regex patterns safely', () => {
      const context = { value: 'test' };
      
      // Invalid regex should return false
      expect(evaluateCondition({ var: 'value', matches: '[invalid' }, context)).toBe(false);
      expect(evaluateCondition({ var: 'value', matches: '*invalid' }, context)).toBe(false);
    });
  });

  describe('validateCondition', () => {
    it('should accept valid conditions', () => {
      expect(() => validateCondition({ var: 'test', equals: 'value' })).not.toThrow();
      expect(() => validateCondition({ and: [{ var: 'a', equals: 1 }] })).not.toThrow();
      expect(() => validateCondition({ or: [{ var: 'a', gt: 0 }, { var: 'b', lt: 10 }] })).not.toThrow();
    });

    it('should accept new string matching operators', () => {
      expect(() => validateCondition({ var: 'test', contains: 'value' })).not.toThrow();
      expect(() => validateCondition({ var: 'test', startsWith: 'prefix' })).not.toThrow();
      expect(() => validateCondition({ var: 'test', endsWith: 'suffix' })).not.toThrow();
      expect(() => validateCondition({ var: 'test', matches: '^pattern.*' })).not.toThrow();
    });

    it('should reject invalid operators', () => {
      expect(() => validateCondition({ var: 'test', invalid: 'operator' })).toThrow('Unsupported condition operators: invalid');
      expect(() => validateCondition({ badOperator: 'value' })).toThrow('Unsupported condition operators: badOperator');
    });

    it('should validate nested conditions', () => {
      expect(() => validateCondition({
        and: [
          { var: 'a', equals: 1 },
          { or: [{ var: 'b', gt: 0 }, { var: 'c', lt: 10 }] }
        ]
      })).not.toThrow();
      
      expect(() => validateCondition({
        and: [
          { var: 'a', equals: 1 },
          { invalid: 'nested' }
        ]
      })).toThrow('Unsupported condition operators: invalid');
    });
  });
}); 