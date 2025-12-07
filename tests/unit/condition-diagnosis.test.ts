/**
 * Tests for condition diagnosis functions.
 * 
 * CRITICAL: These tests verify that diagnosis matches evaluateCondition() behavior,
 * which uses lenient comparison (case-insensitive, type-coercive).
 */

import { describe, it, expect } from 'vitest';
import { diagnoseConditionFailure } from '../../src/utils/condition-analysis/diagnosis';
import { Condition } from '../../src/utils/condition-evaluator';
import { ConditionDiagnosis } from '../../src/utils/condition-analysis/types';

describe('diagnoseConditionFailure', () => {
  describe('missing variable scenarios', () => {
    it('should diagnose missing variable with equals operator', () => {
      const condition: Condition = { var: 'mode', equals: 'active' };
      const context = {};
      
      const result = diagnoseConditionFailure(condition, context);
      
      expect(result).toMatchObject({
        type: 'missing-variable',
        variable: 'mode',
        operator: 'equals'
      });
      expect((result as any).expectedValues).toContain('"active"');
    });
    
    it('should diagnose missing variable with gt operator', () => {
      const condition: Condition = { var: 'count', gt: 5 };
      const context = {};
      
      const result = diagnoseConditionFailure(condition, context);
      
      expect(result.type).toBe('missing-variable');
      expect((result as any).variable).toBe('count');
      expect((result as any).operator).toBe('gt');
      expect((result as any).expectedValues[0]).toContain('5');
    });
    
    it('should treat null as missing', () => {
      const condition: Condition = { var: 'value', equals: 'test' };
      const context = { value: null };
      
      const result = diagnoseConditionFailure(condition, context);
      
      expect(result.type).toBe('missing-variable');
    });
    
    it('should treat undefined as missing', () => {
      const condition: Condition = { var: 'value', equals: 'test' };
      const context = { value: undefined };
      
      const result = diagnoseConditionFailure(condition, context);
      
      expect(result.type).toBe('missing-variable');
    });
  });
  
  describe('lenient comparison behavior', () => {
    it('should NOT diagnose case-only differences (lenient equals)', () => {
      // CRITICAL: lenientEquals is case-insensitive
      // So "Small" equals "small" - condition PASSES
      // This should return 'match' not 'wrong-value'
      const condition: Condition = { var: 'taskComplexity', equals: 'Large' };
      const context = { taskComplexity: 'large' };
      
      const result = diagnoseConditionFailure(condition, context);
      
      // Should be 'match' because lenient comparison passes
      expect(result.type).toBe('match');
    });
    
    it('should NOT diagnose type coercion differences (string to number)', () => {
      // CRITICAL: lenientEquals coerces "10" to 10
      const condition: Condition = { var: 'count', equals: 10 };
      const context = { count: '10' };
      
      const result = diagnoseConditionFailure(condition, context);
      
      // Should be 'match' because coercion makes them equal
      expect(result.type).toBe('match');
    });
    
    it('should NOT diagnose boolean coercion differences', () => {
      const condition: Condition = { var: 'enabled', equals: true };
      const context = { enabled: 'yes' };
      
      const result = diagnoseConditionFailure(condition, context);
      
      // Should be 'match' because 'yes' coerces to true
      expect(result.type).toBe('match');
    });
    
    it('should diagnose actual value differences', () => {
      const condition: Condition = { var: 'status', equals: 'ready' };
      const context = { status: 'pending' };
      
      const result = diagnoseConditionFailure(condition, context);
      
      expect(result).toMatchObject({
        type: 'wrong-value',
        variable: 'status',
        expected: 'ready',
        current: 'pending',
        operator: 'equals'
      });
    });
  });
  
  describe('numeric comparisons', () => {
    it('should diagnose wrong type for gt operator', () => {
      const condition: Condition = { var: 'count', gt: 5 };
      const context = { count: 'not-a-number' };
      
      const result = diagnoseConditionFailure(condition, context);
      
      expect(result).toMatchObject({
        type: 'wrong-type',
        variable: 'count',
        expectedType: 'number',
        currentType: 'string',
        operator: 'gt'
      });
    });
    
    it('should diagnose failed gt comparison', () => {
      const condition: Condition = { var: 'count', gt: 10 };
      const context = { count: 5 };
      
      const result = diagnoseConditionFailure(condition, context);
      
      expect(result.type).toBe('wrong-value');
      expect((result as any).operator).toBe('gt');
      expect((result as any).current).toBe(5);
      expect((result as any).expected).toContain('> 10');
    });
    
    it('should handle gte, lt, lte operators', () => {
      expect(diagnoseConditionFailure({ var: 'x', gte: 10 }, { x: 5 }).type).toBe('wrong-value');
      expect(diagnoseConditionFailure({ var: 'x', lt: 10 }, { x: 15 }).type).toBe('wrong-value');
      expect(diagnoseConditionFailure({ var: 'x', lte: 10 }, { x: 15 }).type).toBe('wrong-value');
    });
  });
  
  describe('string operators', () => {
    it('should diagnose failed contains check', () => {
      const condition: Condition = { var: 'text', contains: 'hello' };
      const context = { text: 'goodbye world' };
      
      const result = diagnoseConditionFailure(condition, context);
      
      expect(result.type).toBe('wrong-value');
      expect((result as any).operator).toBe('contains');
    });
    
    it('should diagnose failed startsWith check', () => {
      const condition: Condition = { var: 'text', startsWith: 'hello' };
      const context = { text: 'goodbye' };
      
      const result = diagnoseConditionFailure(condition, context);
      
      expect(result.type).toBe('wrong-value');
      expect((result as any).operator).toBe('startsWith');
    });
  });
  
  describe('truthy check', () => {
    it('should diagnose failed truthy check', () => {
      const condition: Condition = { var: 'enabled' };
      const context = { enabled: false };
      
      const result = diagnoseConditionFailure(condition, context);
      
      expect(result.type).toBe('wrong-value');
      expect((result as any).operator).toBe('truthy');
      expect((result as any).expected).toContain('truthy');
    });
    
    it('should diagnose truthy check with 0', () => {
      const condition: Condition = { var: 'count' };
      const context = { count: 0 };
      
      const result = diagnoseConditionFailure(condition, context);
      
      expect(result.type).toBe('wrong-value');
      expect((result as any).current).toBe(0);
    });
  });
  
  describe('AND composition', () => {
    it('should diagnose all failures in AND', () => {
      const condition: Condition = {
        and: [
          { var: 'mode', equals: 'active' },
          { var: 'level', equals: 'high' }
        ]
      };
      const context = { mode: 'inactive', level: 'low' };
      
      const result = diagnoseConditionFailure(condition, context);
      
      expect(result.type).toBe('and-composition');
      const andResult = result as any;
      expect(andResult.failures).toHaveLength(2);
      expect(andResult.totalConditions).toBe(2);
      expect(andResult.description).toContain('All 2 conditions must be true');
    });
    
    it('should only list failed sub-conditions', () => {
      const condition: Condition = {
        and: [
          { var: 'mode', equals: 'active' },
          { var: 'level', equals: 'high' }
        ]
      };
      const context = { mode: 'active', level: 'low' };  // mode passes
      
      const result = diagnoseConditionFailure(condition, context);
      
      expect(result.type).toBe('and-composition');
      const andResult = result as any;
      expect(andResult.failures).toHaveLength(1);  // Only level failed
      expect(andResult.failures[0].variable).toBe('level');
    });
    
    it('should handle nested AND conditions', () => {
      const condition: Condition = {
        and: [
          { var: 'a', equals: 1 },
          {
            and: [
              { var: 'b', equals: 2 },
              { var: 'c', equals: 3 }
            ]
          }
        ]
      };
      const context = { a: 1, b: 2, c: 99 };  // Only c fails
      
      const result = diagnoseConditionFailure(condition, context);
      
      expect(result.type).toBe('and-composition');
      const andResult = result as any;
      // Should have 1 failure (the nested AND with c failing)
      expect(andResult.failures.length).toBeGreaterThan(0);
    });
  });
  
  describe('OR composition', () => {
    it('should diagnose all options when all fail', () => {
      const condition: Condition = {
        or: [
          { var: 'mode', equals: 'A' },
          { var: 'mode', equals: 'B' },
          { var: 'mode', equals: 'C' }
        ]
      };
      const context = { mode: 'D' };
      
      const result = diagnoseConditionFailure(condition, context);
      
      expect(result.type).toBe('or-composition');
      const orResult = result as any;
      expect(orResult.failures).toHaveLength(3);
      expect(orResult.totalOptions).toBe(3);
      expect(orResult.description).toContain('At least one');
    });
    
    it('should handle real workflow OR condition', () => {
      // From coding-task-workflow-with-loops.json
      const condition: Condition = {
        or: [
          { var: 'taskComplexity', equals: 'Large' },
          {
            and: [
              { var: 'taskComplexity', equals: 'Medium' },
              { var: 'requestDeepAnalysis', equals: true }
            ]
          }
        ]
      };
      const context = { taskComplexity: 'Small' };
      
      const result = diagnoseConditionFailure(condition, context);
      
      expect(result.type).toBe('or-composition');
      const orResult = result as any;
      expect(orResult.failures).toHaveLength(2);
      // First failure: taskComplexity != 'Large'
      expect(orResult.failures[0].type).toBe('wrong-value');
      // Second failure: AND composition
      expect(orResult.failures[1].type).toBe('and-composition');
    });
  });
  
  describe('NOT composition', () => {
    it('should diagnose when negated condition is true', () => {
      const condition: Condition = {
        not: { var: 'disabled', equals: true }
      };
      const context = { disabled: true };
      
      const result = diagnoseConditionFailure(condition, context);
      
      expect(result.type).toBe('not-composition');
      const notResult = result as any;
      expect(notResult.description).toContain('should be false');
    });
    
    it('should diagnose complex NOT condition', () => {
      const condition: Condition = {
        not: {
          and: [
            { var: 'a', equals: 1 },
            { var: 'b', equals: 2 }
          ]
        }
      };
      const context = { a: 1, b: 2 };  // Both pass, so NOT fails
      
      const result = diagnoseConditionFailure(condition, context);
      
      expect(result.type).toBe('not-composition');
    });
  });
  
  describe('not_equals operator', () => {
    it('should diagnose when value equals what it should not', () => {
      const condition: Condition = { var: 'taskComplexity', not_equals: 'Small' };
      const context = { taskComplexity: 'Small' };
      
      const result = diagnoseConditionFailure(condition, context);
      
      expect(result.type).toBe('wrong-value');
      expect((result as any).operator).toBe('not_equals');
      expect((result as any).current).toBe('Small');
    });
    
    it('should use lenient comparison for not_equals', () => {
      // "small" should equal "Small" under lenient comparison
      // So condition { not_equals: "Small" } with context { x: "small" } should FAIL
      const condition: Condition = { var: 'x', not_equals: 'Small' };
      const context = { x: 'small' };
      
      const result = diagnoseConditionFailure(condition, context);
      
      expect(result.type).toBe('wrong-value');
    });
  });
  
  describe('edge cases', () => {
    it('should handle empty string vs undefined', () => {
      const condition: Condition = { var: 'text', equals: 'hello' };
      const context = { text: '' };
      
      const result = diagnoseConditionFailure(condition, context);
      
      // Empty string is NOT undefined - it's a wrong value
      expect(result.type).toBe('wrong-value');
      expect((result as any).current).toBe('');
    });
    
    it('should handle condition with only var (truthy check)', () => {
      const condition: Condition = { var: 'flag' };
      const context = { flag: 0 };
      
      const result = diagnoseConditionFailure(condition, context);
      
      expect(result.type).toBe('wrong-value');
      expect((result as any).operator).toBe('truthy');
    });
    
    it('should handle multiple operators on same variable', () => {
      const condition: Condition = { var: 'count', gt: 5, lt: 10 };
      const context = { count: 3 };
      
      // Should check gt first (order matters)
      const result = diagnoseConditionFailure(condition, context);
      
      expect(result.type).toBe('wrong-value');
      expect((result as any).operator).toBe('gt');
    });
  });
  
  describe('type coercion scenarios', () => {
    it('should allow string-to-number coercion', () => {
      const condition: Condition = { var: 'count', equals: 10 };
      const context = { count: '10' };
      
      const result = diagnoseConditionFailure(condition, context);
      
      // lenientEquals coerces, so this should match
      expect(result.type).toBe('match');
    });
    
    it('should allow boolean coercion for "true"', () => {
      const condition: Condition = { var: 'enabled', equals: true };
      const context = { enabled: 'true' };
      
      const result = diagnoseConditionFailure(condition, context);
      
      expect(result.type).toBe('match');
    });
    
    it('should allow boolean coercion for "yes"', () => {
      const condition: Condition = { var: 'enabled', equals: true };
      const context = { enabled: 'yes' };
      
      const result = diagnoseConditionFailure(condition, context);
      
      expect(result.type).toBe('match');
    });
    
    it('should allow boolean coercion for "1"', () => {
      const condition: Condition = { var: 'enabled', equals: true };
      const context = { enabled: '1' };
      
      const result = diagnoseConditionFailure(condition, context);
      
      expect(result.type).toBe('match');
    });
  });
  
  describe('real workflow conditions', () => {
    it('should diagnose coding-task-workflow triage condition', () => {
      // Real condition from phase-small-prep
      const condition: Condition = { var: 'taskComplexity', equals: 'Small' };
      
      // Agent set wrong value
      const context = { taskComplexity: 'Medium' };
      
      const result = diagnoseConditionFailure(condition, context);
      
      expect(result.type).toBe('wrong-value');
      expect((result as any).expected).toBe('Small');
      expect((result as any).current).toBe('Medium');
    });
    
    it('should diagnose complex OR from phase-1-multi-analysis', () => {
      const condition: Condition = {
        or: [
          { var: 'taskComplexity', equals: 'Large' },
          {
            and: [
              { var: 'taskComplexity', equals: 'Medium' },
              { var: 'requestDeepAnalysis', equals: true }
            ]
          }
        ]
      };
      
      const context = { taskComplexity: 'Small' };
      
      const result = diagnoseConditionFailure(condition, context);
      
      expect(result.type).toBe('or-composition');
      const orResult = result as any;
      expect(orResult.failures).toHaveLength(2);
    });
    
    it('should handle requireConfirmation condition', () => {
      const condition: Condition = {
        or: [
          { var: 'automationLevel', equals: 'Low' },
          { var: 'automationLevel', equals: 'Medium' }
        ]
      };
      
      const context = { automationLevel: 'High' };
      
      const result = diagnoseConditionFailure(condition, context);
      
      expect(result.type).toBe('or-composition');
    });
  });
});
